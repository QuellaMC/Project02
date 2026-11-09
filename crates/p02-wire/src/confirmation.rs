//! Confirmations: an approval-gated call parked for the person's answer,
//! the answer, and how the confirmation settled.

use std::fmt;

use p02_core::{ClientStamp, ConversationId};
use p02_shared::Identifier;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;
use uuid::Uuid;

/// A parked confirmation's id: a fresh UUID, unique across the daemon, by
/// which any surface answers it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(transparent)]
#[ts(as = "String")]
pub struct ConfirmationId(String);

impl ConfirmationId {
    /// A fresh id: the one way one is minted.
    #[must_use]
    pub fn mint() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ConfirmationId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// The person's answer to a parked confirmation or a pairing request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum Answer {
    Approved,
    Denied,
}

/// The person's answer, to a confirmation or a pairing request alike.
#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AnswerBody {
    pub decision: Answer,
}

/// What an answer to a parked confirmation came to. `expired`: the deadline
/// had passed, so the confirmation was settled cancelled instead; the
/// client is never the judge of the deadline.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(rename = "AnswerOutcome")]
#[schemars(rename = "AnswerOutcome")]
pub enum ConfirmationAnswer {
    Answered,
    Expired,
    Unknown,
}

/// The submission a turn runs for, which any surface can tell as its own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "TurnIdentity")]
#[schemars(rename = "TurnIdentity")]
pub struct TurnStamp {
    pub conversation_id: ConversationId,
    pub source: ClientStamp,
    pub client_message_id: ClientStamp,
}

/// A parked confirmation, as the stream announced it and the list shows it.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct PendingConfirmation {
    pub character_id: Identifier,
    pub id: ConfirmationId,
    pub request: ConfirmationQuestion,
    /// When the confirmation expires, in milliseconds since the Unix epoch.
    pub deadline_at: i64,
    /// The turn that raised it; none for a call raised outside any turn.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<TurnStamp>,
}

/// What the person is asked about: the plugin and tool whose call it is,
/// what the tool says it does, and what the call would do.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationQuestion {
    pub plugin_id: Identifier,
    pub tool_name: Identifier,
    pub summary: String,
    pub preview: Map<String, Value>,
}

/// How a confirmation ended: with the person's answer, or cancelled and
/// why.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "decision", rename_all = "snake_case")]
#[ts(rename = "ConfirmationSettlement")]
#[schemars(rename = "ConfirmationSettlement")]
pub enum Settlement {
    Approved,
    Denied,
    Cancelled { reason: CancelReason },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename = "ConfirmationCancelReason")]
#[schemars(rename = "ConfirmationCancelReason")]
pub enum CancelReason {
    /// Nobody answered by the deadline.
    Expired,
    /// Her character stopped.
    Stopped,
}
