use std::num::NonZeroU32;

use p02_contracts::{ConversationToolCall, Evidence, ToolCallId, ToolCallResult};
use p02_shared::Identifier;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A tool call a round made, recorded before it runs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallStarted {
    round: NonZeroU32,
    tool_call_id: ToolCallId,
    tool_name: Identifier,
    tool_plugin_id: Identifier,
    tool_input: Map<String, Value>,
}

/// A tool call that came back.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallFinished {
    round: NonZeroU32,
    tool_call_id: ToolCallId,
    tool_name: Identifier,
    tool_plugin_id: Identifier,
    tool_result: ToolCallResult,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    runtime_plugin_evidence: Vec<Evidence>,
}

impl ToolCallStarted {
    /// Call `tool_call_id` of round `round`, of `tool_name`, which
    /// `tool_plugin_id` answers, with `tool_input` kept as its session keeps
    /// a call's input.
    #[must_use]
    pub fn new(
        round: NonZeroU32,
        tool_call_id: ToolCallId,
        tool_name: Identifier,
        tool_plugin_id: Identifier,
        tool_input: Map<String, Value>,
    ) -> Self {
        Self {
            round,
            tool_call_id,
            tool_name,
            tool_plugin_id,
            tool_input: ConversationToolCall::kept_input(tool_input),
        }
    }

    #[must_use]
    pub fn round(&self) -> NonZeroU32 {
        self.round
    }

    #[must_use]
    pub fn tool_call_id(&self) -> &ToolCallId {
        &self.tool_call_id
    }

    #[must_use]
    pub fn tool_name(&self) -> &Identifier {
        &self.tool_name
    }

    #[must_use]
    pub fn tool_plugin_id(&self) -> &Identifier {
        &self.tool_plugin_id
    }

    #[must_use]
    pub fn tool_input(&self) -> &Map<String, Value> {
        &self.tool_input
    }
}

impl ToolCallFinished {
    /// The call `started` came back with `result`, kept as its session
    /// keeps a call's result, and the evidence the call made.
    #[must_use]
    pub fn new(started: &ToolCallStarted, result: ToolCallResult, evidence: Vec<Evidence>) -> Self {
        Self {
            round: started.round,
            tool_call_id: started.tool_call_id.clone(),
            tool_name: started.tool_name.clone(),
            tool_plugin_id: started.tool_plugin_id.clone(),
            tool_result: ConversationToolCall::kept_result(result),
            runtime_plugin_evidence: evidence,
        }
    }

    #[must_use]
    pub fn round(&self) -> NonZeroU32 {
        self.round
    }

    #[must_use]
    pub fn tool_call_id(&self) -> &ToolCallId {
        &self.tool_call_id
    }

    #[must_use]
    pub fn tool_name(&self) -> &Identifier {
        &self.tool_name
    }

    #[must_use]
    pub fn tool_plugin_id(&self) -> &Identifier {
        &self.tool_plugin_id
    }

    #[must_use]
    pub fn tool_result(&self) -> &ToolCallResult {
        &self.tool_result
    }
}
