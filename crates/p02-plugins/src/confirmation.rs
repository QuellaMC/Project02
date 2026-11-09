use std::fmt;

use async_trait::async_trait;
use p02_contracts::ToolCallId;
use p02_shared::Identifier;
use serde_json::{Map, Value};

/// Asks the person whether a prepared approval-gated call may take effect.
/// The host's caller supplies it, and how long a question waits is its own
/// to decide; the host stops waiting when the turn is abandoned.
#[async_trait]
pub trait Confirmer: Send + Sync + fmt::Debug {
    async fn confirm(&self, request: ConfirmationRequest) -> ConfirmationDecision;
}

/// One question for the person: the plugin and tool whose call it is,
/// what the tool says it does, and what the call would do as its plugin
/// prepared it, credential-named values redacted.
#[derive(Clone, Debug, PartialEq)]
pub struct ConfirmationRequest {
    pub plugin_id: Identifier,
    pub tool_name: Identifier,
    pub call_id: ToolCallId,
    pub summary: String,
    pub preview: Map<String, Value>,
}

/// The person's answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfirmationDecision {
    Approved,
    Denied,
    /// Nobody answered: the question expired, or its character stopped.
    Cancelled,
}
