//! The event stream: what every surface hears, a turn as it runs, and the
//! snapshot a stream that cannot be caught up begins with.

use std::num::NonZeroU32;

use p02_core::{ClientStamp, ConversationId, MessageId, SpeakerName, VisibleText};
use p02_shared::Identifier;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::confirmation::{ConfirmationId, PendingConfirmation, Settlement};
use crate::health::{CharacterState, Health, MaintenanceFailure};
use crate::pairing::{PairingDecision, PairingRequest, PairingSubject};
use crate::protocol::ProtocolVersion;

/// What every surface hears.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(rename = "GatewayEvent", optional_fields)]
#[schemars(rename = "GatewayEvent")]
pub enum Event {
    /// A turn's progress: each message once it is durable, and the tool
    /// calls of its rounds.
    TurnProgress {
        character_id: Identifier,
        conversation_id: ConversationId,
        progress: TurnProgress,
    },
    /// A turn as it runs now, said whenever that changes, from the commit
    /// of her line until the completion that ends it.
    TurnRunning(RunningTurn),
    /// How a turn ended, with its line's stamps, so that a surface knows
    /// whose turn ended and whether its line is in the log.
    TurnCompleted {
        character_id: Identifier,
        conversation_id: ConversationId,
        source: ClientStamp,
        client_message_id: ClientStamp,
        status: TurnStatus,
        committed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    ConfirmationRequested(PendingConfirmation),
    ConfirmationSettled {
        character_id: Identifier,
        id: ConfirmationId,
        #[serde(flatten)]
        settlement: Settlement,
    },
    PairingRequested(PairingRequest),
    PairingSettled {
        connector_id: Identifier,
        code: String,
        subject: PairingSubject,
        decision: PairingDecision,
    },
    StateChanged {
        character_id: Identifier,
        state: CharacterState,
        /// Present when a failure caused the change, or when she needs a
        /// model: what to do about it.
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// The daemon's whole state read again: when the settings changed,
    /// before the pass that acts on them, and when a connector came onto
    /// the stream or left it.
    HealthChanged {
        health: Health,
    },
    MaintenanceFailed {
        character_id: Identifier,
        #[serde(flatten)]
        failure: MaintenanceFailure,
    },
}

/// How a turn ended, as the frame announcing it says.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Completed,
    Rejected,
    Refused,
    Failed,
}

impl Event {
    /// Whether this ends `turn`: its completion, never another line's.
    #[must_use]
    pub fn ends(&self, turn: &RunningTurn) -> bool {
        matches!(
            self,
            Self::TurnCompleted {
                conversation_id,
                source,
                client_message_id,
                ..
            } if *conversation_id == turn.conversation_id
                && *source == turn.source
                && *client_message_id == turn.client_message_id
        )
    }
}

/// What a turn says as it goes, in order.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(optional_fields)]
pub enum TurnProgress {
    UserMessage {
        message_id: MessageId,
        speaker_id: Identifier,
        speaker_name: SpeakerName,
        text: VisibleText,
        source: ClientStamp,
        client_message_id: ClientStamp,
    },
    VisibleReply {
        message_id: MessageId,
        speaker_id: Identifier,
        speaker_name: SpeakerName,
        text: VisibleText,
        /// The draft this message replaces.
        draft_id: String,
    },
    ToolCallsRequested {
        round: NonZeroU32,
        tool_names: Vec<Identifier>,
    },
    ToolCallCompleted {
        round: NonZeroU32,
        status: ToolCallStatus,
        tool_name: Identifier,
    },
}

/// How a call of a round came back: as its plugin answered, or refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Accepted,
    Rejected,
}

/// A turn as it runs: the line that started it, her character, and her
/// drafts so far, each its whole text, in the order they opened.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunningTurn {
    pub character_id: Identifier,
    pub conversation_id: ConversationId,
    pub source: ClientStamp,
    pub client_message_id: ClientStamp,
    pub drafts: Vec<RunningDraft>,
}

/// A reply she is still writing: its text so far, under its draft's id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunningDraft {
    pub draft_id: String,
    pub text: String,
}

/// The first frame of a stream that cannot be caught up: the state every
/// later frame moves on from.
#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "GatewayReady")]
#[schemars(rename = "GatewayReady")]
pub struct Ready {
    pub protocol_version: ProtocolVersion,
    pub health: Health,
    pub confirmations: Vec<PendingConfirmation>,
    pub pairings: Vec<PairingRequest>,
    pub turns: Vec<RunningTurn>,
}
