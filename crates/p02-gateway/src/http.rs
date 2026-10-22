//! The socket's rules and its routes. Every `/api` request passes, in
//! order, the stopping check, the loopback check and the bearer token, and
//! its body the cap as it is read; each route answers its verb's outcome
//! verbatim under 200, the status describing the transport and the body
//! what happened; and every transport refusal is the one envelope
//! `{"error":{"code","message"}}`.

use std::fmt;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::rejection::{BytesRejection, FailedToBufferBody, PathRejection};
use axum::extract::{DefaultBodyLimit, Extension, Path, RawQuery, Request, State};
use axum::http::header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, HOST, ORIGIN};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use p02_app::{Answer, Daemon, HistoryPage, Message};
use p02_config::{ConfigChange, ConfigTarget, Connector, connectors};
use p02_core::ClientStamp;
use p02_shared::DaemonToken;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq as _;
use tokio_util::sync::CancellationToken;

use crate::events::{Streams, Unopened};
use crate::page::Page;

/// A message is a few KiB; a body past this is not a message.
const BODY_LIMIT: usize = 64 * 1024;
/// The longest text a request carries, a line, in characters, so a line
/// in any script is held to the same length: well above any line a person
/// types, and well below the body cap.
const TEXT_LIMIT: usize = 16 * 1024;
/// The bound of an id, and of the name a person goes by.
const NAME_LIMIT: usize = 128;

/// The host names a request may give: a page of another origin cannot make
/// a browser name this host, which defends the daemon against DNS
/// rebinding.
const LOOPBACK: [&str; 2] = ["127.0.0.1", "localhost"];

/// What the routes reach: the daemon, the token a request presents, whether
/// the stop began, the event streams and the page.
#[derive(Clone)]
pub(crate) struct App(Arc<Shared>);

struct Shared {
    daemon: Daemon,
    /// The token's SHA-256, so the comparison takes one time whatever a
    /// request presents, its length included.
    token: [u8; 32],
    stopping: CancellationToken,
    streams: Streams,
    page: Page,
}

impl App {
    pub(crate) fn new(
        daemon: Daemon,
        token: &DaemonToken,
        stopping: CancellationToken,
        streams: Streams,
        page: Page,
    ) -> Self {
        Self(Arc::new(Shared {
            daemon,
            token: Sha256::digest(token.as_str()).into(),
            stopping,
            streams,
            page,
        }))
    }

    /// The transport's rules, in their order, for a request to the API.
    fn admit(&self, headers: &HeaderMap) -> Result<(), Refusal> {
        if self.0.stopping.is_cancelled() {
            return Err(Refusal::stopping());
        }

        let host = headers
            .get(HOST)
            .map_or_else(String::new, |host| text(host).into_owned());

        if !LOOPBACK.contains(&hostname(&host)) {
            return Err(Refusal::new(
                StatusCode::MISDIRECTED_REQUEST,
                "misdirected_host",
                format!("Host \"{host}\" is not this daemon; it answers on 127.0.0.1."),
            ));
        }

        if let Some(origin) = headers.get(ORIGIN)
            && origin.as_bytes() != format!("http://{host}").as_bytes()
        {
            return Err(Refusal::new(
                StatusCode::FORBIDDEN,
                "forbidden_origin",
                format!("Origin \"{}\" is not this daemon's page.", text(origin)),
            ));
        }

        match headers.get(AUTHORIZATION).map(bearer) {
            None => return Err(Refusal::unauthorized()),
            Some(None) => return Err(Refusal::unreadable()),
            Some(Some(token)) => {
                let presented: [u8; 32] = Sha256::digest(token).into();

                if !bool::from(presented.ct_eq(&self.0.token)) {
                    return Err(Refusal::unauthorized());
                }
            }
        }

        Ok(())
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
pub(crate) struct Refusal {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl Refusal {
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

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        (
            self.status,
            [(CONTENT_TYPE, "application/json")],
            json!({"error": {"code": self.code, "message": self.message}}).to_string(),
        )
            .into_response()
    }
}

impl fmt::Debug for Refusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Refusal")
            .field("status", &self.status)
            .field("code", &self.code)
            .finish_non_exhaustive()
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
async fn fallback(State(app): State<App>, method: Method, uri: Uri) -> Response {
    let path = uri.path();

    if is_api(path) {
        Refusal::new(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("No API route at {path}."),
        )
        .into_response()
    } else {
        app.0.page.answer(&method, path)
    }
}

async fn health(State(app): State<App>) -> Response {
    answer(&app.0.daemon.health().await)
}

async fn start(State(app): State<App>, id: Result<Path<String>, PathRejection>) -> Response {
    match id {
        Ok(Path(id)) => answer(&app.0.daemon.start_character(&id).await),
        Err(rejection) => unread_path(&rejection),
    }
}

async fn open(
    State(app): State<App>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    match read::<OpenRequest>("The open request", &headers, body) {
        Ok(OpenRequest { character_id }) => {
            answer(&app.0.daemon.open_conversation(&character_id.0).await)
        }
        Err(refusal) => refusal.into_response(),
    }
}

async fn turn(
    State(app): State<App>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    match read::<TurnRequest>("The message", &headers, body) {
        Ok(line) => answer(
            &app.0
                .daemon
                .deliver(Message {
                    conversation_id: line.conversation_id.0,
                    sender_id: line.sender_id.0,
                    text: line.text.0,
                    source: line.source.to_string(),
                    client_message_id: line.client_message_id.to_string(),
                })
                .await,
        ),
        Err(refusal) => refusal.into_response(),
    }
}

async fn history(
    State(app): State<App>,
    id: Result<Path<String>, PathRejection>,
    RawQuery(query): RawQuery,
) -> Response {
    let id = match id {
        Ok(Path(id)) => id,
        Err(rejection) => return unread_path(&rejection),
    };
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
    id: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let id = match id {
        Ok(Path(id)) => id,
        Err(rejection) => return unread_path(&rejection),
    };

    match read::<Decided>("The answer", &headers, body) {
        Ok(Decided { decision }) => answer(&app.0.daemon.answer_confirmation(&id, decision)),
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
            return Refusal::invalid(
                "A config target is ?scope=global or ?scope=character&characterId=<id>.".to_owned(),
            )
            .into_response();
        }
    };

    answer(&app.0.daemon.config_view(target).await)
}

async fn config_change(
    State(app): State<App>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    match read::<ConfigChange>("The config change", &headers, body) {
        Ok(change) => answer(&app.0.daemon.apply_change(change).await),
        Err(refusal) => refusal.into_response(),
    }
}

async fn connector_config(
    State(app): State<App>,
    id: Result<Path<String>, PathRejection>,
) -> Response {
    match id {
        Ok(Path(id)) => answer(&app.0.daemon.connector_config(&id).await),
        Err(rejection) => unread_path(&rejection),
    }
}

async fn request_pairing(
    State(app): State<App>,
    id: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let connector = match id {
        Ok(Path(id)) => id,
        Err(rejection) => return unread_path(&rejection),
    };

    match read::<PairingRequest>("The pairing request", &headers, body) {
        Ok(PairingRequest { subject }) => answer(
            &app.0
                .daemon
                .request_pairing(&connector, subject.id, &subject.label.0)
                .await,
        ),
        Err(refusal) => refusal.into_response(),
    }
}

async fn pairings(State(app): State<App>) -> Response {
    answer(&app.0.daemon.pending_pairings())
}

async fn settle_pairing(
    State(app): State<App>,
    code: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let code = match code {
        Ok(Path(code)) => code,
        Err(rejection) => return unread_path(&rejection),
    };

    match read::<Decided>("The answer", &headers, body) {
        Ok(Decided { decision }) => answer(&app.0.daemon.settle_pairing(&code, decision).await),
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
        Some(Err(refusal)) => return refusal.into_response(),
    };
    let last_event_id = headers.get("last-event-id").and_then(|id| id.to_str().ok());

    match app.0.streams.open(last_event_id, connector, link).await {
        Ok(stream) => stream,
        Err(Unopened::Stopping) => Refusal::stopping().into_response(),
        Err(Unopened::Unformatted(error)) => internal(&error),
    }
}

/// The connector this build has under `id`.
fn connector(id: &str) -> Result<&'static Connector, Refusal> {
    connectors()
        .iter()
        .find(|connector| connector.id().as_str() == id)
        .ok_or_else(|| {
            let known: Vec<&str> = connectors()
                .iter()
                .map(|connector| connector.id().as_str())
                .collect();

            Refusal::invalid(format!("A connector is one of: {}.", known.join(", ")))
        })
}

/// A verb's outcome as the client reads it, under 200.
fn answer(outcome: &impl Serialize) -> Response {
    match serde_json::to_vec(outcome) {
        Ok(body) => ([(CONTENT_TYPE, "application/json")], body).into_response(),
        Err(error) => internal(&error),
    }
}

/// The answer to what the daemon itself got wrong: its own outcome would
/// not spell as JSON.
fn internal(error: &serde_json::Error) -> Response {
    Refusal::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        format!("The answer could not be written: {error}."),
    )
    .into_response()
}

/// The body of a request as `T`, `subject` naming the request in what a
/// refusal says: read within the cap, sent as JSON, each string value
/// within the bound of a text, and of `T`'s shape, which `T` judges as it
/// is read, so nothing validates it twice.
fn read<T: DeserializeOwned>(
    subject: &str,
    headers: &HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<T, Refusal> {
    let body = body.map_err(|rejection| match rejection {
        BytesRejection::FailedToBufferBody(FailedToBufferBody::LengthLimitError(_)) => {
            Refusal::too_large()
        }
        _ => Refusal::unreadable(),
    })?;

    if !sent_as_json(headers) {
        return Err(Refusal::invalid(format!(
            "{subject} must be sent as JSON, with the Content-Type application/json."
        )));
    }

    let json: Value = serde_json::from_slice(&body)
        .map_err(|error| Refusal::invalid(format!("{subject}: {error}.")))?;

    if let Some(path) = overlong(&json) {
        return Err(Refusal::invalid(format!(
            "{subject}{path} exceeds {TEXT_LIMIT} characters."
        )));
    }

    serde_path_to_error::deserialize(json).map_err(|error| {
        let path = error.path().to_string();
        let place = if path == "." {
            subject.to_owned()
        } else {
            format!("{subject}.{path}")
        };

        Refusal::invalid(format!("{place}: {}.", error.into_inner()))
    })
}

/// Where `json` first holds a string value longer than any text a
/// request carries, as a refusal names the place: `.key` into an object,
/// `[index]` into an array, and nothing for `json` itself.
fn overlong(json: &Value) -> Option<String> {
    match json {
        Value::String(text) => (text.chars().count() > TEXT_LIMIT).then(String::new),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .find_map(|(index, item)| overlong(item).map(|path| format!("[{index}]{path}"))),
        Value::Object(fields) => fields
            .iter()
            .find_map(|(key, field)| overlong(field).map(|path| format!(".{key}{path}"))),
        Value::Null | Value::Bool(_) | Value::Number(_) => None,
    }
}

/// Whether the body is declared JSON: `application/json`, or a type of it
/// such as `application/merge-patch+json`, parameters aside.
fn sent_as_json(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .and_then(|essence| {
            let essence = essence.trim();
            let (kind, subtype) = essence.split_once('/')?;

            Some(
                kind.eq_ignore_ascii_case("application")
                    && (subtype.eq_ignore_ascii_case("json")
                        || subtype.to_ascii_lowercase().ends_with("+json")),
            )
        })
        .unwrap_or(false)
}

fn unread_path(rejection: &PathRejection) -> Response {
    Refusal::invalid(format!(
        "The request's path could not be read: {}.",
        rejection.body_text()
    ))
    .into_response()
}

/// The first value of `name` in the query.
fn parameter(query: Option<&str>, name: &str) -> Option<String> {
    form_urlencoded::parse(query?.as_bytes())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// The host name a `Host` header gives: up to its port, or a bracketed IPv6
/// literal whole.
fn hostname(host: &str) -> &str {
    if host.starts_with('[') {
        host.find(']').map_or("", |end| &host[..=end])
    } else {
        host.split(':').next().unwrap_or_default()
    }
}

/// A header as a person reads it.
fn text(value: &HeaderValue) -> std::borrow::Cow<'_, str> {
    String::from_utf8_lossy(value.as_bytes())
}

/// The token an `Authorization` header presents, when it is the bearer
/// scheme, in any case, then spaces and one token of base64url or base64
/// with its padding; none when it is anything else.
fn bearer(value: &HeaderValue) -> Option<&[u8]> {
    let value = value.as_bytes();
    let (scheme, rest) = value.split_at_checked(6)?;

    if !scheme.eq_ignore_ascii_case(b"bearer") || rest.first() != Some(&b' ') {
        return None;
    }

    let token = rest.trim_ascii_start();
    let unpadded = token.len() - token.iter().rev().take_while(|byte| **byte == b'=').count();
    let (characters, _padding) = token.split_at(unpadded);
    let token_character = |byte: &u8| byte.is_ascii_alphanumeric() || b"._~+/-".contains(byte);

    (!characters.is_empty() && characters.iter().all(token_character)).then_some(token)
}

fn is_api(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

/// A string of 1 to 128 characters, as an id is on the wire, and the name
/// an account goes by.
struct Short(String);

impl<'de> serde::Deserialize<'de> for Short {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;

        if (1..=NAME_LIMIT).contains(&text.chars().count()) {
            Ok(Self(text))
        } else {
            Err(serde::de::Error::custom(
                "an id or a name is 1 to 128 characters",
            ))
        }
    }
}

/// A line's text: at least one character, and as long as any text of a
/// body may be.
struct Text(String);

impl<'de> serde::Deserialize<'de> for Text {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;

        if text.is_empty() {
            Err(serde::de::Error::custom(
                "a line's text is at least one character",
            ))
        } else {
            Ok(Self(text))
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenRequest {
    character_id: Short,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TurnRequest {
    conversation_id: Short,
    sender_id: Short,
    text: Text,
    source: ClientStamp,
    client_message_id: ClientStamp,
}

/// The person's answer, to a confirmation or a pairing request alike.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Decided {
    decision: Answer,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PairingRequest {
    subject: Subject,
}

/// The account a pairing is for: its id a stamp, and its name within the
/// bound of a name a person goes by, which the daemon judges further.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Subject {
    id: ClientStamp,
    label: Short,
}
