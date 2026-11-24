use p02_core::{AppNames, VisibleText};
use p02_shared::{
    BoundJsonError, Credentials, Identifier, JsonLimits, bound_json_object,
    redact_object_credentials,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::role_model::reasoning::scrub_reasoning_blocks;
use crate::tool::ProvidedTool;

/// The built-in tool a character writes to the person with. It is always
/// offered, ahead of every plugin tool, so no configuration can take a
/// character's voice.
pub const SEND_MESSAGE: &str = "send_message";

/// The built-in tool a character leaves the person's message unanswered
/// with, for now. It is always offered, after [`SEND_MESSAGE`] and ahead of
/// every plugin tool, and a record keeps a call of it under this name.
pub const ANSWER_LATER: &str = "answer_later";

/// The tool that lists the plugins installed, offered by the runtime's own
/// plugin. While it is offered, the model is told it can ask for the
/// inventory rather than take the tools it sees for all there is.
pub const PLUGIN_LIST_TOOL: &str = "runtime.plugin.list";

/// The name a record keeps each of her messages under, whatever the model
/// is offered the tool as: every stored round has it.
const RECORDED_REPLY: &str = "visible_reply";

const SEND_MESSAGE_DESCRIPTION: &str = "Send a message to the one you write with.";
const SEND_MESSAGE_TEXT_DESCRIPTION: &str = "The message, exactly as you write it.";
const ANSWER_LATER_DESCRIPTION: &str = "Leave the message unanswered for now. The one who wrote it \
     sees that you read it, and nothing else.";

/// A tool as the model is offered it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelToolDefinition {
    pub name: String,
    pub description: String,
    pub input_contract: Map<String, Value>,
}

impl ModelToolDefinition {
    /// The definition of [`SEND_MESSAGE`] for her with `apps`, the apps she
    /// has now: with more than one, a message may name the one it goes in.
    #[must_use]
    pub fn send_message(apps: &AppNames) -> Self {
        let mut properties = Map::from_iter([(
            "text".to_owned(),
            json!({"type": "string", "description": SEND_MESSAGE_TEXT_DESCRIPTION}),
        )]);
        let ids: Vec<&str> = apps.ids().collect();

        if ids.len() > 1 {
            properties.insert(
                "app".to_owned(),
                json!({"type": "string", "enum": ids, "description": app_description(apps)}),
            );
        }

        Self {
            name: SEND_MESSAGE.to_owned(),
            description: SEND_MESSAGE_DESCRIPTION.to_owned(),
            input_contract: Map::from_iter([
                ("type".to_owned(), json!("object")),
                ("properties".to_owned(), Value::Object(properties)),
                ("required".to_owned(), json!(["text"])),
                ("additionalProperties".to_owned(), json!(false)),
            ]),
        }
    }

    /// The definition of [`ANSWER_LATER`], which takes nothing.
    #[must_use]
    pub fn answer_later() -> Self {
        Self {
            name: ANSWER_LATER.to_owned(),
            description: ANSWER_LATER_DESCRIPTION.to_owned(),
            input_contract: Map::from_iter([
                ("type".to_owned(), json!("object")),
                ("properties".to_owned(), json!({})),
                ("required".to_owned(), json!([])),
                ("additionalProperties".to_owned(), json!(false)),
            ]),
        }
    }
}

/// What a message's `app` is, each of `apps` by its name and its id.
fn app_description(apps: &AppNames) -> String {
    let named: Vec<String> = apps
        .ids()
        .map(|app| format!("{} (\"{app}\")", apps.name(app)))
        .collect();
    let listed = match named.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} or {last}", rest.join(", ")),
        _ => named.concat(),
    };

    format!(
        "The app to send it in: {listed}. Left out, it goes in the app the last message to you \
         came in."
    )
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

/// One call a model round made: the character speaking, in the app she
/// named when she named one; leaving the message for later; or a plugin
/// tool.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(into = "WireCall", try_from = "WireCall")]
pub enum ModelToolCall {
    VisibleReply {
        text: VisibleText,
        app: Option<String>,
    },
    AnswerLater,
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
#[error("Nothing was sent. The message was empty")]
pub(crate) struct BlankReplyError;

impl ModelToolCall {
    /// The character's reply as the model wrote it, in `app` when she named
    /// one: what its reasoning blocks leave, normalized, so what the model
    /// said, what the person sees and what the log keeps are one text.
    pub(crate) fn reply(written: &str, app: Option<String>) -> Result<Self, BlankReplyError> {
        VisibleText::normalize(&scrub_reasoning_blocks(written))
            .map(|text| Self::VisibleReply { text, app })
            .map_err(|_| BlankReplyError)
    }

    /// A call of a plugin tool whose input crosses the JSON boundary, its
    /// credential-named values kept to run the call.
    pub(crate) fn plugin(
        name: Identifier,
        input: Map<String, Value>,
    ) -> Result<Self, BoundJsonError> {
        let input = bound_json_object(
            Value::Object(input),
            &format!("Model tool \"{name}\" input"),
            JsonLimits::default(),
            Credentials::Keep,
        )?;

        Ok(Self::Plugin { name, input })
    }

    /// The call as a record keeps it: every credential-named value in its
    /// input redacted.
    pub(crate) fn redacted(&self) -> Self {
        match self {
            Self::VisibleReply { .. } | Self::AnswerLater => self.clone(),
            Self::Plugin { name, input } => {
                let mut input = input.clone();

                redact_object_credentials(&mut input);
                Self::Plugin {
                    name: name.clone(),
                    input,
                }
            }
        }
    }
}

impl From<ModelToolCall> for WireCall {
    fn from(call: ModelToolCall) -> Self {
        match call {
            ModelToolCall::VisibleReply { text, app } => Self {
                name: RECORDED_REPLY.to_owned(),
                input: std::iter::once(("text".to_owned(), Value::from(text.as_str())))
                    .chain(app.map(|app| ("app".to_owned(), Value::from(app))))
                    .collect(),
            },
            ModelToolCall::AnswerLater => Self {
                name: ANSWER_LATER.to_owned(),
                input: Map::new(),
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
        if call.name == ANSWER_LATER {
            return Ok(Self::AnswerLater);
        }

        if call.name != RECORDED_REPLY {
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
            .map(|text| Self::VisibleReply {
                text,
                app: call
                    .input
                    .get("app")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
            .ok_or(ParseModelToolCallError)
    }
}

/// A plugin tool as the model is offered it, under the plugin that answers it.
#[derive(Clone, Debug, PartialEq)]
pub struct PluginToolDefinition {
    pub plugin_id: Identifier,
    pub tool: ProvidedTool,
}

/// The plugin tools of one model call, each name offered once.
#[derive(Clone, Debug, Default, PartialEq)]
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
        let sent_in =
            json!({"name": "visible_reply", "input": {"text": "Hello.", "app": "telegram"}});
        let later = json!({"name": "answer_later", "input": {}});
        let plugin = json!({"name": "memory.search", "input": {"query": "Mira"}});

        for call in [&reply, &sent_in, &later, &plugin] {
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
