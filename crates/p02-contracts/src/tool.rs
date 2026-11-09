use std::fmt;

use async_trait::async_trait;
use p02_shared::Identifier;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::context::HookContext;
use crate::evidence::EvidenceNote;
use crate::plugin::PluginError;
use crate::role_model::VISIBLE_REPLY;
use crate::schema::{ToolInputContract, ToolInputRejection};
use crate::vocabulary::ToolConcurrency;

/// A tool a plugin offers the model. Every plugin tool is shown to the
/// model and has its input judged by the host against its contract.
#[derive(Clone, Debug, PartialEq)]
pub struct ProvidedTool {
    name: Identifier,
    description: String,
    input_contract: ToolInputContract,
    concurrency: ToolConcurrency,
    requires_confirmation: Confirmation,
}

/// Whether a tool's effect waits for the person to approve it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Confirmation {
    NotRequired,
    /// The tool is approval-gated: its plugin prepares each call
    /// (`prepare_tool_call`), and the host shows the person what the call
    /// would do and applies its effect only on a yes.
    Required,
}

/// Why a tool definition was refused.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ToolDefinitionError {
    #[error("tool \"{name}\" must have a description")]
    BlankDescription { name: Identifier },
    #[error("tool \"{name}\" is built in, and no plugin may provide it")]
    BuiltInName { name: Identifier },
}

impl ProvidedTool {
    /// A tool whose calls run one at a time and act without approval.
    ///
    /// # Errors
    ///
    /// [`ToolDefinitionError`] when the description is blank or the name
    /// is a built-in tool's.
    pub fn new(
        name: Identifier,
        description: impl Into<String>,
        input_contract: ToolInputContract,
    ) -> Result<Self, ToolDefinitionError> {
        let description = description.into();

        if name.as_str() == VISIBLE_REPLY {
            return Err(ToolDefinitionError::BuiltInName { name });
        }

        if description.trim().is_empty() {
            return Err(ToolDefinitionError::BlankDescription { name });
        }

        Ok(Self {
            name,
            description,
            input_contract,
            concurrency: ToolConcurrency::Exclusive,
            requires_confirmation: Confirmation::NotRequired,
        })
    }

    #[must_use]
    pub fn with_concurrency(mut self, concurrency: ToolConcurrency) -> Self {
        self.concurrency = concurrency;
        self
    }

    #[must_use]
    pub fn with_confirmation(mut self, confirmation: Confirmation) -> Self {
        self.requires_confirmation = confirmation;
        self
    }

    #[must_use]
    pub fn name(&self) -> &Identifier {
        &self.name
    }

    #[must_use]
    pub fn description(&self) -> &str {
        &self.description
    }

    #[must_use]
    pub fn input_contract(&self) -> &ToolInputContract {
        &self.input_contract
    }

    #[must_use]
    pub fn concurrency(&self) -> ToolConcurrency {
        self.concurrency
    }

    #[must_use]
    pub fn confirmation(&self) -> Confirmation {
        self.requires_confirmation
    }

    /// Whether the host asks the person before the tool's effect lands.
    #[must_use]
    pub fn is_approval_gated(&self) -> bool {
        self.requires_confirmation == Confirmation::Required
    }
}

/// The id a model round gave one of its tool calls, which the result
/// answers to.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct ToolCallId(String);

/// Why a text is not a [`ToolCallId`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("a tool call id must not be empty")]
pub struct ParseToolCallIdError;

impl ToolCallId {
    /// # Errors
    ///
    /// [`ParseToolCallIdError`] when `value` is empty.
    pub fn new(value: &str) -> Result<Self, ParseToolCallIdError> {
        if value.is_empty() {
            Err(ParseToolCallIdError)
        } else {
            Ok(Self(value.to_owned()))
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ToolCallId {
    type Error = ParseToolCallIdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl fmt::Display for ToolCallId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A call of one of a plugin's tools, made only with input the tool's
/// contract admits, so a plugin reads no other. Which turn it belongs to is
/// the hook context's to say.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    call_id: ToolCallId,
    tool_name: Identifier,
    input: Map<String, Value>,
}

impl ToolCall {
    /// A call of `tool` with `input`, which the tool's contract judges.
    ///
    /// # Errors
    ///
    /// [`ToolInputRejection`] naming the field and the rule `input`
    /// breaks, which the model is told.
    pub fn new(
        call_id: ToolCallId,
        tool: &ProvidedTool,
        input: Map<String, Value>,
    ) -> Result<Self, ToolInputRejection> {
        tool.input_contract().validate(tool.name(), &input)?;

        Ok(Self {
            call_id,
            tool_name: tool.name().clone(),
            input,
        })
    }

    #[must_use]
    pub fn call_id(&self) -> &ToolCallId {
        &self.call_id
    }

    #[must_use]
    pub fn tool_name(&self) -> &Identifier {
        &self.tool_name
    }

    /// The input as the model sent it.
    #[must_use]
    pub fn input(&self) -> &Map<String, Value> {
        &self.input
    }
}

/// What a call comes to: the answer of a tool that acts without approval,
/// or of an effect the person approved.
#[derive(Clone, Debug, PartialEq)]
pub enum ToolCallOutcome {
    /// The tool ran; the model reads `output`.
    Accepted {
        output: Value,
        evidence: Vec<EvidenceNote>,
    },
    /// The tool refused; the model reads `message` and goes on.
    Rejected {
        reason: String,
        message: String,
        evidence: Vec<EvidenceNote>,
    },
}

/// What preparing a call of an approval-gated tool comes to.
#[derive(Debug)]
pub enum ToolPreparation {
    /// What the call would do, waiting for the person: they are shown
    /// `preview`, and the host applies `effect` only on their yes.
    Prepared {
        preview: Map<String, Value>,
        effect: Box<dyn PreparedEffect>,
        evidence: Vec<EvidenceNote>,
    },
    /// The tool refused the call, so nobody is asked; the model reads
    /// `message` and goes on.
    Rejected {
        reason: String,
        message: String,
        evidence: Vec<EvidenceNote>,
    },
}

/// The effect of an approval-gated call, prepared and not yet applied. The
/// host applies it once, and only on the person's yes; any other answer
/// drops it unapplied.
#[async_trait]
pub trait PreparedEffect: Send + fmt::Debug {
    /// Applies the approved effect, with what the plugin is granted, under
    /// a hook context of its own: the person may answer after the
    /// preparation's deadline has passed.
    async fn apply(self: Box<Self>, context: &HookContext) -> Result<ToolCallOutcome, PluginError>;
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn contract() -> ToolInputContract {
        ToolInputContract::new(json!({"type": "object", "additionalProperties": false})).unwrap()
    }

    #[test]
    fn a_tool_is_described_and_never_takes_a_built_in_name() {
        let named = |name: &str, description: &str| {
            ProvidedTool::new(Identifier::new(name).unwrap(), description, contract())
        };

        assert!(named("sessions.search", "Search past conversations.").is_ok());
        assert!(matches!(
            named("visible_reply", "Speak for the character."),
            Err(ToolDefinitionError::BuiltInName { .. })
        ));
        assert!(matches!(
            named("sessions.search", " "),
            Err(ToolDefinitionError::BlankDescription { .. })
        ));
    }

    #[test]
    fn a_call_is_made_only_with_input_its_tools_contract_admits() {
        let tool = ProvidedTool::new(
            Identifier::new("notes.add").unwrap(),
            "Add a note.",
            ToolInputContract::new(json!({
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
                "additionalProperties": false,
            }))
            .unwrap(),
        )
        .unwrap();
        let input = |value: Value| value.as_object().cloned().unwrap();
        let call = ToolCall::new(
            ToolCallId::new("call-1").unwrap(),
            &tool,
            input(json!({"text": "milk"})),
        )
        .unwrap();

        assert_eq!(call.tool_name(), tool.name());
        assert_eq!(call.input(), &input(json!({"text": "milk"})));
        assert_eq!(
            ToolCall::new(ToolCallId::new("call-2").unwrap(), &tool, input(json!({})))
                .unwrap_err()
                .sentence(),
            r#"notes.add input missing required field "text"."#
        );
    }
}
