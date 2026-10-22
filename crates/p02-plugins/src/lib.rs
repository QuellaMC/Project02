#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod before_call;
mod boundary;
mod character_memory;
mod character_state;
mod config_control;
mod confirmation;
mod demo_config;
mod health;
mod host;
mod invoke;
mod lifecycle;
pub mod list;
mod management;
pub mod mem0;
mod package;
mod policy;
pub mod session_history;
mod text;
mod tool_call;
mod turn;

pub use before_call::{BeforeCallOutcome, PreparedContext, TurnRejection};
pub use boundary::RecordLabelsError;
pub use config_control::{
    ActivationStatus, ConfigControl, FieldChange, FieldChangeOutcome, PluginSettings,
    ReadConfigError, Rebuild,
};
pub use confirmation::{ConfirmationDecision, ConfirmationRequest, Confirmer};
pub use health::{HealthCheck, HealthRejection};
pub use host::{ActivationError, BuildPluginError, PluginHost, PluginHostBuilder, ReloadError};
pub use lifecycle::{HookPhaseReport, PhaseStatus};
pub use tool_call::{ProposedToolCall, ToolCallReport};
pub use turn::Turn;
