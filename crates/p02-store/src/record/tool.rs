use std::num::NonZeroU32;

use p02_contracts::{ConversationToolCall, Evidence, ToolCallId, ToolCallResult};
use p02_shared::{BoundJsonError, Identifier};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::RecordError;

/// A tool call a round made, recorded before it runs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "WireStarted")]
pub struct ToolCallStarted {
    round: NonZeroU32,
    tool_call_id: ToolCallId,
    tool_name: Identifier,
    tool_plugin_id: Identifier,
    tool_input: Map<String, Value>,
}

/// How a call came to its result.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolDispatch {
    /// The plugin host ran it.
    Host,
    /// No plugin offers the tool, so the runtime refused it unasked.
    Undeclared,
}

/// A tool call that came back.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "WireFinished")]
pub struct ToolCallFinished {
    round: NonZeroU32,
    tool_call_id: ToolCallId,
    tool_name: Identifier,
    tool_plugin_id: Identifier,
    dispatched_to_host: bool,
    tool_result: ToolCallResult,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    runtime_plugin_evidence: Vec<Evidence>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireStarted {
    round: NonZeroU32,
    tool_call_id: ToolCallId,
    tool_name: Identifier,
    tool_plugin_id: Identifier,
    tool_input: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireFinished {
    round: NonZeroU32,
    tool_call_id: ToolCallId,
    tool_name: Identifier,
    tool_plugin_id: Identifier,
    dispatched_to_host: bool,
    tool_result: ToolCallResult,
    #[serde(default)]
    runtime_plugin_evidence: Vec<Evidence>,
}

impl ToolCallStarted {
    /// Call `tool_call_id` of round `round`, of `tool_name`, which
    /// `tool_plugin_id` answers, with `tool_input` kept as its session keeps
    /// a call's input.
    ///
    /// # Errors
    ///
    /// [`BoundJsonError`] when the input breaks the JSON limits.
    pub fn new(
        round: NonZeroU32,
        tool_call_id: ToolCallId,
        tool_name: Identifier,
        tool_plugin_id: Identifier,
        tool_input: Map<String, Value>,
    ) -> Result<Self, BoundJsonError> {
        Ok(Self {
            round,
            tool_call_id,
            tool_name,
            tool_plugin_id,
            tool_input: ConversationToolCall::kept_input(tool_input)?,
        })
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

impl TryFrom<WireStarted> for ToolCallStarted {
    type Error = RecordError;

    fn try_from(wire: WireStarted) -> Result<Self, Self::Error> {
        Self::new(
            wire.round,
            wire.tool_call_id,
            wire.tool_name,
            wire.tool_plugin_id,
            wire.tool_input,
        )
        .map_err(RecordError::UnkeptToolCall)
    }
}

impl ToolDispatch {
    fn of(dispatched_to_host: bool) -> Self {
        if dispatched_to_host {
            Self::Host
        } else {
            Self::Undeclared
        }
    }
}

impl ToolCallFinished {
    /// The call `started` came back with `result`, kept as its session
    /// keeps a call's result, and the evidence the call made. A call no
    /// plugin offers comes back as the runtime's refusal of it.
    ///
    /// # Errors
    ///
    /// [`RecordError::UnkeptToolCall`] when the result breaks the JSON
    /// limits, and [`RecordError::UndeclaredAnswered`] when a call no
    /// plugin offers comes back accepted.
    pub fn new(
        started: &ToolCallStarted,
        dispatch: ToolDispatch,
        result: ToolCallResult,
        evidence: Vec<Evidence>,
    ) -> Result<Self, RecordError> {
        let tool_result =
            ConversationToolCall::kept_result(result).map_err(RecordError::UnkeptToolCall)?;

        check_dispatch(dispatch, &tool_result)?;

        Ok(Self {
            round: started.round,
            tool_call_id: started.tool_call_id.clone(),
            tool_name: started.tool_name.clone(),
            tool_plugin_id: started.tool_plugin_id.clone(),
            dispatched_to_host: dispatch == ToolDispatch::Host,
            tool_result,
            runtime_plugin_evidence: evidence,
        })
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
    pub fn dispatch(&self) -> ToolDispatch {
        ToolDispatch::of(self.dispatched_to_host)
    }

    #[must_use]
    pub fn tool_result(&self) -> &ToolCallResult {
        &self.tool_result
    }

    #[must_use]
    pub fn evidence(&self) -> &[Evidence] {
        &self.runtime_plugin_evidence
    }
}

impl TryFrom<WireFinished> for ToolCallFinished {
    type Error = RecordError;

    fn try_from(wire: WireFinished) -> Result<Self, Self::Error> {
        let tool_result = ConversationToolCall::kept_result(wire.tool_result)
            .map_err(RecordError::UnkeptToolCall)?;

        check_dispatch(ToolDispatch::of(wire.dispatched_to_host), &tool_result)?;

        Ok(Self {
            round: wire.round,
            tool_call_id: wire.tool_call_id,
            tool_name: wire.tool_name,
            tool_plugin_id: wire.tool_plugin_id,
            dispatched_to_host: wire.dispatched_to_host,
            tool_result,
            runtime_plugin_evidence: wire.runtime_plugin_evidence,
        })
    }
}

/// A call no plugin offers was never run, so what came back is the
/// runtime's refusal of it, never an answer.
fn check_dispatch(dispatch: ToolDispatch, result: &ToolCallResult) -> Result<(), RecordError> {
    if dispatch == ToolDispatch::Undeclared && matches!(result, ToolCallResult::Accepted { .. }) {
        Err(RecordError::UndeclaredAnswered)
    } else {
        Ok(())
    }
}
