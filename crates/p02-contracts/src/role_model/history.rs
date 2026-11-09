use std::num::NonZeroU32;

use p02_core::{EventIdentity, VisibleMessage};
use p02_shared::{
    BoundJsonError, Credentials, Identifier, JsonLimits, bound_json, bound_json_object,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::output::within_limits;
use crate::tool::ToolCallId;

/// A finished turn as the model replays it: the person's message, every
/// tool round with its results, then the character's final replies. The
/// event that opened the turn names it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTurn {
    #[serde(flatten)]
    pub identity: EventIdentity,
    pub user_message: VisibleMessage,
    pub tool_rounds: Vec<ToolRound>,
    pub final_replies: Vec<VisibleMessage>,
}

impl ConversationTurn {
    /// Every visible message of the turn, in the order it was said.
    pub fn visible_messages(&self) -> impl Iterator<Item = &VisibleMessage> {
        std::iter::once(&self.user_message)
            .chain(
                self.tool_rounds
                    .iter()
                    .flat_map(|round| &round.interim_replies),
            )
            .chain(&self.final_replies)
    }
}

/// One round of tool calls, of this turn or an earlier one: the one shape a
/// tool round is shown to the model in.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRound {
    pub round: NonZeroU32,
    /// What the model wrote beside its calls, which it is shown again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The replies the model committed in this round, in commit order.
    pub interim_replies: Vec<VisibleMessage>,
    pub tool_calls: Vec<ConversationToolCall>,
}

/// A finished tool call: what the model asked, and what came back. A
/// record of it reads back as it was written.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationToolCall {
    tool_call_id: ToolCallId,
    plugin_id: Identifier,
    tool_name: Identifier,
    input: Map<String, Value>,
    result: ToolCallResult,
}

/// What came back from a tool call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ToolCallResult {
    Accepted { output: Value },
    Rejected { reason: String, message: String },
}

impl ConversationToolCall {
    /// A finished call as the model is shown it again: its input and its
    /// result as [`ConversationToolCall::kept_input`] and
    /// [`ConversationToolCall::kept_result`] keep them.
    ///
    /// # Errors
    ///
    /// [`BoundJsonError`] when the input or the result breaks a limit.
    pub fn new(
        tool_call_id: ToolCallId,
        plugin_id: Identifier,
        tool_name: Identifier,
        input: Map<String, Value>,
        result: ToolCallResult,
    ) -> Result<Self, BoundJsonError> {
        Ok(Self {
            tool_call_id,
            plugin_id,
            tool_name,
            input: Self::kept_input(input)?,
            result: Self::kept_result(result)?,
        })
    }

    /// A call's input as the model is shown it again and its session keeps
    /// it: held to the JSON limits, with credential-named values redacted.
    ///
    /// # Errors
    ///
    /// [`BoundJsonError`] when the input breaks a limit.
    pub fn kept_input(input: Map<String, Value>) -> Result<Map<String, Value>, BoundJsonError> {
        bound_json_object(
            Value::Object(input),
            "Conversation tool call input",
            JsonLimits::default(),
            Credentials::Redact,
        )
    }

    /// A call's result as the model is shown it again and its session keeps
    /// it: an output held to the JSON limits with credential-named values
    /// redacted, or a rejection's reason and message held to the same
    /// limits.
    ///
    /// # Errors
    ///
    /// [`BoundJsonError`] when the result breaks a limit.
    pub fn kept_result(result: ToolCallResult) -> Result<ToolCallResult, BoundJsonError> {
        match result {
            ToolCallResult::Accepted { output } => Ok(ToolCallResult::Accepted {
                output: bound_json(
                    output,
                    "Conversation tool call output",
                    JsonLimits::default(),
                    Credentials::Redact,
                )?,
            }),
            rejected @ ToolCallResult::Rejected { .. } => {
                within_limits(&rejected, "Conversation tool call rejection")?;
                Ok(rejected)
            }
        }
    }

    #[must_use]
    pub fn tool_call_id(&self) -> &ToolCallId {
        &self.tool_call_id
    }

    #[must_use]
    pub fn plugin_id(&self) -> &Identifier {
        &self.plugin_id
    }

    #[must_use]
    pub fn tool_name(&self) -> &Identifier {
        &self.tool_name
    }

    #[must_use]
    pub fn input(&self) -> &Map<String, Value> {
        &self.input
    }

    #[must_use]
    pub fn result(&self) -> &ToolCallResult {
        &self.result
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn message(number: u64, role: &str, text: &str) -> Value {
        json!({
            "id": format!("chat.1:message-{number}"),
            "role": role,
            "speakerId": if role == "user" { "local-user" } else { "mira" },
            "speakerName": if role == "user" { "You" } else { "Mira" },
            "text": text,
        })
    }

    fn turn(event: &str, replies: &Value) -> ConversationTurn {
        serde_json::from_value(json!({
            "eventId": event,
            "traceId": format!("trace-{event}"),
            "createdAt": "2026-06-15T00:00:00.000Z",
            "userMessage": message(1, "user", "Did you find it?"),
            "toolRounds": [{
                "round": 1,
                "text": "Let me look.",
                "interimReplies": [message(2, "character", "One moment.")],
                "toolCalls": [{
                    "toolCallId": "call-1",
                    "pluginId": "memory",
                    "toolName": "memory.search",
                    "input": {"query": "keys"},
                    "result": {"status": "accepted", "output": {"found": true}},
                }],
            }],
            "finalReplies": replies,
        }))
        .unwrap()
    }

    #[test]
    fn a_turn_replays_its_messages_in_the_order_they_were_said() {
        let turn = turn(
            "evt_1",
            &json!([
                message(3, "character", "Found them."),
                message(4, "character", "By the door.")
            ]),
        );
        let texts: Vec<&str> = turn
            .visible_messages()
            .map(|message| message.text.as_str())
            .collect();

        assert_eq!(
            texts,
            [
                "Did you find it?",
                "One moment.",
                "Found them.",
                "By the door."
            ]
        );
        assert!(
            serde_json::from_value::<ToolRound>(json!({
                "round": 0,
                "interimReplies": [],
                "toolCalls": [],
            }))
            .is_err()
        );
    }

    #[test]
    fn a_replayed_tool_call_never_shows_a_credential() {
        let call = ConversationToolCall::new(
            ToolCallId::new("call-1").unwrap(),
            Identifier::new("mem0").unwrap(),
            Identifier::new("memory.add").unwrap(),
            json!({"text": "note", "api_key": "m0sk_live"})
                .as_object()
                .cloned()
                .unwrap(),
            ToolCallResult::Accepted {
                output: json!({"stored": 1, "session": {"access_token": "t0k"}}),
            },
        )
        .unwrap();

        assert_eq!(call.input()["api_key"], json!("[redacted]"));
        assert_eq!(
            call.result(),
            &ToolCallResult::Accepted {
                output: json!({"stored": 1, "session": {"access_token": "[redacted]"}})
            }
        );
    }

    #[test]
    fn a_replayed_tool_call_is_held_to_the_json_limits_however_it_ended() {
        let call = |result| {
            ConversationToolCall::new(
                ToolCallId::new("call-1").unwrap(),
                Identifier::new("mem0").unwrap(),
                Identifier::new("memory.add").unwrap(),
                Map::new(),
                result,
            )
        };
        let oversized = "x".repeat(16 * 1_024 + 1);

        assert!(
            call(ToolCallResult::Accepted {
                output: json!(oversized),
            })
            .is_err()
        );
        assert!(
            call(ToolCallResult::Rejected {
                reason: "handler_failed".to_owned(),
                message: oversized,
            })
            .is_err()
        );
    }
}
