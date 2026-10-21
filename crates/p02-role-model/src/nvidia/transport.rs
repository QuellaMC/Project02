//! One exchange with the endpoint: the request, sent again after a
//! transport fault, and the answer read under a bound on the provider's
//! silence.

use std::time::Duration;

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Response, Url};
use serde_json::{Map, Value};
use tokio::time::Instant;

use super::Access;

/// How long to wait before the second and the third attempt.
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(250), Duration::from_secs(1)];

/// Bounds silence, not the exchange: the wait for the headers, then for
/// each next chunk, each within the window of the last thing the provider
/// sent. A reply of any length streams as long as bytes keep coming; a
/// provider that goes quiet fails one window after it last spoke.
#[derive(Debug)]
pub(super) struct Silence {
    window: Duration,
    deadline: Instant,
}

impl Silence {
    pub(super) fn start(window: Duration) -> Self {
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
pub(super) enum Failure {
    /// The provider said nothing for a whole window.
    TimedOut(Duration),
    /// The connection failed or broke off.
    Broken(reqwest::Error),
}

impl Failure {
    /// The failure as the round and the person are told it.
    pub(super) fn message(self) -> String {
        match self {
            Self::TimedOut(window) => format!(
                "NVIDIA provider request timed out after {}ms.",
                window.as_millis()
            ),
            Self::Broken(error) => {
                let error = error.without_url();
                let mut cause: &dyn std::error::Error = &error;

                while let Some(source) = cause.source() {
                    cause = source;
                }

                format!("NVIDIA provider request failed: {cause}.")
            }
        }
    }
}

/// How the endpoint answered.
#[derive(Debug)]
pub(super) enum Answer {
    /// A success status: the headers are in and the body is still to read.
    Accepted(Response),
    /// Any other status, after the last attempt it was worth.
    Refused { status: u16, message: String },
}

/// Sends `body` until an attempt is answered. A transport fault, or a 408,
/// a 429 or a 5xx, is tried again after a pause, twice; a timeout never is.
/// Headers of any status are the provider speaking, so they restart the
/// window, and the pauses wait inside it.
pub(super) async fn send(
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
pub(super) async fn next_chunk(
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
pub(super) async fn read_all(
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
        Err(Failure::Broken(_)) => return Ok(format!("NVIDIA provider HTTP {status}.")),
    };
    let text = String::from_utf8_lossy(&body);
    let named = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| value.as_object().and_then(provider_error));

    Ok(match named {
        Some(message) => message,
        None if text.is_empty() => format!("NVIDIA provider HTTP {status}."),
        None => format!("NVIDIA provider HTTP {status}: {text}"),
    })
}

/// The error a provider names in a body, or in a chunk of a 200 stream.
pub(super) fn provider_error(body: &Map<String, Value>) -> Option<String> {
    body.get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .or_else(|| body.get("message").and_then(Value::as_str))
        .map(|message| format!("NVIDIA provider error: {message}"))
}
