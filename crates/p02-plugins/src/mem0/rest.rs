//! The hosted platform and a self-hosted server: the same three requests,
//! each in its own dialect. An answer is read only as its own backend
//! shapes it: anything else is unreadable, never an empty result.

use p02_memory::{Message, Role, Scope};
use p02_shared::{BaseUrl, credential_header, http_client};
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderName, HeaderValue};
use reqwest::{Method, Response};
use serde_json::{Map, Value, json};

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
        let unreadable = || BackendError::new(Operation::Search, Failure::Unreadable);

        rows(&answer)
            .ok_or_else(unreadable)?
            .iter()
            .map(|row| found(row).ok_or_else(unreadable))
            .collect()
    }

    pub(super) async fn write(&self, scope: &Scope, write: Write) -> Result<Written, BackendError> {
        let (messages, session, infer, sources) = match write {
            Write::Turn(turn) => (turn.messages, Some(turn.session), true, turn.sources),
            Write::Fact { text, sources } => (
                vec![Message {
                    role: Role::User,
                    content: text,
                }],
                None,
                false,
                sources,
            ),
        };
        let mut body = Map::new();

        body.insert(
            "messages".to_owned(),
            messages
                .iter()
                .map(|message| json!({"role": message.role.as_str(), "content": message.content}))
                .collect(),
        );
        body.insert("user_id".to_owned(), Value::from(scope.user()));
        body.insert("agent_id".to_owned(), Value::from(scope.agent()));

        if let Some(session) = session {
            body.insert("run_id".to_owned(), Value::from(session));
        }

        body.insert("infer".to_owned(), Value::Bool(infer));

        if !sources.is_empty() {
            body.insert("metadata".to_owned(), json!({"project02_sources": sources}));
        }

        let path = match self.dialect {
            Dialect::Platform => "v3/memories/add/",
            Dialect::Server => "memories",
        };
        let answer = self
            .document(Operation::Add, path, &Value::Object(body))
            .await?;
        let written = match self.dialect {
            Dialect::Platform => answer
                .get("event_id")
                .and_then(identifier)
                .map(Written::Queued),
            Dialect::Server => rows(&answer).and_then(|rows| {
                rows.iter()
                    .map(|row| row.get("id").and_then(identifier))
                    .collect::<Option<Vec<_>>>()
                    .map(Written::Stored)
            }),
        };

        written.ok_or_else(|| BackendError::new(Operation::Add, Failure::Unreadable))
    }

    /// The JSON document a successful request answered with.
    async fn document(
        &self,
        operation: Operation,
        path: &str,
        body: &Value,
    ) -> Result<Value, BackendError> {
        let response = self.send(operation, Method::POST, path, Some(body)).await?;
        let unreadable = BackendError::new(operation, Failure::Unreadable);
        let bytes = response.bytes().await.map_err(|_| unreadable.clone())?;

        serde_json::from_slice(&bytes).map_err(|_| unreadable)
    }

    /// A response with a success status. A transport error is never
    /// repeated, since it can name the address; a redirect is refused as
    /// the status it is.
    async fn send(
        &self,
        operation: Operation,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Response, BackendError> {
        let mut request = self
            .http
            .request(method, self.base.endpoint(path))
            .header(ACCEPT, "application/json");

        if let Some((name, value)) = &self.credential {
            request = request.header(name, value.clone());
        }

        if let Some(body) = body {
            request = request.json(body);
        }

        let response = request
            .send()
            .await
            .map_err(|_| BackendError::new(operation, Failure::Unreachable))?;
        let status = response.status();

        if status.is_success() {
            Ok(response)
        } else {
            Err(BackendError::new(operation, Failure::Http(status.as_u16())))
        }
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
