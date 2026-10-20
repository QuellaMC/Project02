use p02_shared::{BoundJsonError, Credentials, JsonLimits, bound_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::role_model::chat::{
    ChatCompletionTool, ChatMessage, ProviderCapabilities, ToolNameMapping,
};

/// A provider a model call can go to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderName {
    Nvidia,
}

/// The exchange is the wire as sent and received, so it weighs what the
/// prompt weighs: bounded by the context window, not by what one plugin may
/// return. These limits stop only a runaway shape, so a prompt the window
/// admits is always recordable and never fails the turn it describes. A
/// tool's schema is admitted as deep as a plugin's record, sixteen levels,
/// and the request body holds it five levels down, at
/// `tools[].function.parameters`, so the exchange takes twice a record's
/// depth.
const EXCHANGE_LIMITS: JsonLimits = JsonLimits {
    depth: 32,
    entries_per_container: 65_536,
    nodes: 1_048_576,
    string_bytes: 8 * 1_024 * 1_024,
    total_string_bytes: 64 * 1_024 * 1_024,
};

/// A model call as the provider saw it: the request body exactly as sent,
/// the messages and tools it was rendered from, and what came back.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRecord {
    pub provider: ExchangeProvider,
    pub capabilities: ProviderCapabilities,
    pub reasoning_params: Value,
    pub rendered_messages: Vec<ChatMessage>,
    pub rendered_tools: Vec<ChatCompletionTool>,
    pub tool_name_mappings: Vec<ToolNameMapping>,
    pub request_body: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    /// The answer as the provider returned it; the runtime replays its own
    /// rendering, never this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_assistant_message: Option<ChatMessage>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExchangeProvider {
    pub name: ProviderName,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
}

/// An [`ExchangeRecord`] as it is kept: its JSON within the exchange's
/// limits, every credential-named value redacted wherever it sits, in the
/// request body, a tool's schema or the provider's usage alike. A tool
/// call's arguments stay the text the wire carried; the call they parse to
/// is recorded redacted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "ExchangeRecord", into = "Value")]
pub struct ProviderExchange(Value);

impl ProviderExchange {
    /// # Errors
    ///
    /// [`BoundJsonError`] for the first limit the record breaks.
    #[expect(
        clippy::missing_panics_doc,
        reason = "a record of plain data always serializes"
    )]
    pub fn new(record: ExchangeRecord) -> Result<Self, BoundJsonError> {
        let value = serde_json::to_value(record).expect("a record of plain data always serializes");

        bound_json(
            value,
            "Role-model provider exchange",
            EXCHANGE_LIMITS,
            Credentials::Redact,
        )
        .map(Self)
    }

    #[must_use]
    pub fn as_value(&self) -> &Value {
        &self.0
    }
}

impl TryFrom<ExchangeRecord> for ProviderExchange {
    type Error = BoundJsonError;

    fn try_from(record: ExchangeRecord) -> Result<Self, Self::Error> {
        Self::new(record)
    }
}

impl From<ProviderExchange> for Value {
    fn from(exchange: ProviderExchange) -> Self {
        exchange.0
    }
}

/// What a round records of the provider it went to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderMetadata {
    pub provider: ProviderName,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<ProviderRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<ProviderResponse>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ProviderFailure>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_count: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderFailure {
    pub code: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::role_model::chat::{ChatToolFunction, ContextRole, ReasoningParameterStyle};
    use crate::schema::ToolInputContract;

    fn record(messages: Vec<ChatMessage>, request_body: Value) -> ExchangeRecord {
        ExchangeRecord {
            provider: ExchangeProvider {
                name: ProviderName::Nvidia,
                model: Some("nvidia/test-model".to_owned()),
                endpoint: None,
            },
            capabilities: ProviderCapabilities {
                supports_native_tools: true,
                supports_developer_or_system_context: true,
                preferred_model_context_role: ContextRole::System,
                supports_strict_tool_schema: true,
                supports_reasoning: true,
                reasoning_parameter_style: ReasoningParameterStyle::Nvidia,
                requires_reasoning_block_round_trip: false,
                supports_tool_choice: true,
                supports_parallel_tool_calls: true,
            },
            reasoning_params: json!({"chat_template_kwargs": {"thinking": true}}),
            rendered_messages: messages,
            rendered_tools: Vec::new(),
            tool_name_mappings: Vec::new(),
            request_body,
            finish_reason: Some("stop".to_owned()),
            usage: Some(json!({"prompt_tokens": 9000, "completion_tokens": 12})),
            native_assistant_message: None,
        }
    }

    #[test]
    fn an_exchange_as_large_and_as_deep_as_an_admitted_prompt_is_recorded() {
        let history: Vec<ChatMessage> = (0..48)
            .map(|index| ChatMessage::User {
                content: format!("{index}{}", "a".repeat(1_500)),
            })
            .collect();
        let deepest = (0..64)
            .map(|levels| {
                let items = (0..levels).fold(
                    json!({}),
                    |items, _| json!({"type": "array", "items": items}),
                );

                ToolInputContract::new(json!({"type": "object", "properties": {"notes": items}}))
            })
            .map_while(Result::ok)
            .last()
            .unwrap();
        let tool = ChatCompletionTool::new(ChatToolFunction {
            name: "notes.add".to_owned(),
            description: "Adds a note.".to_owned(),
            parameters: deepest.schema().clone(),
            strict: false,
        });
        let body = json!({
            "messages": serde_json::to_value(&history).unwrap(),
            "tools": [&tool],
        });
        let mut prompt = record(history, body);

        prompt.rendered_tools = vec![tool];

        let exchange = ProviderExchange::new(prompt).unwrap();
        let kept = exchange.as_value();

        assert!(serde_json::to_string(&exchange).unwrap().len() > 64 * 1_024);
        assert_eq!(kept["renderedMessages"].as_array().map(Vec::len), Some(48));
        assert_eq!(
            kept["requestBody"]["tools"][0]["function"]["parameters"],
            json!(deepest.schema())
        );
        assert_eq!(
            kept["usage"],
            json!({"prompt_tokens": 9000, "completion_tokens": 12})
        );
    }

    #[test]
    fn a_credential_sent_to_the_provider_is_never_kept_wherever_it_sat() {
        let mut sent = record(
            Vec::new(),
            json!({"model": "nvidia/test-model", "api_key": "nvapi-secret", "messages": []}),
        );
        sent.rendered_tools = vec![ChatCompletionTool::new(ChatToolFunction {
            name: "mem0.add".to_owned(),
            description: "Stores a note.".to_owned(),
            parameters: json!({
                "type": "object",
                "examples": [{"text": "a note", "api_key": "m0sk_live"}],
            })
            .as_object()
            .cloned()
            .unwrap(),
            strict: false,
        })];
        let exchange = ProviderExchange::new(sent).unwrap();
        let kept = exchange.as_value();

        assert_eq!(kept["requestBody"]["api_key"], json!("[redacted]"));
        assert_eq!(
            kept["renderedTools"][0]["function"]["parameters"]["examples"][0]["api_key"],
            json!("[redacted]")
        );
        assert_eq!(
            serde_json::from_value::<ProviderExchange>(serde_json::to_value(&exchange).unwrap())
                .unwrap(),
            exchange
        );
    }
}
