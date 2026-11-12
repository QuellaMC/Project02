#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod apps;
mod bots;
mod chatgpt;
mod config;
mod confirmation;
mod conversation;
mod diagnostic;
mod event;
mod health;
mod packages;
mod pairing;
mod phone;
mod protocol;
mod refusal;
mod text;

pub use apps::{
    AppInstallOutcome, AppInstallRefusal, AppPreviewOutcome, AppRemoveOutcome, AppRemoveRefusal,
    AppWakeBody, AppWakeOutcome, AppWakeRefusal, StoreApp, StoreAppStatus, StoreOutcome,
};
pub use bots::{
    BotState, ConnectorBot, ConnectorBotsBody, ConnectorBotsOutcome, ConnectorBotsRefusal,
};
pub use chatgpt::{ChatgptOutcome, ChatgptSignIn};
pub use config::{
    AccessLevel, AccessName, ActivationStatus, Authored, ChangeOutcome, ChangeRefusal,
    CharacterConnectorEntry, ConfigChange, ConfigTarget, ConfigValueType, ConfigView,
    ConnectorConfigView, ConnectorEntry, ConnectorRefusal, EffectiveView, FieldView, LayoutCard,
    LayoutRow, LayoutWhen, ModelService, Namespace, Operation, Placement, PlanAccount, PluginPage,
    RoleModelProvider, SectionActivation, SectionView, Setup, Source, ValueSource, ViewRefusal,
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
    PackageReport, PackagesHealth, PersonAccount, RosterState, StartOutcome, StartRefusal,
};
pub use packages::{
    AddCharacterOutcome, AddCharacterRefusal, CharacterFeature, CharacterInstalled,
    CharacterPreviewOutcome, CharacterPreviewRefusal, RemoveCharacterOutcome,
    RemoveCharacterRefusal,
};
pub use pairing::{
    PairingAnswer, PairingDecision, PairingOutcome, PairingRefusal, PairingRequest,
    PairingRequestBody, PairingSubject, PairingSubjectBody,
};
pub use phone::{
    AppAccount, AppSource, AppView, LiveReading, PhoneApp, PhoneDid, PhoneFront, PhoneOutcome,
    PhoneRefusal, PhoneRing, Screen, ScreenCell, ScreenItem, ScreenOutcome, ScreenRange,
    ScreenRefusal, ScreenRow, ScreenTile,
};
pub use protocol::{PROTOCOL_VERSION, ProtocolVersion};
pub use refusal::{ErrorBody, Refusal};
pub use text::{BotUsername, ParseBotUsernameError, ParseShortError, ParseTextError, Short, Text};
