//! The event stream: what every surface hears, a turn as it runs, and the
//! snapshot a stream that cannot be caught up begins with.

use std::num::NonZeroU32;

use p02_core::{ClientStamp, ConversationId, MessageId, SpeakerName, Timestamp, VisibleText};
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
    /// A turn as it runs now, said whenever that changes, until the
    /// completion that ends it: from the commit of the line that began it,
    /// or from its beginning for a turn of her own.
    TurnRunning(RunningTurn),
    /// How a turn ended, with the stamps of the line that began it, both or
    /// neither, so that a surface knows whose turn ended and whether its
    /// line is in the log.
    TurnCompleted {
        character_id: Identifier,
        conversation_id: ConversationId,
        /// Absent for a turn of her own, which no line began.
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<ClientStamp>,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_message_id: Option<ClientStamp>,
        status: TurnStatus,
        /// Whether the line that began it is in the log; true for a turn of
        /// her own, which has none: nothing of the person's waits on it.
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
    /// before the pass that acts on them, when a connector came onto the
    /// stream or left it, and when the home's sign-in to a ChatGPT plan
    /// changed: a wait began, or ended signed in, failed or called off, or
    /// the person signed out.
    HealthChanged {
        health: Health,
    },
    MaintenanceFailed {
        character_id: Identifier,
        #[serde(flatten)]
        failure: MaintenanceFailure,
    },
    /// Her phone is to be read again: a call of hers to it came back
    /// accepted, a ring's moment of hers began or ended, or the person gave
    /// her an app, removed one, said whether one may wake her or how one is
    /// signed in, or read a message of hers.
    PhoneChanged {
        character_id: Identifier,
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
    /// Whether this ends `turn`: its completion, never another turn's.
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
        sent_at: Timestamp,
        /// When she read it: the moment her turn took it.
        read_at: Timestamp,
        /// The id of the app the line came in, as `messages` or `telegram`.
        app: String,
        source: ClientStamp,
        client_message_id: ClientStamp,
    },
    VisibleReply {
        message_id: MessageId,
        speaker_id: Identifier,
        speaker_name: SpeakerName,
        text: VisibleText,
        sent_at: Timestamp,
        /// The id of the app it went in, as `messages` or `telegram`.
        app: String,
    },
    ToolCallsRequested {
        round: NonZeroU32,
        tool_names: Vec<Identifier>,
    },
    ToolCallCompleted {
        round: NonZeroU32,
        status: ToolCallStatus,
        /// The plugin that provides the tool, or `undeclared.<tool>` for a
        /// tool the turn did not offer.
        plugin_id: Identifier,
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

/// A turn as it runs: her character, her thread, the stamps of the line
/// that began it, both or neither, and whether she is writing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct RunningTurn {
    pub character_id: Identifier,
    pub conversation_id: ConversationId,
    /// Absent for a turn of her own, which no line began.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ClientStamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<ClientStamp>,
    /// Whether a round of hers is under way: from its request to her model
    /// until its answer is judged and what it said is committed. Never
    /// while her tools run, the plugins prepare or the work after her turn
    /// goes on.
    pub writing: bool,
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
