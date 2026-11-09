//! A conversation as a client reaches it: a character's thread with the
//! person opened, a line sent into it, and a page of its scrollback.

use p02_core::{
    ClientStamp, ConversationId, MessageId, SpeakerName, Timestamp, VisibleMessageRole, VisibleText,
};
use p02_shared::{Identifier, vocabulary};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::text::{Short, Text};

/// The character whose thread with the person to open.
#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenConversationBody {
    pub character_id: Short,
}

/// What came of opening a character's thread with the person.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum OpenOutcome {
    Opened {
        conversation_id: ConversationId,
        character_id: Identifier,
    },
    Refused {
        reason: OpenRefusal,
        message: String,
    },
    Failed(StorageFailure),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum OpenRefusal {
    CharacterUnavailable,
}

/// The person's line into one conversation, with the two stamps its client
/// puts on it: which surface carried it, and the id a repeat of the same
/// submission reuses.
#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayMessage {
    pub conversation_id: Short,
    pub text: Text,
    pub source: ClientStamp,
    pub client_message_id: ClientStamp,
}

/// What became of a line sent to a character: queued in her inbox, where
/// she takes it in its turn and the stream tells how that ended, or
/// refused at once.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SubmitOutcome {
    /// In her inbox now, behind every line before it.
    Queued,
    /// In her inbox already, under the same id.
    AlreadyQueued,
    /// Refused before it was queued.
    Refused {
        reason: TurnRefusal,
        message: String,
    },
    /// Her inbox could not take it.
    Failed(StorageFailure),
}

vocabulary! {
    /// Why a line was refused before any turn ran.
    #[ts(rename = "GatewayRefusalReason")]
    #[schemars(rename = "GatewayRefusalReason")]
    TurnRefusal {
        UnknownConversation = "unknown_conversation",
        CharacterUnavailable = "character_unavailable",
        DuplicateSubmission = "duplicate_submission",
    }
}

/// An ordinary failure of the home's storage, a full disk, a permission or
/// a damaged record, which the person is told and which is no bug.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
pub struct StorageFailure {
    pub code: String,
    pub message: String,
}

/// One page of a conversation's scrollback, chronological within the page;
/// `earlier` is the cursor of the page before it, while older messages
/// exist.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(optional_fields)]
pub enum HistoryOutcome {
    Ok {
        conversation_id: ConversationId,
        character_id: Identifier,
        messages: Vec<HistoryMessage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        earlier: Option<String>,
    },
    Refused {
        reason: HistoryRefusal,
        message: String,
    },
    Failed(StorageFailure),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HistoryRefusal {
    UnknownConversation,
    InvalidPage,
}

/// A committed message as the scrollback shows it, with the stamps its
/// client put on the person's line and when it was committed.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct HistoryMessage {
    pub message_id: MessageId,
    pub role: VisibleMessageRole,
    pub speaker_id: Identifier,
    pub speaker_name: SpeakerName,
    pub text: VisibleText,
    pub committed_at: Timestamp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ClientStamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<ClientStamp>,
}
