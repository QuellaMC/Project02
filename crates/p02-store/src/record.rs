//! The records of a session log, one per line. Each record names the event
//! it belongs to, says what kind it is, and holds the fields its kind has,
//! in the order they are written; a field it does not know is ignored.

mod commit;
mod continuation;
mod round;
mod terminal;
mod tool;

use p02_contracts::Occasion;
use p02_core::{EventIdentity, VisibleText};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

pub use commit::MessageCommitted;
pub use continuation::{ContinuedFrom, SessionContinuation, Summarizer, SummaryProvider};
pub use round::RoundRecord;
pub use terminal::{
    AfterTurnCommitted, Judgement, RuntimeRejection, TurnCompleted, TurnRejected, TurnRejection,
    TurnStatus,
};
pub use tool::{ToolCallFinished, ToolCallStarted};

/// One line of a session log: the event it belongs to, and what happened.
#[derive(Clone, Debug, PartialEq)]
pub struct LogRecord {
    identity: EventIdentity,
    body: RecordBody,
}

/// What a record says happened.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum RecordBody {
    /// The event of a turn came in: the first record of every turn.
    EventReceived(EventReceived),
    ModelRound(RoundRecord),
    ToolCallStarted(ToolCallStarted),
    ToolCallFinished(ToolCallFinished),
    MessageCommitted(MessageCommitted),
    TurnCompleted(TurnCompleted),
    /// What the plugins did once the turn was durable.
    AfterTurnCommitted(AfterTurnCommitted),
    TurnRejected(TurnRejected),
    /// The session continues an earlier one: its first record, when it has
    /// one.
    SessionContinued(SessionContinued),
}

/// The kind a record says it is, by its one spelling.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordKind {
    RuntimeEventReceived,
    RoleModelRound,
    ToolCallStarted,
    ToolCallFinished,
    VisibleMessageCommitted,
    RuntimeTurnCompleted,
    AfterTurnCommitted,
    RuntimeTurnRejected,
    SessionContinued,
}

/// What came in for a turn: the person's text, or nothing, for a moment of
/// the character's own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "WireReceived", into = "WireReceived")]
pub enum EventReceived {
    Text(PayloadSummary),
    Moment,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadSummary {
    /// The text as it came.
    pub raw_input: String,
    /// The line it was taken as, unless it was refused as one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normalized_current_user_message: Option<VisibleText>,
}

/// An event as recorded: the person's text says what came in, as every
/// earlier build wrote it, and a moment says it is one.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireReceived {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    occasion: Option<Occasion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    payload_summary: Option<PayloadSummary>,
}

impl EventReceived {
    /// What the turn began from: the person's line, whether or not it was
    /// taken as one, or a moment of hers.
    #[must_use]
    pub fn occasion(&self) -> Occasion {
        match self {
            Self::Text(_) => Occasion::Line,
            Self::Moment => Occasion::Moment,
        }
    }
}

impl TryFrom<WireReceived> for EventReceived {
    type Error = &'static str;

    fn try_from(wire: WireReceived) -> Result<Self, Self::Error> {
        match (wire.occasion, wire.payload_summary) {
            (Some(Occasion::Moment), _) => Ok(Self::Moment),
            (_, Some(summary)) => Ok(Self::Text(summary)),
            (_, None) => Err("an event the person began says what came in"),
        }
    }
}

impl From<EventReceived> for WireReceived {
    fn from(received: EventReceived) -> Self {
        match received {
            EventReceived::Text(summary) => Self {
                occasion: None,
                payload_summary: Some(summary),
            },
            EventReceived::Moment => Self {
                occasion: Some(Occasion::Moment),
                payload_summary: None,
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionContinued {
    pub session_continuation: SessionContinuation,
}

/// Why a line is no record.
#[derive(Debug, thiserror::Error)]
pub enum RecordError {
    #[error("the line is not JSON")]
    NotJson(#[source] serde_json::Error),
    #[error("the line is not a JSON object")]
    NotAnObject,
    #[error("the record's event identity is malformed")]
    Identity(#[source] serde_json::Error),
    #[error("the record names no kind of record")]
    Kind(#[source] serde_json::Error),
    #[error("a {kind:?} record is malformed")]
    Fields {
        kind: RecordKind,
        #[source]
        source: serde_json::Error,
    },
}

impl LogRecord {
    /// A record of `body` about the event `identity`.
    #[must_use]
    pub fn new(identity: EventIdentity, body: RecordBody) -> Self {
        Self { identity, body }
    }

    #[must_use]
    pub fn identity(&self) -> &EventIdentity {
        &self.identity
    }

    #[must_use]
    pub fn body(&self) -> &RecordBody {
        &self.body
    }

    #[must_use]
    pub fn kind(&self) -> RecordKind {
        self.body.kind()
    }

    /// The record as its line holds it, without the newline.
    #[must_use]
    #[expect(
        clippy::missing_panics_doc,
        reason = "a record holds no map whose keys are not text, so it always serializes"
    )]
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).expect("a record holds no map with keys that are not text")
    }

    /// The record a line holds.
    ///
    /// # Errors
    ///
    /// [`RecordError`] for the first reason the line is no record.
    pub fn from_line(line: &[u8]) -> Result<Self, RecordError> {
        match serde_json::from_slice(line).map_err(RecordError::NotJson)? {
            Value::Object(fields) => Self::from_fields(fields),
            _ => Err(RecordError::NotAnObject),
        }
    }

    fn from_fields(mut fields: Map<String, Value>) -> Result<Self, RecordError> {
        let identity: Map<String, Value> = ["eventId", "traceId", "createdAt"]
            .into_iter()
            .filter_map(|key| fields.remove(key).map(|value| (key.to_owned(), value)))
            .collect();
        let identity =
            serde_json::from_value(Value::Object(identity)).map_err(RecordError::Identity)?;
        let kind: RecordKind = serde_json::from_value(fields.remove("kind").unwrap_or(Value::Null))
            .map_err(RecordError::Kind)?;
        let body = RecordBody::from_fields(kind, Value::Object(fields))
            .map_err(|source| RecordError::Fields { kind, source })?;

        Ok(Self::new(identity, body))
    }
}

impl Serialize for LogRecord {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Line<'a> {
            #[serde(flatten)]
            identity: &'a EventIdentity,
            kind: RecordKind,
            #[serde(flatten)]
            body: &'a RecordBody,
        }

        Line {
            identity: &self.identity,
            kind: self.kind(),
            body: &self.body,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for LogRecord {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::from_fields(Map::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

impl RecordBody {
    #[must_use]
    pub fn kind(&self) -> RecordKind {
        match self {
            Self::EventReceived(_) => RecordKind::RuntimeEventReceived,
            Self::ModelRound(_) => RecordKind::RoleModelRound,
            Self::ToolCallStarted(_) => RecordKind::ToolCallStarted,
            Self::ToolCallFinished(_) => RecordKind::ToolCallFinished,
            Self::MessageCommitted(_) => RecordKind::VisibleMessageCommitted,
            Self::TurnCompleted(_) => RecordKind::RuntimeTurnCompleted,
            Self::AfterTurnCommitted(_) => RecordKind::AfterTurnCommitted,
            Self::TurnRejected(_) => RecordKind::RuntimeTurnRejected,
            Self::SessionContinued(_) => RecordKind::SessionContinued,
        }
    }

    fn from_fields(kind: RecordKind, fields: Value) -> Result<Self, serde_json::Error> {
        Ok(match kind {
            RecordKind::RuntimeEventReceived => {
                Self::EventReceived(serde_json::from_value(fields)?)
            }
            RecordKind::RoleModelRound => Self::ModelRound(serde_json::from_value(fields)?),
            RecordKind::ToolCallStarted => Self::ToolCallStarted(serde_json::from_value(fields)?),
            RecordKind::ToolCallFinished => Self::ToolCallFinished(serde_json::from_value(fields)?),
            RecordKind::VisibleMessageCommitted => {
                Self::MessageCommitted(serde_json::from_value(fields)?)
            }
            RecordKind::RuntimeTurnCompleted => {
                Self::TurnCompleted(serde_json::from_value(fields)?)
            }
            RecordKind::AfterTurnCommitted => {
                Self::AfterTurnCommitted(serde_json::from_value(fields)?)
            }
            RecordKind::RuntimeTurnRejected => Self::TurnRejected(serde_json::from_value(fields)?),
            RecordKind::SessionContinued => Self::SessionContinued(serde_json::from_value(fields)?),
        })
    }
}
