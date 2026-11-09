//! What the daemon answers and announces: the wire contract's source, in
//! the field names and the vocabulary the page, the clients and the
//! conformance suite read.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::num::NonZeroU32;

use p02_characters::{PackageDiagnostic, PackageLocation, PackageProblem};
use p02_config::{Diagnostic, Severity};
use p02_contracts::vocabulary;
use p02_core::{
    ClientStamp, ConversationId, MessageId, SpeakerName, Timestamp, VisibleMessage,
    VisibleMessageRole, VisibleText,
};
use p02_runtime::Progress;
use p02_shared::{Identifier, error_sentence};
use p02_store::StorageError;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::character::CharacterState;
use crate::confirmation::{Answer, ConfirmationId};

/// The protocol a client reads, which health carries so that an old client
/// meets a clear message rather than a mystery.
pub const PROTOCOL_VERSION: u32 = 7;

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

/// What became of a delivered line.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TurnOutcome {
    Completed {
        character_id: Identifier,
        conversation_id: ConversationId,
        /// What the turn committed, the person's line first.
        messages: Vec<TurnMessage>,
    },
    /// The turn ended refused; `committed` says whether its line is in the
    /// log.
    Rejected {
        character_id: Identifier,
        conversation_id: ConversationId,
        reason: String,
        message: String,
        committed: bool,
    },
    /// Refused before any turn ran.
    Refused {
        reason: TurnRefusal,
        message: String,
    },
    /// The runtime failed the turn; `committed` says whether its line is in
    /// the log.
    Failed {
        character_id: Identifier,
        conversation_id: ConversationId,
        message: String,
        committed: bool,
    },
}

impl TurnOutcome {
    /// Whether the turn put its line in the log, which a surface holding the
    /// line waits to know. A duplicate is the one refusal whose line is
    /// there already: a run before this one took it.
    pub(crate) fn committed(&self) -> bool {
        match self {
            Self::Completed { .. } => true,
            Self::Rejected { committed, .. } | Self::Failed { committed, .. } => *committed,
            Self::Refused { reason, .. } => *reason == TurnRefusal::DuplicateSubmission,
        }
    }

    pub(crate) fn refused(reason: TurnRefusal, message: String) -> Self {
        Self::Refused { reason, message }
    }
}

vocabulary! {
    /// Why a line was refused before any turn ran.
    #[ts(rename = "GatewayRefusalReason")]
    #[schemars(rename = "GatewayRefusalReason")]
    TurnRefusal {
        UnknownCharacter = "unknown_character",
        UnknownConversation = "unknown_conversation",
        /// The conversation's record could not be read; the message says why.
        ConversationUnreadable = "conversation_unreadable",
        SenderNotSupported = "sender_not_supported",
        CharacterUnavailable = "character_unavailable",
        InvalidMessage = "invalid_message",
        DuplicateSubmission = "duplicate_submission",
    }
}

/// A committed message as a client renders it.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "GatewayVisibleMessage")]
#[schemars(rename = "GatewayVisibleMessage")]
pub struct TurnMessage {
    pub message_id: MessageId,
    pub speaker_id: Identifier,
    pub speaker_name: SpeakerName,
    pub text: VisibleText,
}

impl From<VisibleMessage> for TurnMessage {
    fn from(message: VisibleMessage) -> Self {
        Self {
            message_id: message.id,
            speaker_id: message.speaker_id,
            speaker_name: message.speaker_name,
            text: message.text,
        }
    }
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
        /// Who the caller is in the thread: the sender a delivery names.
        user_participant_id: Identifier,
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
    UnknownCharacter,
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

/// Who a reconcile pass started, stopped and reloaded.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcilePlan {
    pub starting: Vec<Identifier>,
    pub stopping: Vec<Identifier>,
    pub reloading: Vec<Identifier>,
}

impl ReconcilePlan {
    /// This plan and the one after it, each character named once.
    pub(crate) fn merge(&mut self, next: Self) {
        for (names, more) in [
            (&mut self.starting, next.starting),
            (&mut self.stopping, next.stopping),
            (&mut self.reloading, next.reloading),
        ] {
            for id in more {
                if !names.contains(&id) {
                    names.push(id);
                }
            }
        }
    }
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
    Reloading,
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
            Some(CharacterState::Reloading) => Self::Reloading,
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
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct PackageReport {
    /// Always an error: the package is not in the roster.
    pub severity: Severity,
    pub code: String,
    pub message: String,
    pub path: String,
    pub provenance: PackageProvenance,
    /// The folder the package was found in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character_id: Option<String>,
    /// The id its descriptor claims, when that is not its folder's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_character_id: Option<Identifier>,
}

impl From<&PackageDiagnostic> for PackageReport {
    fn from(diagnostic: &PackageDiagnostic) -> Self {
        let (path, provenance) = match &diagnostic.location {
            PackageLocation::Bundled => ("bundled".to_owned(), PackageProvenance::Bundled),
            PackageLocation::Home(path) => {
                (path.display().to_string(), PackageProvenance::Operator)
            }
        };

        Self {
            severity: Severity::Error,
            code: diagnostic.problem.code().to_owned(),
            // As a refused start embeds it, so the one reads in the other.
            message: diagnostic.problem.to_string(),
            path,
            provenance,
            character_id: diagnostic.folder.clone(),
            claimed_character_id: match &diagnostic.problem {
                PackageProblem::IdMismatch { claimed } => Some(claimed.clone()),
                _ => None,
            },
        }
    }
}

/// Where a package comes from: compiled in, or added by the person.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PackageProvenance {
    Bundled,
    Operator,
}

/// Whether a process of a built-in connector is on the event stream now.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
pub struct ConnectorPresence {
    pub id: Identifier,
    pub connected: bool,
}

/// A turn in progress, as the stream has told it so far: the submission it
/// runs for, its character, and each open draft's text.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunningTurn {
    pub character_id: Identifier,
    pub conversation_id: ConversationId,
    pub source: ClientStamp,
    pub client_message_id: ClientStamp,
    pub drafts: Vec<RunningDraft>,
}

/// One open draft: the reply's text so far under its id.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunningDraft {
    pub draft_id: String,
    pub text: String,
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
    InvalidSubject,
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
    /// A turn's progress: each message once it is durable, and a reply's
    /// draft before its commit, which its kind marks as such.
    TurnProgress {
        character_id: Identifier,
        conversation_id: ConversationId,
        progress: TurnProgress,
    },
    /// How a delivery ended, with its submission's stamps, so that a surface
    /// knows whose turn ended and whether its line is in the log.
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

impl Event {
    /// How `outcome` ended the delivery `stamp` made to `character`.
    pub(crate) fn turn_completed(
        character: Identifier,
        stamp: TurnStamp,
        outcome: &TurnOutcome,
    ) -> Self {
        let committed = outcome.committed();
        let (status, reason, message) = match outcome {
            TurnOutcome::Completed { .. } => (TurnStatus::Completed, None, None),
            TurnOutcome::Rejected {
                reason, message, ..
            } => (
                TurnStatus::Rejected,
                Some(reason.clone()),
                Some(message.clone()),
            ),
            TurnOutcome::Refused { reason, message } => (
                TurnStatus::Refused,
                Some(reason.as_str().to_owned()),
                Some(message.clone()),
            ),
            TurnOutcome::Failed { message, .. } => {
                (TurnStatus::Failed, None, Some(message.clone()))
            }
        };

        Self::TurnCompleted {
            character_id: character,
            conversation_id: stamp.conversation_id,
            source: stamp.source,
            client_message_id: stamp.client_message_id,
            status,
            committed,
            reason,
            message,
        }
    }
}

/// How a delivery ended, as the frame announcing it says: the status of
/// its outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Completed,
    Rejected,
    Refused,
    Failed,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<ClientStamp>,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_message_id: Option<ClientStamp>,
    },
    VisibleReply {
        message_id: MessageId,
        speaker_id: Identifier,
        speaker_name: SpeakerName,
        text: VisibleText,
        /// The draft this message replaces.
        draft_id: String,
    },
    ReplyDelta {
        draft_id: String,
        text: String,
    },
    ReplyWithdrawn {
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

impl From<Progress> for TurnProgress {
    fn from(progress: Progress) -> Self {
        match progress {
            Progress::UserMessage {
                message,
                source,
                client_message_id,
            } => Self::UserMessage {
                message_id: message.id,
                speaker_id: message.speaker_id,
                speaker_name: message.speaker_name,
                text: message.text,
                source,
                client_message_id,
            },
            Progress::VisibleReply { message, draft } => Self::VisibleReply {
                message_id: message.id,
                speaker_id: message.speaker_id,
                speaker_name: message.speaker_name,
                text: message.text,
                draft_id: draft.to_string(),
            },
            Progress::ReplyDelta { draft, text } => Self::ReplyDelta {
                draft_id: draft.to_string(),
                text,
            },
            Progress::ReplyWithdrawn { draft } => Self::ReplyWithdrawn {
                draft_id: draft.to_string(),
            },
            Progress::ToolCallsRequested { round, tool_names } => {
                Self::ToolCallsRequested { round, tool_names }
            }
            Progress::ToolCallCompleted {
                round,
                tool_name,
                accepted,
            } => Self::ToolCallCompleted {
                round,
                status: if accepted {
                    ToolCallStatus::Accepted
                } else {
                    ToolCallStatus::Rejected
                },
                tool_name,
            },
        }
    }
}

/// The turns in progress, folded from the events in the order they were
/// announced: a turn begins at the stamped line that names its submission,
/// each delta extends a draft, a draft ends at its commit or its
/// withdrawal, and the turn ends at the completion that names the same
/// submission, never at another's, since a submission refused on the spot
/// completes while the turn ahead of it still runs. A conversation runs one
/// turn at a time. The one definition of a running turn: what a surface
/// that had heard every event would hold.
#[derive(Clone, Debug, Default)]
pub struct RunningTurns(BTreeMap<ConversationId, RunningTurn>);

/// The turns a snapshot carries, from which a surface folds on.
impl FromIterator<RunningTurn> for RunningTurns {
    fn from_iter<I: IntoIterator<Item = RunningTurn>>(turns: I) -> Self {
        Self(
            turns
                .into_iter()
                .map(|turn| (turn.conversation_id.clone(), turn))
                .collect(),
        )
    }
}

impl RunningTurns {
    pub fn fold(&mut self, event: &Event) {
        match event {
            Event::TurnProgress {
                character_id,
                conversation_id,
                progress,
            } => self.progressed(character_id, conversation_id, progress),
            Event::TurnCompleted {
                conversation_id,
                source,
                client_message_id,
                ..
            } => {
                let ends = self.0.get(conversation_id).is_some_and(|turn| {
                    turn.source == *source && turn.client_message_id == *client_message_id
                });

                if ends {
                    self.0.remove(conversation_id);
                }
            }
            _ => {}
        }
    }

    fn progressed(
        &mut self,
        character: &Identifier,
        conversation: &ConversationId,
        progress: &TurnProgress,
    ) {
        match progress {
            TurnProgress::UserMessage {
                source: Some(source),
                client_message_id: Some(client_message_id),
                ..
            } => {
                self.0.insert(
                    conversation.clone(),
                    RunningTurn {
                        character_id: character.clone(),
                        conversation_id: conversation.clone(),
                        source: source.clone(),
                        client_message_id: client_message_id.clone(),
                        drafts: Vec::new(),
                    },
                );
            }
            TurnProgress::ReplyDelta { draft_id, text } => {
                let Some(turn) = self.0.get_mut(conversation) else {
                    return;
                };

                match turn
                    .drafts
                    .iter_mut()
                    .find(|draft| draft.draft_id == *draft_id)
                {
                    Some(draft) => draft.text.push_str(text),
                    None => turn.drafts.push(RunningDraft {
                        draft_id: draft_id.clone(),
                        text: text.clone(),
                    }),
                }
            }
            TurnProgress::VisibleReply { draft_id, .. }
            | TurnProgress::ReplyWithdrawn { draft_id } => {
                if let Some(turn) = self.0.get_mut(conversation) {
                    turn.drafts.retain(|draft| draft.draft_id != *draft_id);
                }
            }
            TurnProgress::UserMessage { .. }
            | TurnProgress::ToolCallsRequested { .. }
            | TurnProgress::ToolCallCompleted { .. } => {}
        }
    }

    #[must_use]
    pub fn turns(&self) -> Vec<RunningTurn> {
        self.0.values().cloned().collect()
    }

    /// The turn running in `conversation`, if one is.
    #[must_use]
    pub fn get(&self, conversation: &ConversationId) -> Option<&RunningTurn> {
        self.0.get(conversation)
    }
}
