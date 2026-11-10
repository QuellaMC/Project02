//! The socket's rules and its routes. Every `/api` request passes, in
//! order, the stopping check, the loopback check and the bearer token, and
//! its body the cap as it is read; each route answers its verb's outcome
//! verbatim under 200, the status describing the transport and the body
//! what happened; and every transport refusal is the one envelope
//! `{"error":{"code","message"}}`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::rejection::{BytesRejection, FailedToBufferBody};
use axum::extract::{DefaultBodyLimit, Extension, Path, RawQuery, Request, State};
use axum::http::header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, HOST, ORIGIN};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use p02_app::{Daemon, HistoryPage, Message};
use p02_config::connector;
use p02_core::SpeakerName;
use p02_shared::DaemonToken;
use p02_wire::{
    AnswerBody, ConfigChange, ConfigTarget, ConnectorBotsBody, ErrorBody, GatewayMessage,
    OpenConversationBody, PairingRequestBody, Refusal,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq as _;
use tokio_util::sync::CancellationToken;

use crate::events::Streams;
use crate::page;

/// A message is a few KiB; a body past this is not a message.
const BODY_LIMIT: usize = 64 * 1024;

/// The host names a request may give: a page of another origin cannot make
/// a browser name this host, which defends the daemon against DNS
/// rebinding.
const LOOPBACK: [&str; 2] = ["127.0.0.1", "localhost"];

/// What the routes reach: the daemon, the token a request presents, whether
/// the stop began, and the event streams.
#[derive(Clone)]
pub(crate) struct App(Arc<Shared>);

struct Shared {
    daemon: Daemon,
    /// The token's SHA-256, so the comparison takes one time whatever a
    /// request presents, its length included.
    token: [u8; 32],
    stopping: CancellationToken,
    streams: Streams,
}

impl App {
    pub(crate) fn new(
        daemon: Daemon,
        token: &DaemonToken,
        stopping: CancellationToken,
        streams: Streams,
    ) -> Self {
        Self(Arc::new(Shared {
            daemon,
            token: Sha256::digest(token.as_str()).into(),
            stopping,
            streams,
        }))
    }

    /// The transport's rules, in their order, for a request to the API.
    fn admit(&self, headers: &HeaderMap) -> Result<(), Refused> {
        if self.0.stopping.is_cancelled() {
            return Err(Refused::stopping());
        }

        let host = headers
            .get(HOST)
            .map_or_else(String::new, |host| text(host).into_owned());

        if !LOOPBACK.contains(&hostname(&host)) {
            return Err(Refused::new(
                StatusCode::MISDIRECTED_REQUEST,
                "misdirected_host",
                format!("Host \"{host}\" is not this daemon; it answers on 127.0.0.1."),
            ));
        }

        if let Some(origin) = headers.get(ORIGIN)
            && origin.as_bytes() != format!("http://{host}").as_bytes()
        {
            return Err(Refused::new(
                StatusCode::FORBIDDEN,
                "forbidden_origin",
                format!("Origin \"{}\" is not this daemon's page.", text(origin)),
            ));
        }

        let presented: Option<[u8; 32]> = headers
            .get(AUTHORIZATION)
            .and_then(|value| bearer(value.as_bytes()))
            .map(|token| Sha256::digest(token).into());

        match presented {
            Some(presented) if bool::from(presented.ct_eq(&self.0.token)) => Ok(()),
            _ => Err(Refused::unauthorized()),
        }
    }
}

/// The socket's one router: the API, its rules, and the page behind it.
pub(crate) fn router(app: App) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/characters/{id}/start", post(start))
        .route("/api/conversations/open", post(open))
        .route("/api/turns", post(turn))
        .route("/api/conversations/{id}/messages", get(history))
        .route("/api/confirmations", get(confirmations))
        .route("/api/confirmations/{id}", post(answer_confirmation))
        .route("/api/config", get(config_view).post(config_change))
        .route("/api/connectors/{id}/config", get(connector_config))
        .route("/api/connectors/{id}/pairing", post(request_pairing))
        .route("/api/connectors/{id}/bots", post(connector_bots))
        .route("/api/pairing", get(pairings))
        .route("/api/pairing/{code}", post(settle_pairing))
        .route("/api/events", get(events))
        .fallback(fallback)
        .method_not_allowed_fallback(fallback)
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}

/// The connection a request came on, which its stream closes when the
/// client stops taking what it is sent.
#[derive(Clone, Debug)]
pub(crate) struct Link(pub(crate) CancellationToken);

/// A transport refusal: its status, and the envelope's code and sentence.
#[derive(Debug)]
pub(crate) struct Refused {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl Refused {
    pub(crate) fn new(status: StatusCode, code: &'static str, message: String) -> Self {
        Self {
            status,
            code,
            message,
        }
    }

    fn stopping() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "The daemon is stopping.".to_owned(),
        )
    }

    fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "A bearer token is required.".to_owned(),
        )
    }

    fn unreadable() -> Self {
        Self::invalid("The request could not be read.".to_owned())
    }

    fn too_large() -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "The request body is too large.".to_owned(),
        )
    }

    fn invalid(message: String) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", message)
    }
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        let error = ErrorBody {
            error: Refusal {
                code: self.code.to_owned(),
                message: self.message,
            },
        };
        // Two strings always spell as JSON.
        let body = serde_json::to_vec(&error).unwrap_or_default();

        (self.status, [(CONTENT_TYPE, "application/json")], body).into_response()
    }
}

/// The API's rules before its routes; every answer of the API is never
/// cached. The page's files pass untouched.
async fn guard(State(app): State<App>, request: Request, next: Next) -> Response {
    if !is_api(request.uri().path()) {
        return next.run(request).await;
    }

    let mut response = match app.admit(request.headers()) {
        Ok(()) => next.run(request).await,
        Err(refusal) => refusal.into_response(),
    };

    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// An unknown route of the API, behind its rules, or else the page.
async fn fallback(method: Method, uri: Uri) -> Response {
    let path = uri.path();

    if is_api(path) {
        Refused::new(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("No API route at {path}."),
        )
        .into_response()
    } else {
        page::answer(&method, path)
    }
}

async fn health(State(app): State<App>) -> Response {
    answer(&app.0.daemon.health().await)
}

async fn start(State(app): State<App>, Path(id): Path<String>) -> Response {
    answer(&app.0.daemon.start_character(&id).await)
}

async fn open(State(app): State<App>, body: Result<Bytes, BytesRejection>) -> Response {
    match read::<OpenConversationBody>("The open request", body) {
        Ok(OpenConversationBody { character_id }) => {
            answer(&app.0.daemon.open_conversation(character_id.as_str()).await)
        }
        Err(refusal) => refusal.into_response(),
    }
}

async fn turn(State(app): State<App>, body: Result<Bytes, BytesRejection>) -> Response {
    match read::<GatewayMessage>("The message", body) {
        Ok(line) => answer(
            &app.0
                .daemon
                .deliver(Message {
                    conversation_id: line.conversation_id.into(),
                    text: line.text.into(),
                    source: line.source,
                    client_message_id: line.client_message_id,
                })
                .await,
        ),
        Err(refusal) => refusal.into_response(),
    }
}

async fn history(
    State(app): State<App>,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let page = HistoryPage {
        before: parameter(query.as_deref(), "before"),
        limit: parameter(query.as_deref(), "limit"),
    };

    answer(&app.0.daemon.history(&id, page).await)
}

async fn confirmations(State(app): State<App>) -> Response {
    answer(&app.0.daemon.pending_confirmations())
}

async fn answer_confirmation(
    State(app): State<App>,
    Path(id): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    match read::<AnswerBody>("The answer", body) {
        Ok(AnswerBody { decision }) => answer(&app.0.daemon.answer_confirmation(&id, decision)),
        Err(refusal) => refusal.into_response(),
    }
}

async fn config_view(State(app): State<App>, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let target = match (
        parameter(query, "scope").as_deref(),
        parameter(query, "characterId"),
    ) {
        (Some("global"), _) => ConfigTarget::Global,
        (Some("character"), Some(character_id)) => ConfigTarget::Character { character_id },
        _ => {
            return Refused::invalid(
                "A config target is ?scope=global or ?scope=character&characterId=<id>.".to_owned(),
            )
            .into_response();
        }
    };

    answer(&app.0.daemon.config_view(target).await)
}

async fn config_change(State(app): State<App>, body: Result<Bytes, BytesRejection>) -> Response {
    match read::<ConfigChange>("The config change", body) {
        Ok(change) => answer(&app.0.daemon.apply_change(change).await),
        Err(refusal) => refusal.into_response(),
    }
}

async fn connector_config(State(app): State<App>, Path(id): Path<String>) -> Response {
    answer(&app.0.daemon.connector_config(&id).await)
}

async fn request_pairing(
    State(app): State<App>,
    Path(connector): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let (subject, source) = match read::<PairingRequestBody>("The pairing request", body) {
        Ok(PairingRequestBody { subject, source }) => (subject, source),
        Err(refusal) => return refusal.into_response(),
    };
    let label = match SpeakerName::new(subject.label.as_str()) {
        Ok(label) => label,
        Err(error) => {
            return Refused::invalid(format!("The pairing request.subject.label: {error}."))
                .into_response();
        }
    };

    answer(
        &app.0
            .daemon
            .request_pairing(&connector, subject.id, label, source)
            .await,
    )
}

async fn connector_bots(
    State(app): State<App>,
    Path(connector): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    match read::<ConnectorBotsBody>("The bot table", body) {
        Ok(ConnectorBotsBody { bots }) => {
            answer(&app.0.daemon.connector_bots(&connector, bots).await)
        }
        Err(refusal) => refusal.into_response(),
    }
}

async fn pairings(State(app): State<App>) -> Response {
    answer(&app.0.daemon.pending_pairings())
}

async fn settle_pairing(
    State(app): State<App>,
    Path(code): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    match read::<AnswerBody>("The answer", body) {
        Ok(AnswerBody { decision }) => answer(&app.0.daemon.settle_pairing(&code, decision).await),
        Err(refusal) => refusal.into_response(),
    }
}

/// The event stream; a connector's own names it in the query, and is
/// present while it is open.
async fn events(
    State(app): State<App>,
    Extension(Link(link)): Extension<Link>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response {
    let connector = match parameter(query.as_deref(), "connector").map(|id| connector(&id)) {
        None => None,
        Some(Ok(connector)) => Some(connector),
        Some(Err(unknown)) => return Refused::invalid(unknown.to_string()).into_response(),
    };
    let last_event_id = headers.get("last-event-id").and_then(|id| id.to_str().ok());

    match app.0.streams.open(last_event_id, connector, link).await {
        Some(stream) => stream,
        None => Refused::stopping().into_response(),
    }
}

/// A verb's outcome as the client reads it, under 200.
fn answer(outcome: &impl Serialize) -> Response {
    let body =
        serde_json::to_vec(outcome).expect("an outcome holds no map with keys that are not text");

    ([(CONTENT_TYPE, "application/json")], body).into_response()
}

/// The body of a request as `T`, `subject` naming the request in what a
/// refusal says: read within the cap, as JSON, and of `T`'s shape, which
/// `T` judges as it is read, so nothing validates it twice.
fn read<T: DeserializeOwned>(
    subject: &str,
    body: Result<Bytes, BytesRejection>,
) -> Result<T, Refused> {
    let body = body.map_err(|rejection| match rejection {
        BytesRejection::FailedToBufferBody(FailedToBufferBody::LengthLimitError(_)) => {
            Refused::too_large()
        }
        _ => Refused::unreadable(),
    })?;

    // Read as JSON first, so that a refusal of its shape names no place in
    // the text, which a person reads as noise.
    serde_json::from_slice::<Value>(&body)
        .and_then(serde_json::from_value::<T>)
        .map_err(|error| Refused::invalid(format!("{subject}: {error}.")))
}

/// The first value of `name` in the query.
fn parameter(query: Option<&str>, name: &str) -> Option<String> {
    form_urlencoded::parse(query?.as_bytes())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// The host name a `Host` header gives, up to its port.
fn hostname(host: &str) -> &str {
    host.split_once(':').map_or(host, |(name, _)| name)
}

/// A header as a person reads it.
fn text(value: &HeaderValue) -> std::borrow::Cow<'_, str> {
    String::from_utf8_lossy(value.as_bytes())
}

/// The token an `Authorization` header presents in the bearer scheme, in
/// any case.
fn bearer(value: &[u8]) -> Option<&[u8]> {
    let (scheme, token) = value.split_at_checked(7)?;

    scheme
        .eq_ignore_ascii_case(b"bearer ")
        .then(|| token.trim_ascii())
}

fn is_api(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}
