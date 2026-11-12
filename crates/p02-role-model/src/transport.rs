//! One exchange with a service's endpoint, whatever protocol it speaks:
//! how the request proves who sends it, the request, sent again after a
//! transport fault, the answer read under a bound on the provider's
//! silence, and how a round that got no answer failed, in the words the
//! person is told.

use std::fmt;
use std::sync::OnceLock;
use std::time::Duration;

use p02_contracts::{ProviderAnswer, ProviderFailure};
use p02_shared::{credential_header, http_client};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use reqwest::{Response, Url};
use serde_json::{Map, Value};
use tokio::time::Instant;

/// How long the provider may say nothing, before the headers or between
/// two chunks, unless the bound is shortened.
pub(crate) const PROVIDER_SILENCE: Duration = Duration::from_secs(30);

/// How long to wait before the second and the third attempt.
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(250), Duration::from_secs(1)];

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
}

/// How a request proves who sends it.
pub(crate) enum Access {
    /// The key travels as a bearer token; no failure ever repeats it.
    Key { header: HeaderValue, secret: String },
    /// A server of one's own, which may ask for no key.
    Open,
}

impl fmt::Debug for Access {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Key { .. } => "Key([redacted])",
            Self::Open => "Open",
        })
    }
}

impl Access {
    /// `key`, of `service`, as a bearer token, unless it holds what a
    /// header cannot carry.
    pub(crate) fn bearer(service: &'static str, key: &str) -> Result<Self, BuildAdapterError> {
        Ok(Self::Key {
            header: credential_header(&format!("Bearer {key}"))
                .map_err(|_| BuildAdapterError::Credential(service))?,
            secret: key.to_owned(),
        })
    }

    /// `message` without the key, wherever a provider or a transport
    /// repeated it.
    fn redact(&self, message: String) -> String {
        match self {
            Self::Key { secret, .. } => message.replace(secret.as_str(), "[redacted]"),
            Self::Open => message,
        }
    }
}

/// What went wrong as the person is told it: the words of `service`, after
/// its name, and without the key wherever the service or a transport
/// repeated it.
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

    /// The provider just said something.
    fn touch(&mut self) {
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
    /// Any other status, after the last attempt it was worth.
    Refused { status: u16, message: String },
}

/// Sends `body` until an attempt is answered. A transport fault, or a 408,
/// a 429 or a 5xx, is tried again after a pause, twice; a timeout never is.
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
        let mut request = http
            .post(endpoint.clone())
            .header(CONTENT_TYPE, "application/json")
            .body(body.to_vec());

        if let Access::Key { header, .. } = access {
            request = request.header(AUTHORIZATION, header.clone());
        }

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

        let message = refusal(status.as_u16(), read_all(response, silence).await)?;
        let worth_again =
            status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error();

        match retry {
            Some(delay) if worth_again => silence.wait(tokio::time::sleep(*delay)).await?,
            _ => {
                return Ok(Answer::Refused {
                    status: status.as_u16(),
                    message,
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
/// else the body as text, else the status alone. A timeout while it is read
/// is the exchange's; a broken body leaves the status alone.
fn refusal(status: u16, body: Result<Vec<u8>, Failure>) -> Result<String, Failure> {
    let body = match body {
        Ok(body) => body,
        Err(failure @ Failure::TimedOut(_)) => return Err(failure),
        Err(Failure::Broken(_)) => return Ok(format!("provider HTTP {status}.")),
    };
    let text = String::from_utf8_lossy(&body);
    let named = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| value.as_object().and_then(provider_error));

    Ok(match named {
        Some(message) => message,
        None if text.is_empty() => format!("provider HTTP {status}."),
        None => format!("provider HTTP {status}: {text}"),
    })
}

/// The error a provider names in a body, in what a 200 stream carries, or
/// in a response that failed.
pub(crate) fn provider_error(body: &Map<String, Value>) -> Option<String> {
    body.get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .or_else(|| body.get("message").and_then(Value::as_str))
        .map(|message| format!("provider error: {message}"))
}
