#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod before_call;
mod boundary;
mod confirmation;
mod health;
mod host;
mod invoke;
mod lifecycle;
mod policy;
pub mod session_history;
mod text;
mod tool_call;
mod turn;

pub use before_call::{BeforeCallOutcome, PreparedContext, TurnRejection};
pub use confirmation::{ConfirmationDecision, ConfirmationRequest, Confirmer};
pub use health::{HealthCheck, HealthRejection};
pub use host::{ActivationError, PluginHost, PluginHostBuilder, ReloadError};
pub use lifecycle::{HookPhaseReport, PhaseStatus};
pub use tool_call::ToolCallReport;
pub use turn::Turn;
