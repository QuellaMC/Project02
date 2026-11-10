#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod bots;
mod config;
mod confirmation;
mod conversation;
mod diagnostic;
mod event;
mod health;
mod pairing;
mod protocol;
mod refusal;
mod text;

pub use bots::{
    BotState, ConnectorBot, ConnectorBotsBody, ConnectorBotsOutcome, ConnectorBotsRefusal,
};
pub use config::{
    AccessLevel, AccessName, ActivationStatus, Authored, ChangeOutcome, ChangeRefusal,
    CharacterConnectorEntry, ConfigChange, ConfigTarget, ConfigValueType, ConfigView,
    ConnectorConfigView, ConnectorEntry, ConnectorRefusal, EffectiveView, FieldView, LayoutCard,
    LayoutRow, LayoutWhen, Namespace, Operation, Placement, PluginPage, SectionActivation,
    SectionView, Setup, Source, ValueSource, ViewRefusal,
};
pub use confirmation::{
    Answer, AnswerBody, CancelReason, ConfirmationAnswer, ConfirmationId, ConfirmationQuestion,
    PendingConfirmation, Settlement, TurnStamp,
};
pub use conversation::{
    GatewayMessage, HistoryMessage, HistoryOutcome, HistoryRefusal, OpenConversationBody,
    OpenOutcome, OpenRefusal, StorageFailure, SubmitOutcome, TurnRefusal,
};
pub use diagnostic::{Code, Diagnostic, Severity};
pub use event::{
    Event, Ready, RunningDraft, RunningTurn, ToolCallStatus, TurnProgress, TurnStatus,
};
pub use health::{
    CharacterState, CharacterSummary, ConfigHealth, ConnectorPresence, Health, MaintenanceFailure,
    PackageReport, PackagesHealth, RosterState, StartOutcome, StartRefusal,
};
pub use pairing::{
    PairingAnswer, PairingDecision, PairingOutcome, PairingRefusal, PairingRequest,
    PairingRequestBody, PairingSubject, PairingSubjectBody,
};
pub use protocol::{PROTOCOL_VERSION, ProtocolVersion};
pub use refusal::{ErrorBody, Refusal};
pub use text::{BotUsername, ParseBotUsernameError, ParseShortError, ParseTextError, Short, Text};
