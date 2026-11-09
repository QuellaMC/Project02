#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

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

pub use config::{
    ActivationStatus, Authored, ChangeOutcome, ChangeRefusal, CharacterConnectorEntry,
    ConfigChange, ConfigTarget, ConfigValueType, ConfigView, ConnectorConfigView, ConnectorEntry,
    ConnectorRefusal, EffectiveView, FieldView, Namespace, Operation, SectionActivation,
    SectionView, Source, ValueSource, ViewRefusal,
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
pub use text::{ParseShortError, ParseTextError, Short, Text};
