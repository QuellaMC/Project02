use std::fmt;

use async_trait::async_trait;
use p02_contracts::{ToolCallId, TurnIdentity};
use p02_shared::Identifier;
use serde_json::{Map, Value};

/// Asks the person whether an approval-gated tool call may run. The host's
/// caller supplies it, and how long a question waits is its own to decide;
/// the host stops waiting when the turn is abandoned. Without one, no
/// approval-gated tool is offered.
#[async_trait]
pub trait Confirmer: Send + Sync + fmt::Debug {
    async fn confirm(&self, request: ConfirmationRequest) -> ConfirmationDecision;
}

/// One question for the person: which turn raised it, the plugin and tool
/// that would run, what the tool says it does, and the input it would run
/// with, credential-named values redacted.
#[derive(Clone, Debug, PartialEq)]
pub struct ConfirmationRequest {
    pub turn: TurnIdentity,
    pub plugin_id: Identifier,
    pub tool_name: Identifier,
    pub call_id: ToolCallId,
    pub summary: String,
    pub input: Map<String, Value>,
}

/// The person's answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfirmationDecision {
    Approved,
    Denied,
    /// Nobody answered: the question expired, or its character stopped.
    Cancelled,
}
