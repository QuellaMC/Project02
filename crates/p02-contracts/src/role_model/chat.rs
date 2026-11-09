use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::tool::ToolCallId;

/// One message of the chat wire a provider speaks, in its own field names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum ChatMessage {
    System {
        content: String,
    },
    Developer {
        content: String,
    },
    User {
        content: String,
    },
    Assistant {
        /// Null beside tool calls that came with no text.
        content: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<ChatToolCall>,
    },
    Tool {
        content: String,
        tool_call_id: ToolCallId,
    },
}

/// A function call an assistant message carries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatToolCall {
    id: ToolCallId,
    #[serde(rename = "type")]
    kind: Function,
    function: ChatFunctionCall,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatFunctionCall {
    /// The name the provider knows the tool by.
    pub name: String,
    /// The call's input as JSON text, the way providers carry it.
    pub arguments: String,
}

impl ChatToolCall {
    #[must_use]
    pub fn new(id: ToolCallId, function: ChatFunctionCall) -> Self {
        Self {
            id,
            kind: Function,
            function,
        }
    }

    #[must_use]
    pub fn id(&self) -> &ToolCallId {
        &self.id
    }

    #[must_use]
    pub fn function(&self) -> &ChatFunctionCall {
        &self.function
    }
}

/// A tool as a provider is offered it. Its parameters are the tool's input
/// contract itself: nothing is translated on the way to the wire.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatCompletionTool {
    #[serde(rename = "type")]
    kind: Function,
    function: ChatToolFunction,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatToolFunction {
    pub name: String,
    pub description: String,
    pub parameters: Map<String, Value>,
    /// Asks the provider to hold the call to the schema exactly; only a
    /// schema closed at every level qualifies.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub strict: bool,
}

impl ChatCompletionTool {
    #[must_use]
    pub fn new(function: ChatToolFunction) -> Self {
        Self {
            kind: Function,
            function,
        }
    }

    #[must_use]
    pub fn function(&self) -> &ChatToolFunction {
        &self.function
    }
}

/// The wire's `"type": "function"`, the only kind of tool there is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Function;

impl Serialize for Function {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str("function")
    }
}

impl<'de> Deserialize<'de> for Function {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let kind = String::deserialize(deserializer)?;

        if kind == "function" {
            Ok(Self)
        } else {
            Err(serde::de::Error::invalid_value(
                serde::de::Unexpected::Str(&kind),
                &"\"function\"",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn chat_messages_keep_the_provider_wire_field_names() {
        let messages = json!([
            {"role": "system", "content": "You are Mira."},
            {"role": "user", "content": "Hi."},
            {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "memory_update", "arguments": "{\"text\":\"x\"}"},
                }],
            },
            {"role": "tool", "content": "{\"ok\":true}", "tool_call_id": "call_1"},
            {"role": "assistant", "content": "Hello."},
        ]);
        let parsed: Vec<ChatMessage> = serde_json::from_value(messages.clone()).unwrap();

        assert_eq!(serde_json::to_value(&parsed).unwrap(), messages);

        let tool = json!({
            "type": "function",
            "function": {
                "name": "memory_update",
                "description": "Update a memory.",
                "parameters": {"type": "object"},
                "strict": true,
            },
        });

        assert_eq!(
            serde_json::to_value(
                serde_json::from_value::<ChatCompletionTool>(tool.clone()).unwrap()
            )
            .unwrap(),
            tool
        );
        assert!(
            serde_json::from_value::<ChatToolCall>(json!({
                "id": "call_1",
                "type": "custom",
                "function": {"name": "x", "arguments": "{}"},
            }))
            .is_err()
        );
    }
}
