//! The records of a session log, one per line. Each record names the event
//! it belongs to, says what kind it is, and holds exactly the fields its
//! kind has, in the order they are written; a line with any other field is
//! no record. What one record may say about itself is checked here, by the
//! one constructor every record is made through, read or written; what it
//! may say given the records before it is the replay gate's.

mod commit;
mod continuation;
mod round;
mod terminal;
mod tool;

use p02_contracts::Evidence;
use p02_core::{EventIdentity, VisibleText};
use p02_shared::BoundJsonError;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

pub use commit::MessageCommitted;
pub use continuation::{
    ContinuedFrom, MAX_SUMMARY_CHARS, SessionContinuation, Summarizer, SummaryProvider,
};
pub use round::{CharacterRef, RoundRecord, RoundSnapshot};
pub use terminal::{
    AfterTurnCommitted, Judgement, RuntimeRejection, TurnCompleted, TurnEvidence, TurnRejected,
    TurnRejection, TurnStatus,
};
pub use tool::{ToolCallFinished, ToolCallStarted, ToolDispatch};

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
    /// The event's text was taken as the person's line.
    EventNormalized(EventNormalized),
    ModelRound(Box<RoundRecord>),
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
    RuntimeEventNormalized,
    RoleModelRound,
    ToolCallStarted,
    ToolCallFinished,
    VisibleMessageCommitted,
    RuntimeTurnCompleted,
    AfterTurnCommitted,
    RuntimeTurnRejected,
    SessionContinued,
}

/// What came in for a turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventReceived {
    pub payload_summary: PayloadSummary,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PayloadSummary {
    /// The text as it came.
    pub raw_input: String,
    /// The line it was taken as, unless it was refused as one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normalized_current_user_message: Option<VisibleText>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventNormalized {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionContinued {
    pub session_continuation: SessionContinuation,
}

/// Why a line is no record, or a record cannot be made.
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
    #[error("the record carries evidence of another event")]
    ForeignEvidence,
    #[error("a finished tool call carries evidence of a plugin other than its own")]
    EvidenceOfAnotherPlugin,
    #[error("a model round records another event's input")]
    EnvelopeOfAnotherEvent,
    #[error("model round {round} records a decision its output does not read as")]
    Verdict { round: std::num::NonZeroU32 },
    #[error("a model round keeps what it wrote with every credential-named value redacted")]
    UnkeptOutput,
    #[error(
        "a tool call is kept other than its session keeps it: within the JSON limits, credentials redacted"
    )]
    UnkeptToolCall(#[source] Option<BoundJsonError>),
    #[error("a call no plugin offers comes back as the runtime's refusal of it, never an answer")]
    UndeclaredAnswered,
    #[error(
        "a user commit holds the person's message and no round, a character commit the character's and its round, each anchoring its own message alone"
    )]
    Commit,
    #[error("a turn rejected for a model's reason names the round it judged, and only then")]
    RejectionRound,
    #[error("the turn records no reason this build knows: \"{0}\"")]
    UnknownReason(String),
    #[error("a completed turn names the round it judged exactly when it records its verdict")]
    Judgement,
    #[error("a rejection's message must not be blank")]
    BlankMessage,
    #[error("a continuation summary is trimmed text of 1 to {MAX_SUMMARY_CHARS} characters")]
    Summary,
    #[error("a session continues the segment before it")]
    ContinuedFrom,
    #[error("a continuation names its summarizer's model, or says why there was none")]
    Summarizer,
}

impl LogRecord {
    /// A record of `body` about the event `identity`.
    ///
    /// # Errors
    ///
    /// [`RecordError`] when the record speaks of another event than its own:
    /// evidence of another event or, for a finished call, of another
    /// plugin; or a model round shown another event.
    pub fn new(identity: EventIdentity, body: RecordBody) -> Result<Self, RecordError> {
        if body
            .evidence()
            .iter()
            .any(|evidence| evidence.identity() != &identity)
        {
            return Err(RecordError::ForeignEvidence);
        }

        match &body {
            RecordBody::ToolCallFinished(call)
                if call
                    .evidence()
                    .iter()
                    .any(|evidence| evidence.plugin_id() != call.tool_plugin_id()) =>
            {
                return Err(RecordError::EvidenceOfAnotherPlugin);
            }
            RecordBody::ModelRound(round) if round.snapshot().input_envelope.event != identity => {
                return Err(RecordError::EnvelopeOfAnotherEvent);
            }
            _ => {}
        }

        Ok(Self { identity, body })
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

        Self::new(identity, body)
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
            Self::EventNormalized(_) => RecordKind::RuntimeEventNormalized,
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

    /// The plugin evidence the record carries.
    #[must_use]
    pub fn evidence(&self) -> &[Evidence] {
        match self {
            Self::ToolCallFinished(call) => call.evidence(),
            Self::MessageCommitted(commit) => commit.evidence(),
            Self::TurnCompleted(completed) => &completed.runtime_plugin_evidence,
            Self::AfterTurnCommitted(after) => &after.runtime_plugin_evidence,
            Self::TurnRejected(rejected) => &rejected.runtime_plugin_evidence,
            Self::EventReceived(_)
            | Self::EventNormalized(_)
            | Self::ModelRound(_)
            | Self::ToolCallStarted(_)
            | Self::SessionContinued(_) => &[],
        }
    }

    fn from_fields(kind: RecordKind, fields: Value) -> Result<Self, serde_json::Error> {
        Ok(match kind {
            RecordKind::RuntimeEventReceived => {
                Self::EventReceived(serde_json::from_value(fields)?)
            }
            RecordKind::RuntimeEventNormalized => {
                Self::EventNormalized(serde_json::from_value(fields)?)
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
