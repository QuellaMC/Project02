//! The OpenAI-wire requests the engine makes of the extraction model and
//! of the embedder: a chat completion that answers in JSON, and the
//! embedding of one text. A failure says what happened in words that hold
//! neither the address nor the key.

use std::time::Duration;

use p02_shared::{BaseUrl, InvalidCredentialError, credential_header, http_client};
use reqwest::header::{AUTHORIZATION, HeaderValue};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// The OpenAI cloud, which an endpoint left unset means.
pub const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

/// The extraction model mem0 uses when none is named.
pub const DEFAULT_MODEL: &str = "gpt-5-mini";

/// The embedding model mem0 uses when none is named.
pub const DEFAULT_EMBEDDER_MODEL: &str = "text-embedding-3-small";

/// No request may outlast the capture it serves, nor hold re-embedding up
/// longer.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// One model at one OpenAI-wire service, and the key it takes, if any.
#[derive(Clone, Debug)]
pub struct Endpoint {
    base_url: BaseUrl,
    authorization: Option<HeaderValue>,
    model: String,
}

impl Endpoint {
    /// # Errors
    ///
    /// [`InvalidCredentialError`] when `api_key` cannot travel in a header.
    pub fn new(
        base_url: BaseUrl,
        api_key: Option<&str>,
        model: impl Into<String>,
    ) -> Result<Self, InvalidCredentialError> {
        Ok(Self {
            base_url,
            authorization: api_key
                .map(|key| credential_header(&format!("Bearer {key}")))
                .transpose()?,
            model: model.into(),
        })
    }

    #[must_use]
    pub fn base_url(&self) -> &BaseUrl {
        &self.base_url
    }

    #[must_use]
    pub fn model(&self) -> &str {
        &self.model
    }
}

/// How an endpoint failed, said after the endpoint's name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum EndpointError {
    #[error("answered HTTP {0}")]
    Status(u16),
    #[error("is unreachable")]
    Unreachable,
    #[error("did not answer within {} seconds", REQUEST_TIMEOUT.as_secs())]
    TimedOut,
    #[error("returned an unreadable response body")]
    Unreadable,
}

/// Why the engine's client could not be built.
#[derive(Debug, thiserror::Error)]
#[error("the engine's HTTP client could not be built")]
pub struct BuildClientError(#[source] reqwest::Error);

#[derive(Debug)]
pub(crate) struct Client {
    http: reqwest::Client,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: [ChatMessage<'a>; 2],
    response_format: ResponseFormat,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    kind: &'static str,
}

#[derive(Deserialize)]
struct Completion {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: AnswerMessage,
}

#[derive(Deserialize)]
struct AnswerMessage {
    content: Option<String>,
}

#[derive(Serialize)]
struct EmbeddingRequest<'a> {
    model: &'a str,
    input: &'a str,
    encoding_format: &'static str,
}

#[derive(Deserialize)]
struct Embeddings {
    data: Vec<Embedding>,
}

#[derive(Deserialize)]
struct Embedding {
    embedding: Vec<f32>,
}

impl Client {
    pub(crate) fn new() -> Result<Self, BuildClientError> {
        Ok(Self {
            http: http_client()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .map_err(BuildClientError)?,
        })
    }

    /// What the model answers `user` under `system`, asked for JSON.
    pub(crate) async fn complete_json(
        &self,
        endpoint: &Endpoint,
        system: &str,
        user: &str,
    ) -> Result<String, EndpointError> {
        let request = ChatRequest {
            model: &endpoint.model,
            messages: [
                ChatMessage {
                    role: "system",
                    content: system,
                },
                ChatMessage {
                    role: "user",
                    content: user,
                },
            ],
            response_format: ResponseFormat {
                kind: "json_object",
            },
        };
        let completion: Completion = self.post(endpoint, "chat/completions", &request).await?;

        completion
            .choices
            .into_iter()
            .next()
            .and_then(|choice| choice.message.content)
            .ok_or(EndpointError::Unreadable)
    }

    /// The vector of `text`, asked for alone, so the answer can be no
    /// other text's.
    pub(crate) async fn embed(
        &self,
        endpoint: &Endpoint,
        text: &str,
    ) -> Result<Vec<f32>, EndpointError> {
        let request = EmbeddingRequest {
            model: &endpoint.model,
            input: text,
            encoding_format: "float",
        };
        let answer: Embeddings = self.post(endpoint, "embeddings", &request).await?;

        match <[Embedding; 1]>::try_from(answer.data) {
            Ok([Embedding { embedding }])
                if !embedding.is_empty() && embedding.iter().all(|value| value.is_finite()) =>
            {
                Ok(embedding)
            }
            _ => Err(EndpointError::Unreadable),
        }
    }

    async fn post<T: DeserializeOwned>(
        &self,
        endpoint: &Endpoint,
        path: &str,
        body: &impl Serialize,
    ) -> Result<T, EndpointError> {
        let mut request = self.http.post(endpoint.base_url.endpoint(path)).json(body);

        if let Some(authorization) = &endpoint.authorization {
            request = request.header(AUTHORIZATION, authorization.clone());
        }

        let response = request.send().await.map_err(|error| transport(&error))?;
        let status = response.status();

        if !status.is_success() {
            return Err(EndpointError::Status(status.as_u16()));
        }

        let bytes = response.bytes().await.map_err(|error| {
            if error.is_timeout() {
                EndpointError::TimedOut
            } else {
                EndpointError::Unreadable
            }
        })?;

        serde_json::from_slice(&bytes).map_err(|_| EndpointError::Unreadable)
    }
}

fn transport(error: &reqwest::Error) -> EndpointError {
    if error.is_timeout() {
        EndpointError::TimedOut
    } else {
        EndpointError::Unreachable
    }
}
