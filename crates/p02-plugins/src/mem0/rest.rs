//! The hosted platform and a self-hosted server: the same two requests,
//! each in its own dialect. An answer is read only as its own backend
//! shapes it, anything else unreadable, never an empty result; a row of
//! it that names no memory is passed over.

use p02_memory::{Message, Role, Scope};
use p02_shared::{BaseUrl, credential_header, http_client};
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderName, HeaderValue};
use serde_json::{Value, json};

use super::backend::{BackendError, Failure, Found, Operation, RECALL_LIMIT, Write, Written};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Dialect {
    /// The hosted platform: version 3, `Token` auth, and an add the
    /// platform acknowledges with a receipt and processes later.
    Platform,
    /// A self-hosted server: flat paths, Bearer auth or an `X-API-Key` for
    /// `m0sk_` keys, and an add that answers with what it stored.
    Server,
}

#[derive(Debug)]
pub(super) struct Rest {
    dialect: Dialect,
    base: BaseUrl,
    credential: Option<(HeaderName, HeaderValue)>,
    http: reqwest::Client,
}

/// Why a REST backend cannot be built from its settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub(super) enum BuildRestError {
    #[error("Mem0 apiKey holds characters a request header cannot carry.")]
    Credential,
    #[error("Mem0 could not set up its HTTP client.")]
    Client,
}

impl Rest {
    pub(super) fn new(
        dialect: Dialect,
        base: BaseUrl,
        api_key: Option<&str>,
    ) -> Result<Self, BuildRestError> {
        let credential = api_key
            .map(|key| match dialect {
                Dialect::Platform => (AUTHORIZATION, format!("Token {key}")),
                Dialect::Server if key.starts_with("m0sk_") => {
                    (HeaderName::from_static("x-api-key"), key.to_owned())
                }
                Dialect::Server => (AUTHORIZATION, format!("Bearer {key}")),
            })
            .map(|(name, value)| {
                credential_header(&value)
                    .map(|value| (name, value))
                    .map_err(|_| BuildRestError::Credential)
            })
            .transpose()?;
        let http = http_client().build().map_err(|_| BuildRestError::Client)?;

        Ok(Self {
            dialect,
            base,
            credential,
            http,
        })
    }

    pub(super) async fn search(
        &self,
        scope: &Scope,
        query: &str,
    ) -> Result<Vec<Found>, BackendError> {
        let (path, body) = match self.dialect {
            Dialect::Platform => (
                "v3/memories/search/",
                json!({
                    "query": query,
                    "filters": {"user_id": scope.user(), "agent_id": scope.agent()},
                    "top_k": RECALL_LIMIT,
                }),
            ),
            Dialect::Server => (
                "search",
                json!({
                    "query": query,
                    "user_id": scope.user(),
                    "agent_id": scope.agent(),
                    "limit": RECALL_LIMIT,
                }),
            ),
        };
        let answer = self.document(Operation::Search, path, &body).await?;

        Ok(rows(&answer)
            .ok_or_else(|| BackendError::new(Operation::Search, Failure::Unreadable))?
            .iter()
            .filter_map(found)
            .collect())
    }

    pub(super) async fn write(&self, scope: &Scope, write: Write) -> Result<Written, BackendError> {
        let (messages, infer) = match write {
            Write::Turn(turn) => (turn.messages, true),
            Write::Fact { text, .. } => (
                vec![Message {
                    role: Role::User,
                    content: text,
                }],
                false,
            ),
        };
        let body = json!({
            "messages": messages
                .iter()
                .map(|message| json!({"role": message.role.as_str(), "content": message.content}))
                .collect::<Vec<_>>(),
            "user_id": scope.user(),
            "agent_id": scope.agent(),
            "infer": infer,
        });
        let path = match self.dialect {
            Dialect::Platform => "v3/memories/add/",
            Dialect::Server => "memories",
        };
        let answer = self.document(Operation::Add, path, &body).await?;
        let written = match self.dialect {
            Dialect::Platform => answer
                .get("event_id")
                .and_then(identifier)
                .map(Written::Queued),
            Dialect::Server => rows(&answer).map(|rows| {
                Written::Stored(
                    rows.iter()
                        .filter_map(|row| row.get("id").and_then(identifier))
                        .collect(),
                )
            }),
        };

        written.ok_or_else(|| BackendError::new(Operation::Add, Failure::Unreadable))
    }

    /// The JSON document a successful POST of `body` to `path` answered
    /// with. A transport error is never repeated, since it can name the
    /// address; a redirect is refused as the status it is.
    async fn document(
        &self,
        operation: Operation,
        path: &str,
        body: &Value,
    ) -> Result<Value, BackendError> {
        let mut request = self
            .http
            .post(self.base.endpoint(path))
            .header(ACCEPT, "application/json")
            .json(body);

        if let Some((name, value)) = &self.credential {
            request = request.header(name, value.clone());
        }

        let response = request
            .send()
            .await
            .map_err(|_| BackendError::new(operation, Failure::Unreachable))?;
        let status = response.status();

        if !status.is_success() {
            return Err(BackendError::new(operation, Failure::Http(status.as_u16())));
        }

        let unreadable = || BackendError::new(operation, Failure::Unreadable);
        let bytes = response.bytes().await.map_err(|_| unreadable())?;

        serde_json::from_slice(&bytes).map_err(|_| unreadable())
    }
}

/// The rows of an answer: a bare array, or one under `results`.
fn rows(answer: &Value) -> Option<&[Value]> {
    match answer {
        Value::Array(rows) => Some(rows),
        Value::Object(fields) => fields
            .get("results")
            .and_then(Value::as_array)
            .map(Vec::as_slice),
        _ => None,
    }
}

/// A memory in a search's rows: an id, a text under `memory` or `text`,
/// and maybe a score.
fn found(row: &Value) -> Option<Found> {
    let text = ["memory", "text"].iter().find_map(|field| {
        row.get(field)
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
    })?;

    Some(Found {
        id: row.get("id").and_then(identifier)?,
        text: text.to_owned(),
        score: row.get("score").and_then(Value::as_f64),
    })
}

/// An id as a backend writes one: a string with something in it, or a
/// number.
fn identifier(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}
