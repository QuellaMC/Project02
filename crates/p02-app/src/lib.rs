#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod character;
mod config_control;
mod confirmation;
mod daemon;
mod history;
mod outcome;
mod pairing;
mod reconcile;
mod submissions;

pub use character::CharacterState;
pub use confirmation::{Answer, ConfirmationId};
pub use daemon::{Daemon, DaemonSettings, Durations, Message, OpenDaemonError, Plugin, Presence};
pub use history::HistoryPage;
pub use outcome::{
    CancelReason, CharacterSummary, ConfigHealth, ConfirmationAnswer, ConfirmationQuestion,
    ConnectorPresence, Event, Health, HistoryMessage, HistoryOutcome, HistoryRefusal,
    MaintenanceFailure, OpenOutcome, OpenRefusal, PROTOCOL_VERSION, PackageProvenance,
    PackageReport, PackagesHealth, PairingAnswer, PairingDecision, PairingOutcome, PairingRefusal,
    PairingRequest, PairingSubject, PendingConfirmation, ProtocolVersion, ReconcilePlan,
    RosterState, RunningDraft, RunningTurn, RunningTurns, Settlement, StartOutcome, StartRefusal,
    StorageFailure, ToolCallStatus, TurnMessage, TurnOutcome, TurnProgress, TurnRefusal, TurnStamp,
    TurnStatus,
};
