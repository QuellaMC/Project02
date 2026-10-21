#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod character;
mod config_control;
mod confirmation;
mod daemon;
mod history;
mod outcome;
mod reconcile;
mod submissions;

pub use character::CharacterState;
pub use confirmation::{Answer, ConfirmationId};
pub use daemon::{Daemon, DaemonSettings, Durations, Message, OpenDaemonError, Plugin, Presence};
pub use history::HistoryPage;
pub use outcome::{
    CancelReason, CharacterSummary, ConfigHealth, ConfirmationAnswer, ConfirmationQuestion,
    ConnectorPresence, Event, Health, HistoryMessage, HistoryOutcome, HistoryRefusal,
    MaintenanceFailure, OpenOutcome, OpenRefusal, PROTOCOL_VERSION, PackageReport, PackagesHealth,
    PendingConfirmation, ReconcilePlan, RunningDraft, RunningTurn, Settlement, StartOutcome,
    StartRefusal, StorageFailure, TurnMessage, TurnOutcome, TurnProgress, TurnRefusal, TurnStamp,
};
