use p02_core::VisibleText;
use p02_shared::{BoundJsonError, Credentials, Identifier, JsonLimits, bound_json_object};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::role_model::reasoning::scrub_reasoning_blocks;
use crate::tool::ProvidedTool;

/// The built-in tool a character speaks with. It is always offered, ahead
/// of every plugin tool, so no configuration can take a character's voice.
pub const VISIBLE_REPLY: &str = "visible_reply";

/// The tool that lists the plugins installed, offered by the runtime's own
/// plugin. While it is offered, the model is told it can ask for the
/// inventory rather than take the tools it sees for all there is.
pub const PLUGIN_LIST_TOOL: &str = "runtime.plugin.list";

const VISIBLE_REPLY_DESCRIPTION: &str =
    "Say something to the person you are talking with — this is how your words reach them.";
const VISIBLE_REPLY_TEXT_DESCRIPTION: &str = "Exactly what you say, word for word.";

/// A tool as the model is offered it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelToolDefinition {
    pub name: String,
    pub description: String,
    pub input_contract: Map<String, Value>,
}

impl ModelToolDefinition {
    /// The definition of [`VISIBLE_REPLY`].
    #[must_use]
    pub fn visible_reply() -> Self {
        Self {
            name: VISIBLE_REPLY.to_owned(),
            description: VISIBLE_REPLY_DESCRIPTION.to_owned(),
            input_contract: Map::from_iter([
                ("type".to_owned(), json!("object")),
                (
                    "properties".to_owned(),
                    json!({
                        "text": {"type": "string", "description": VISIBLE_REPLY_TEXT_DESCRIPTION},
                    }),
                ),
                ("required".to_owned(), json!(["text"])),
                ("additionalProperties".to_owned(), json!(false)),
            ]),
        }
    }
}

impl From<&ProvidedTool> for ModelToolDefinition {
    fn from(tool: &ProvidedTool) -> Self {
        Self {
            name: tool.name().to_string(),
            description: tool.description().to_owned(),
            input_contract: tool.input_contract().schema().clone(),
        }
    }
}

/// One call a model round made: the character speaking, or a plugin tool.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(into = "WireCall", try_from = "WireCall")]
pub enum ModelToolCall {
    VisibleReply {
        text: VisibleText,
    },
    Plugin {
        name: Identifier,
        input: Map<String, Value>,
    },
}

/// A call as recorded.
#[derive(Serialize, Deserialize)]
struct WireCall {
    name: String,
    input: Map<String, Value>,
}

/// Why a recorded call is not a [`ModelToolCall`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error(
    "a recorded tool call names a tool by identifier, and a visible_reply carries a \"text\" \
     that is not blank"
)]
pub struct ParseModelToolCallError;

/// What the model wrote is no reply: nothing is left once its reasoning is
/// taken out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("visible_reply text must not be empty")]
pub(crate) struct BlankReplyError;

impl ModelToolCall {
    /// The character's reply as the model wrote it: what its reasoning
    /// blocks leave, normalized, so what the model said, what the person
    /// sees and what the log keeps are one text.
    pub(crate) fn reply(written: &str) -> Result<Self, BlankReplyError> {
        VisibleText::normalize(&scrub_reasoning_blocks(written))
            .map(|text| Self::VisibleReply { text })
            .map_err(|_| BlankReplyError)
    }

    /// A call of a plugin tool whose input crosses the JSON boundary, its
    /// credential-named values kept to run the call or redacted to record it.
    pub(crate) fn plugin(
        name: Identifier,
        input: Map<String, Value>,
        credentials: Credentials,
    ) -> Result<Self, BoundJsonError> {
        let input = bound_json_object(
            Value::Object(input),
            &format!("Model tool \"{name}\" input"),
            JsonLimits::default(),
            credentials,
        )?;

        Ok(Self::Plugin { name, input })
    }

    #[must_use]
    pub fn name(&self) -> &str {
        match self {
            Self::VisibleReply { .. } => VISIBLE_REPLY,
            Self::Plugin { name, .. } => name.as_str(),
        }
    }
}

impl From<ModelToolCall> for WireCall {
    fn from(call: ModelToolCall) -> Self {
        match call {
            ModelToolCall::VisibleReply { text } => Self {
                name: VISIBLE_REPLY.to_owned(),
                input: Map::from_iter([("text".to_owned(), Value::from(text.as_str()))]),
            },
            ModelToolCall::Plugin { name, input } => Self {
                name: name.to_string(),
                input,
            },
        }
    }
}

/// A recorded call reads back as it was written.
impl TryFrom<WireCall> for ModelToolCall {
    type Error = ParseModelToolCallError;

    fn try_from(call: WireCall) -> Result<Self, Self::Error> {
        if call.name != VISIBLE_REPLY {
            return Identifier::new(&call.name)
                .map(|name| Self::Plugin {
                    name,
                    input: call.input,
                })
                .map_err(|_| ParseModelToolCallError);
        }

        call.input
            .get("text")
            .and_then(Value::as_str)
            .and_then(|text| VisibleText::normalize(text).ok())
            .map(|text| Self::VisibleReply { text })
            .ok_or(ParseModelToolCallError)
    }
}

/// A plugin tool as the model is offered it, under the plugin that answers it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginToolDefinition {
    pub plugin_id: Identifier,
    #[serde(flatten)]
    pub tool: ProvidedTool,
}

/// The plugin tools of one model call, each name offered once. A record of
/// them reads back as it was written.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PluginToolDefinitions(Vec<PluginToolDefinition>);

/// Two plugin tools share a name, so a call could not say which it meant.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("tool \"{tool}\" is offered by both \"{first}\" and \"{second}\"")]
pub struct DuplicateToolError {
    pub tool: Identifier,
    pub first: Identifier,
    pub second: Identifier,
}

impl PluginToolDefinitions {
    /// # Errors
    ///
    /// [`DuplicateToolError`] for the first name offered twice.
    pub fn new(definitions: Vec<PluginToolDefinition>) -> Result<Self, DuplicateToolError> {
        for (index, definition) in definitions.iter().enumerate() {
            if let Some(earlier) = definitions[..index]
                .iter()
                .find(|earlier| earlier.tool.name() == definition.tool.name())
            {
                return Err(DuplicateToolError {
                    tool: definition.tool.name().clone(),
                    first: earlier.plugin_id.clone(),
                    second: definition.plugin_id.clone(),
                });
            }
        }

        Ok(Self(definitions))
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<&PluginToolDefinition> {
        self.0
            .iter()
            .find(|definition| definition.tool.name().as_str() == name)
    }

    #[must_use]
    pub fn definitions(&self) -> &[PluginToolDefinition] {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::schema::ToolInputContract;

    fn definition(plugin: &str, tool: &str) -> PluginToolDefinition {
        PluginToolDefinition {
            plugin_id: Identifier::new(plugin).unwrap(),
            tool: ProvidedTool::new(
                Identifier::new(tool).unwrap(),
                "A tool.",
                ToolInputContract::new(json!({"type": "object"})).unwrap(),
            )
            .unwrap(),
        }
    }

    #[test]
    fn a_tool_name_is_offered_once_whichever_plugin_offers_it() {
        assert!(
            PluginToolDefinitions::new(vec![
                definition("notes", "notes.search"),
                definition("notes", "notes.add"),
                definition("calendar", "calendar.add"),
            ])
            .is_ok()
        );
        assert_eq!(
            PluginToolDefinitions::new(vec![
                definition("notes", "notes.search"),
                definition("archive", "notes.search"),
            ]),
            Err(DuplicateToolError {
                tool: Identifier::new("notes.search").unwrap(),
                first: Identifier::new("notes").unwrap(),
                second: Identifier::new("archive").unwrap(),
            })
        );
    }

    #[test]
    fn a_model_tool_call_is_a_name_and_an_input_on_the_record() {
        let reply = json!({"name": "visible_reply", "input": {"text": "Hello."}});
        let plugin = json!({"name": "memory.search", "input": {"query": "Mira"}});

        for call in [&reply, &plugin] {
            let parsed: ModelToolCall = serde_json::from_value(call.clone()).unwrap();

            assert_eq!(&serde_json::to_value(&parsed).unwrap(), call);
        }

        for refused in [
            json!({"name": "visible_reply", "input": {"text": " "}}),
            json!({"name": "visible_reply", "input": {}}),
            json!({"name": "9-lives", "input": {}}),
        ] {
            assert!(serde_json::from_value::<ModelToolCall>(refused).is_err());
        }
    }
}
