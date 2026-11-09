//! What the daemon answers and announces: the wire contract's source, in
//! the field names and the vocabulary the page, the clients and the
//! conformance suite read.

use std::borrow::Cow;
use std::num::NonZeroU32;

use p02_characters::{PackageDiagnostic, PackageLocation};
use p02_config::Diagnostic;
use p02_contracts::vocabulary;
use p02_core::{
    ClientStamp, ConversationId, MessageId, SpeakerName, Timestamp, VisibleMessageRole, VisibleText,
};
use p02_runtime::Progress;
use p02_shared::{Identifier, error_sentence};
use p02_store::{QueuedLine, StorageError};
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::character::CharacterState;
use crate::confirmation::{Answer, ConfirmationId};

/// The protocol a client reads, which health carries so that an old client
/// meets a clear message rather than a mystery.
pub const PROTOCOL_VERSION: u32 = 8;

/// [`PROTOCOL_VERSION`] as health and a stream's first frame carry it: the
/// one value either can say, which the contract declares as that number,
/// so a client whose own version is another does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtocolVersion;

impl Serialize for ProtocolVersion {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u32(PROTOCOL_VERSION)
    }
}

/// Reads the one number it is: another version is another wire.
impl<'de> Deserialize<'de> for ProtocolVersion {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let version = u32::deserialize(deserializer)?;

        if version == PROTOCOL_VERSION {
            Ok(Self)
        } else {
            Err(D::Error::custom(format!(
                "protocol {version} is not protocol {PROTOCOL_VERSION}"
            )))
        }
    }
}

impl JsonSchema for ProtocolVersion {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "ProtocolVersion".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({"const": PROTOCOL_VERSION})
    }
}

impl TS for ProtocolVersion {
    type WithoutGenerics = Self;
    type OptionInnerType = Self;

    fn name(_: &ts_rs::Config) -> String {
        PROTOCOL_VERSION.to_string()
    }

    fn inline(config: &ts_rs::Config) -> String {
        Self::name(config)
    }
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

/// What a line sent again once a turn took it is refused with: the
/// message it was committed as.
pub(crate) fn duplicate(client_message_id: &ClientStamp, message_id: &MessageId) -> String {
    format!(
        "clientMessageId \"{client_message_id}\" is already on this conversation as message \
         {message_id}; read the thread for its reply."
    )
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

/// An ordinary failure of the home's storage, a full disk, a permission or
/// a damaged record, which the person is told and which is no bug.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
pub struct StorageFailure {
    pub code: String,
    pub message: String,
}

impl StorageFailure {
    pub(crate) fn of(error: &StorageError) -> Self {
        Self {
            code: error.code().to_owned(),
            message: error_sentence(error),
        }
    }
}

/// What an explicit start came to: `settled` says it ran, and the summary's
/// state says how it ended.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum StartOutcome {
    Settled {
        character: CharacterSummary,
    },
    Refused {
        reason: StartRefusal,
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum StartRefusal {
    UnknownCharacter,
    GatewayStopped,
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

/// One installed character, as health reports her.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct CharacterSummary {
    pub id: Identifier,
    pub display_name: SpeakerName,
    pub enabled: bool,
    pub state: RosterState,
    /// Why she failed, or what her start warned of.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    /// The latest background failure since she started.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maintenance: Option<MaintenanceFailure>,
}

/// Where an installed character stands as health reports her: her
/// runtime's state, or `not_started` until the daemon built it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum RosterState {
    NotStarted,
    Starting,
    Ready,
    Stopping,
    Stopped,
    Failed,
}

impl From<Option<CharacterState>> for RosterState {
    fn from(state: Option<CharacterState>) -> Self {
        match state {
            None => Self::NotStarted,
            Some(CharacterState::Starting) => Self::Starting,
            Some(CharacterState::Ready) => Self::Ready,
            Some(CharacterState::Stopping) => Self::Stopping,
            Some(CharacterState::Stopped) => Self::Stopped,
            Some(CharacterState::Failed) => Self::Failed,
        }
    }
}

/// A background failure the conversation never sees: the plugins' work
/// after a turn's commit, a segment rotation that failed, which the next
/// turn plans again, what closing a segment left undone, or what opening
/// her thread skipped because it could not be read.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
pub struct MaintenanceFailure {
    pub at: Timestamp,
    pub message: String,
}

/// The daemon's whole state in one read.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "GatewayHealth")]
#[schemars(rename = "GatewayHealth")]
pub struct Health {
    pub protocol_version: ProtocolVersion,
    pub home_root: String,
    /// What the home's settings document says of itself.
    pub config: ConfigHealth,
    /// The packages discovery could not publish, which the roster lacks.
    pub packages: PackagesHealth,
    pub characters: Vec<CharacterSummary>,
    pub connectors: Vec<ConnectorPresence>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
pub struct ConfigHealth {
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
pub struct PackagesHealth {
    pub diagnostics: Vec<PackageReport>,
}

/// A package discovery could not publish, and why, where.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
pub struct PackageReport {
    pub message: String,
    pub path: String,
}

impl From<&PackageDiagnostic> for PackageReport {
    fn from(diagnostic: &PackageDiagnostic) -> Self {
        Self {
            // As a refused start embeds it, so the one reads in the other.
            message: diagnostic.problem.to_string(),
            path: match &diagnostic.location {
                PackageLocation::Bundled => "bundled".to_owned(),
                PackageLocation::Home(path) => path.display().to_string(),
            },
        }
    }
}

/// Whether a process of a built-in connector is on the event stream now.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
pub struct ConnectorPresence {
    pub id: Identifier,
    pub connected: bool,
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

impl RunningTurn {
    /// The turn of `line` on `character`, before anything of it is told.
    pub(crate) fn of(character: Identifier, line: &QueuedLine) -> Self {
        Self {
            character_id: character,
            conversation_id: line.conversation_id.clone(),
            source: line.source.clone(),
            client_message_id: line.client_message_id.clone(),
            drafts: Vec::new(),
        }
    }

    /// What the stream is told of `progress`, in order: the message or the
    /// tool calls it says, then the turn as it now runs when that changed.
    /// A commit comes before the turn without its draft, so a surface that
    /// shows the draft ends it as the message rather than taking it back.
    pub(crate) fn told(&mut self, progress: Progress) -> Vec<Event> {
        let (said, changed) = match progress {
            Progress::UserMessage {
                message,
                source,
                client_message_id,
            } => (
                Some(TurnProgress::UserMessage {
                    message_id: message.id,
                    speaker_id: message.speaker_id,
                    speaker_name: message.speaker_name,
                    text: message.text,
                    source,
                    client_message_id,
                }),
                true,
            ),
            Progress::VisibleReply { message, draft } => {
                let draft_id = draft.to_string();

                self.drafts.retain(|open| open.draft_id != draft_id);
                (
                    Some(TurnProgress::VisibleReply {
                        message_id: message.id,
                        speaker_id: message.speaker_id,
                        speaker_name: message.speaker_name,
                        text: message.text,
                        draft_id,
                    }),
                    true,
                )
            }
            Progress::ReplyDelta { draft, text } => {
                let draft_id = draft.to_string();

                match self
                    .drafts
                    .iter_mut()
                    .find(|open| open.draft_id == draft_id)
                {
                    Some(open) => open.text.push_str(&text),
                    None => self.drafts.push(RunningDraft { draft_id, text }),
                }

                (None, true)
            }
            Progress::ReplyWithdrawn { draft } => {
                let draft_id = draft.to_string();

                self.drafts.retain(|open| open.draft_id != draft_id);
                (None, true)
            }
            Progress::ToolCallsRequested { round, tool_names } => (
                Some(TurnProgress::ToolCallsRequested { round, tool_names }),
                false,
            ),
            Progress::ToolCallCompleted {
                round,
                tool_name,
                accepted,
            } => (
                Some(TurnProgress::ToolCallCompleted {
                    round,
                    status: if accepted {
                        ToolCallStatus::Accepted
                    } else {
                        ToolCallStatus::Rejected
                    },
                    tool_name,
                }),
                false,
            ),
        };

        said.map(|progress| Event::TurnProgress {
            character_id: self.character_id.clone(),
            conversation_id: self.conversation_id.clone(),
            progress,
        })
        .into_iter()
        .chain(changed.then(|| Event::TurnRunning(self.clone())))
        .collect()
    }
}

/// An account a connector asks to let in, waiting for the person's answer
/// under a code any surface shows and answers by, until it expires.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PairingRequest {
    pub connector_id: Identifier,
    /// Six digits, unique among the requests waiting.
    pub code: String,
    pub subject: PairingSubject,
    /// The connector's endpoint the account first wrote to, as the stamp
    /// its lines will carry: for Telegram, `telegram:<bot username>`.
    pub source: ClientStamp,
    pub requested_at: Timestamp,
    /// When the request expires, in milliseconds since the Unix epoch.
    pub expires_at: i64,
}

/// The account a pairing is for: the connector's own id for it, and the
/// name the person sees.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct PairingSubject {
    pub id: ClientStamp,
    pub label: SpeakerName,
}

/// What came of a connector's request to let an account in. `paired`: the
/// home lets it in already, so nothing is asked.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(rename = "PairingRequestOutcome")]
#[schemars(rename = "PairingRequestOutcome")]
pub enum PairingOutcome {
    Pending {
        request: PairingRequest,
    },
    Paired,
    Refused {
        reason: PairingRefusal,
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PairingRefusal {
    UnknownConnector,
    ConfigUnloadable,
}

/// What an answer to a pairing request came to. `expired`: the deadline had
/// passed, so the request was settled expired instead, as a confirmation
/// is; `failed`: the approval could not be written, and the request waits
/// on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(rename = "PairingSettleOutcome")]
#[schemars(rename = "PairingSettleOutcome")]
pub enum PairingAnswer {
    Settled { decision: Answer },
    Expired,
    Unknown,
    Failed { message: String },
}

/// How a pairing request ended: with the person's answer, or at its
/// deadline.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PairingDecision {
    Approved,
    Denied,
    Expired,
}

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
        /// Present when a failure caused the change.
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
