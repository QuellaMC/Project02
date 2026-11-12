//! One exchange with a service's endpoint, whatever protocol it speaks:
//! how the request proves who sends it, the request, sent again after a
//! transport fault, the answer read under a bound on the provider's
//! silence, a streamed one to the event that ends it, and how a round that
//! got no answer failed, in the words the person is told.

use std::fmt;
use std::sync::OnceLock;
use std::time::Duration;

use p02_contracts::{ProviderAnswer, ProviderFailure};
use p02_shared::{credential_header, http_client};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Response, Url};
use serde_json::{Map, Value};
use tokio::time::Instant;

/// How long the provider may say nothing, before the headers or between
/// two chunks, unless the bound is shortened.
pub(crate) const PROVIDER_SILENCE: Duration = Duration::from_secs(30);

/// How many tokens an answer of the OpenAI API or the Claude API may take,
/// its reasoning among them: as much room as NVIDIA's models get to think,
/// and then to reply.
pub(crate) const MAX_OUTPUT_TOKENS: u32 = 32_768;

/// How long to wait before the second and the third attempt.
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(250), Duration::from_secs(1)];

/// What a ChatGPT plan whose usage is used up is said to say, after the
/// service's name.
const LIMIT_REACHED: &str = "says your plan's limit is reached; it resets later.";

/// Why an adapter cannot be built from its settings, in the words a
/// person reads where the settings page asks for them, naming the
/// service.
#[derive(Debug, thiserror::Error)]
pub enum BuildAdapterError {
    /// The service answers nothing without a key.
    #[error("add your {0} API key")]
    MissingKey(&'static str),
    #[error("paste your {0} API key again: it holds characters that cannot be sent")]
    Credential(&'static str),
    /// The service answers nothing until the home signs in to it.
    #[error("sign in to your {0}")]
    NotSignedIn(&'static str),
}

/// How a request proves who sends it: the headers it carries for that,
/// each credential among them marked sensitive, and the secrets no failure
/// repeats.
#[derive(Clone)]
pub(crate) struct Access {
    headers: HeaderMap,
    secrets: Vec<String>,
}

impl fmt::Debug for Access {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Access")
            .field("headers", &self.headers.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

impl Access {
    /// No proof at all: a server of one's own may ask for none.
    pub(crate) fn open() -> Self {
        Self {
            headers: HeaderMap::new(),
            secrets: Vec::new(),
        }
    }

    /// `key`, of `service`, as a bearer token, unless it holds what a
    /// header cannot carry.
    pub(crate) fn bearer(service: &'static str, key: &str) -> Result<Self, BuildAdapterError> {
        Self::open()
            .credential(AUTHORIZATION, &format!("Bearer {key}"), key)
            .ok_or(BuildAdapterError::Credential(service))
    }

    /// Carries `value` as `name` too, a credential in which `secret` is
    /// never repeated; none when `value` holds what a header cannot carry.
    pub(crate) fn credential(
        mut self,
        name: HeaderName,
        value: &str,
        secret: &str,
    ) -> Option<Self> {
        self.headers.insert(name, credential_header(value).ok()?);
        self.secrets.push(secret.to_owned());
        Some(self)
    }

    /// Carries `value` as `name` too, no secret.
    pub(crate) fn header(mut self, name: HeaderName, value: HeaderValue) -> Self {
        self.headers.insert(name, value);
        self
    }

    /// `message` without a secret, wherever a provider or a transport
    /// repeated one.
    fn redact(&self, message: String) -> String {
        self.secrets
            .iter()
            .filter(|secret| !secret.is_empty())
            .fold(message, |message, secret| {
                message.replace(secret.as_str(), "[redacted]")
            })
    }
}

/// What went wrong as the person is told it: the words of `service`, after
/// its name, and without a secret wherever the service or a transport
/// repeated one.
pub(crate) fn said(service: &str, access: &Access, what: &str) -> String {
    access.redact(format!("{service} {what}"))
}

/// The client a service's requests go by, made at the first, not with the
/// adapter: a character's settings are judged by building one whenever
/// they are read, and a client reads the system's certificates.
#[derive(Debug, Default)]
pub(crate) struct Client(OnceLock<reqwest::Client>);

impl Client {
    /// The client, made now if this is the first request; one that cannot
    /// be made fails the request as a connection that breaks does.
    pub(crate) fn get(&self) -> Result<&reqwest::Client, Failure> {
        if let Some(http) = self.0.get() {
            return Ok(http);
        }

        let made = http_client().build().map_err(Failure::Broken)?;

        Ok(self.0.get_or_init(|| made))
    }
}

/// How a round failed, as its record names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailureCode {
    HttpError,
    MalformedResponse,
    ProviderError,
    RequestTimeout,
}

impl FailureCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::HttpError => "http_error",
            Self::MalformedResponse => "malformed_response",
            Self::ProviderError => "provider_error",
            Self::RequestTimeout => "request_timeout",
        }
    }
}

/// What is no part of an answer in what a service streamed, or the
/// service's own error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StreamError {
    pub(crate) code: FailureCode,
    pub(crate) message: String,
}

/// A stream's part that is no part of an answer.
pub(crate) fn malformed(message: &str) -> StreamError {
    StreamError {
        code: FailureCode::MalformedResponse,
        message: message.to_owned(),
    }
}

/// A streamed event's data as the protocols that name their events send
/// it, Responses and Messages alike: its type, and the object that carries
/// it.
pub(crate) fn typed_event(data: &str) -> Result<(String, Map<String, Value>), StreamError> {
    let event =
        serde_json::from_str::<Value>(data).map_err(|_| malformed("stream event must be JSON."))?;
    let Value::Object(event) = event else {
        return Err(malformed("stream event must be an object."));
    };
    let kind = event
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| malformed("stream event must carry its type."))?
        .to_owned();

    Ok((kind, event))
}

/// How a round ended without an answer.
pub(crate) struct Fault {
    pub(crate) code: FailureCode,
    pub(crate) message: String,
    /// The status that answered, when one did.
    pub(crate) status: Option<u16>,
}

impl Fault {
    /// The round's failure, said as `service`'s on `access`.
    pub(crate) fn answer(&self, service: &str, access: &Access) -> ProviderAnswer {
        ProviderAnswer::Failed(ProviderFailure {
            code: self.code.as_str().to_owned(),
            message: said(service, access, &self.message),
            status: self.status,
        })
    }
}

impl From<Failure> for Fault {
    fn from(failure: Failure) -> Self {
        let code = match failure {
            Failure::TimedOut(_) => FailureCode::RequestTimeout,
            Failure::Broken(_) => FailureCode::ProviderError,
        };

        Self {
            code,
            message: failure.message(),
            status: None,
        }
    }
}

/// Bounds silence, not the exchange: the wait for the headers, then for
/// each next chunk, each within the window of the last thing the provider
/// sent. A reply of any length streams as long as bytes keep coming; a
/// provider that goes quiet fails one window after it last spoke.
#[derive(Debug)]
pub(crate) struct Silence {
    window: Duration,
    deadline: Instant,
}

impl Silence {
    pub(crate) fn start(window: Duration) -> Self {
        Self {
            window,
            deadline: Instant::now() + window,
        }
    }

    /// The provider just said something, or is asked anew after a wait that
    /// was none of its silence: the window starts again.
    pub(crate) fn touch(&mut self) {
        self.deadline = Instant::now() + self.window;
    }

    /// Runs `operation` until it finishes or the window closes, which drops
    /// it and so abandons the request.
    async fn wait<F: Future>(&self, operation: F) -> Result<F::Output, Failure> {
        tokio::time::timeout_at(self.deadline, operation)
            .await
            .map_err(|_| Failure::TimedOut(self.window))
    }
}

/// What ended an exchange before its answer could be read.
#[derive(Debug)]
pub(crate) enum Failure {
    /// The provider said nothing for a whole window.
    TimedOut(Duration),
    /// The connection failed or broke off.
    Broken(reqwest::Error),
}

impl Failure {
    /// The failure as the round and the person are told it, after the
    /// service's name.
    pub(crate) fn message(self) -> String {
        match self {
            Self::TimedOut(window) => {
                format!("provider request timed out after {}ms.", window.as_millis())
            }
            Self::Broken(error) => {
                let error = error.without_url();
                let mut cause: &dyn std::error::Error = &error;

                while let Some(source) = cause.source() {
                    cause = source;
                }

                format!("provider request failed: {cause}.")
            }
        }
    }
}

/// How the endpoint answered.
#[derive(Debug)]
pub(crate) enum Answer {
    /// A success status: the headers are in and the body is still to read.
    Accepted(Response),
    /// Any other status, after the last attempt it was worth, and whether
    /// it said a ChatGPT plan's usage is used up.
    Refused {
        status: u16,
        message: String,
        limit_reached: bool,
    },
}

impl Answer {
    /// The response whose body is still to read, or the refusal as the
    /// round's failure, in the provider's words under its status.
    pub(crate) fn accepted(self) -> Result<Response, Fault> {
        match self {
            Self::Accepted(response) => Ok(response),
            Self::Refused {
                status, message, ..
            } => Err(Fault {
                code: FailureCode::HttpError,
                message,
                status: Some(status),
            }),
        }
    }
}

/// Sends `body` with what `access` carries until an attempt is answered. A
/// transport fault, or a 408, a 429 or a 5xx, is tried again after a
/// pause, twice, but a plan's usage used up never is, nor a timeout.
/// Headers of any status are the provider speaking, so they restart the
/// window, and the pauses wait inside it.
pub(crate) async fn send(
    http: &reqwest::Client,
    endpoint: &Url,
    access: &Access,
    body: &[u8],
    silence: &mut Silence,
) -> Result<Answer, Failure> {
    let mut retries = RETRY_DELAYS.iter();

    loop {
        let retry = retries.next();
        let request = http
            .post(endpoint.clone())
            .header(CONTENT_TYPE, "application/json")
            .headers(access.headers.clone())
            .body(body.to_vec());
        let response = match silence.wait(request.send()).await? {
            Ok(response) => response,
            Err(error) => match retry {
                Some(delay) => {
                    silence.wait(tokio::time::sleep(*delay)).await?;
                    continue;
                }
                None => return Err(Failure::Broken(error)),
            },
        };

        silence.touch();

        let status = response.status();

        if status.is_success() {
            return Ok(Answer::Accepted(response));
        }

        let (message, limit_reached) = refusal(status.as_u16(), read_all(response, silence).await)?;
        let worth_again = !limit_reached
            && (status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error());

        match retry {
            Some(delay) if worth_again => silence.wait(tokio::time::sleep(*delay)).await?,
            _ => {
                return Ok(Answer::Refused {
                    status: status.as_u16(),
                    message,
                    limit_reached,
                });
            }
        }
    }
}

/// The next piece of the body, or none at its end, within the window,
/// which the piece restarts.
pub(crate) async fn next_chunk(
    response: &mut Response,
    silence: &mut Silence,
) -> Result<Option<Vec<u8>>, Failure> {
    let chunk = silence
        .wait(response.chunk())
        .await?
        .map_err(Failure::Broken)?;

    if chunk.is_some() {
        silence.touch();
    }

    Ok(chunk.map(|bytes| bytes.to_vec()))
}

/// A streamed answer read until `push`, handed each piece of it in turn,
/// says how it ended, or why it is no answer, under the status that
/// answered; a body that ends first ended before it finished.
pub(crate) async fn streamed<T>(
    mut response: Response,
    silence: &mut Silence,
    mut push: impl FnMut(&[u8]) -> Result<Option<T>, StreamError>,
) -> Result<T, Fault> {
    let status = response.status().as_u16();
    let refused = |code, message| Fault {
        code,
        message,
        status: Some(status),
    };

    while let Some(chunk) = next_chunk(&mut response, silence).await? {
        if let Some(ended) = push(&chunk).map_err(|error| refused(error.code, error.message))? {
            return Ok(ended);
        }
    }

    Err(refused(
        FailureCode::MalformedResponse,
        "response ended before it finished.".to_owned(),
    ))
}

/// The whole body, each piece within the window.
pub(crate) async fn read_all(
    mut response: Response,
    silence: &mut Silence,
) -> Result<Vec<u8>, Failure> {
    let mut body = Vec::new();

    while let Some(chunk) = next_chunk(&mut response, silence).await? {
        body.extend_from_slice(&chunk);
    }

    Ok(body)
}

/// What a refusal says: the provider's own error when its body names one,
/// else the body as text, else the status alone; and whether it says a
/// ChatGPT plan's usage is used up. A timeout while it is read is the
/// exchange's; a broken body leaves the status alone.
fn refusal(status: u16, body: Result<Vec<u8>, Failure>) -> Result<(String, bool), Failure> {
    let body = match body {
        Ok(body) => body,
        Err(failure @ Failure::TimedOut(_)) => return Err(failure),
        Err(Failure::Broken(_)) => return Ok((format!("provider HTTP {status}."), false)),
    };
    let text = String::from_utf8_lossy(&body);
    let named = match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(body)) => Some(body),
        _ => None,
    };
    let message = match named.as_ref().and_then(provider_error) {
        Some(message) => message,
        None if text.is_empty() => format!("provider HTTP {status}."),
        None => format!("provider HTTP {status}: {text}"),
    };

    Ok((message, named.as_ref().is_some_and(limit_reached)))
}

/// What a provider says in an error body, in what a 200 stream carries, or
/// in a response that failed: that a ChatGPT plan's usage is used up, else
/// its own words, under `error`, beside it, or as its `detail`.
pub(crate) fn provider_error(body: &Map<String, Value>) -> Option<String> {
    if limit_reached(body) {
        return Some(LIMIT_REACHED.to_owned());
    }

    body.get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .or_else(|| body.get("message").and_then(Value::as_str))
        .or_else(|| body.get("detail").and_then(Value::as_str))
        .map(|message| format!("provider error: {message}"))
}

/// Whether `body` says a ChatGPT plan's usage is used up, as the plan says
/// it: the type or the code `usage_limit_reached`, of its `error` or of
/// the body itself.
fn limit_reached(body: &Map<String, Value>) -> bool {
    let error = body.get("error").and_then(Value::as_object).unwrap_or(body);

    ["type", "code"]
        .iter()
        .any(|field| error.get(*field).and_then(Value::as_str) == Some("usage_limit_reached"))
}
