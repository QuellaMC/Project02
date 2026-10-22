//! The tools as a provider is offered them: each tool's own input contract
//! as its parameters, strict only where the provider can hold a call to the
//! schema exactly, and under a name the provider can take.

use std::collections::HashSet;

use p02_contracts::{ChatCompletionTool, ChatToolFunction, ModelToolDefinition, ToolNameMapping};
use p02_shared::Identifier;
use serde_json::{Map, Value};

pub(crate) fn chat_tool(definition: &ModelToolDefinition) -> ChatCompletionTool {
    ChatCompletionTool::new(ChatToolFunction {
        name: definition.name.clone(),
        description: definition.description.clone(),
        parameters: definition.input_contract.clone(),
        strict: closed(&definition.input_contract),
    })
}

/// The keywords a closed schema may hold: one the walk does not know costs
/// the strict flag, never the request.
const CLOSED_KEYWORDS: [&str; 7] = [
    "type",
    "description",
    "enum",
    "properties",
    "required",
    "additionalProperties",
    "items",
];

/// Whether a schema is closed at every level, so strict mode can hold a
/// call to it: only the keywords the walk knows, every object closed to
/// properties it does not list, and every part of it closed in turn.
fn closed(schema: &Map<String, Value>) -> bool {
    if !schema
        .keys()
        .all(|keyword| CLOSED_KEYWORDS.contains(&keyword.as_str()))
    {
        return false;
    }

    let types: Vec<&str> = match schema.get("type") {
        Some(Value::String(name)) => vec![name.as_str()],
        Some(Value::Array(names)) => names.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    let closed_part = |part: &Value| part.as_object().is_some_and(closed);

    if types.contains(&"object") {
        let properties_closed = schema
            .get("properties")
            .and_then(Value::as_object)
            .is_none_or(|properties| properties.values().all(closed_part));

        if schema.get("additionalProperties") != Some(&Value::Bool(false)) || !properties_closed {
            return false;
        }
    }

    !types.contains(&"array") || schema.get("items").is_none_or(closed_part)
}

/// Every tool's name as the provider is shown it, in the order offered:
/// what a provider cannot take in a function name becomes `_`, and a name
/// that two tools would then share takes the first number that frees it.
pub(crate) fn provider_names(tools: &[ChatCompletionTool]) -> Vec<ToolNameMapping> {
    let mut taken = HashSet::new();
    let mut mappings = Vec::new();

    for tool in tools {
        let safe = provider_safe(&tool.function().name);
        let mut provider_name = safe.clone();
        let mut suffix = 1;

        while taken.contains(&provider_name) {
            suffix += 1;
            provider_name = format!("{safe}_{suffix}");
        }

        taken.insert(provider_name.clone());

        if let Ok(runtime_name) = Identifier::new(&tool.function().name) {
            mappings.push(ToolNameMapping {
                runtime_name,
                provider_name,
            });
        }
    }

    mappings
}

/// The name the provider knows the runtime's tool `runtime_name` by. A tool
/// this round does not offer, as a replayed call can name, is shown under
/// its provider-safe spelling.
pub(crate) fn provider_name(runtime_name: &str, mappings: &[ToolNameMapping]) -> String {
    mappings
        .iter()
        .find(|mapping| mapping.runtime_name.as_str() == runtime_name)
        .map_or_else(
            || provider_safe(runtime_name),
            |mapping| mapping.provider_name.clone(),
        )
}

/// The runtime's name for the tool the provider called `provider_name`, or
/// the name as the provider wrote it when it names no tool offered.
pub(crate) fn runtime_name(provider_name: &str, mappings: &[ToolNameMapping]) -> String {
    mappings
        .iter()
        .find(|mapping| mapping.provider_name == provider_name)
        .map_or_else(
            || provider_name.to_owned(),
            |mapping| mapping.runtime_name.to_string(),
        )
}

/// Letters, digits, `_` and `-`, starting with a letter.
fn provider_safe(name: &str) -> String {
    let safe: String = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '_'
            }
        })
        .collect();

    if safe.starts_with(|character: char| character.is_ascii_alphabetic()) {
        safe
    } else {
        format!("tool_{safe}")
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn tool(name: &str, schema: &Value) -> ChatCompletionTool {
        chat_tool(&ModelToolDefinition {
            name: name.to_owned(),
            description: "A tool.".to_owned(),
            input_contract: schema.as_object().cloned().unwrap(),
        })
    }

    /// model.tool-schema-open-union: a tool whose schema holds an open object or array union, or open items, is not sent strict, while one closed at every level is
    #[test]
    fn only_a_schema_closed_at_every_level_is_sent_strict() {
        let closed = json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["memory"],
            "properties": {
                "memory": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "tags": {"type": "array", "items": {"type": "string"}},
                        "note": {"type": ["string", "null"], "description": "A note."},
                    },
                },
            },
        });
        let open_union = json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {"value": {"type": ["object", "null"], "additionalProperties": true}},
        });
        let combinator = json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {"pick": {"oneOf": [{"type": "string"}, {"type": "number"}]}},
        });
        let open_items = json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {"list": {"type": "array", "items": {"type": "object"}}},
        });

        assert!(tool("memory.capture", &closed).function().strict);

        for open in [open_union, combinator, open_items] {
            assert!(!tool("memory.pick", &open).function().strict, "{open}");
        }
    }

    #[test]
    fn a_tool_is_shown_under_a_name_the_provider_takes_and_called_back_by_its_own() {
        let schema = json!({"type": "object"});
        let tools: Vec<ChatCompletionTool> = [
            "visible_reply",
            "memory.search",
            "memory_search",
            "memory_search_2",
        ]
        .into_iter()
        .map(|name| tool(name, &schema))
        .collect();
        let mappings = provider_names(&tools);
        let shown: Vec<&str> = mappings
            .iter()
            .map(|mapping| mapping.provider_name.as_str())
            .collect();

        assert_eq!(
            shown,
            [
                "visible_reply",
                "memory_search",
                "memory_search_2",
                "memory_search_2_2"
            ]
        );
        assert_eq!(runtime_name("memory_search_2", &mappings), "memory_search");
        assert_eq!(runtime_name("memory_list", &mappings), "memory_list");
        assert_eq!(provider_name("memory.search", &mappings), "memory_search");
        assert_eq!(
            provider_name("runtime.plugin.list", &mappings),
            "runtime_plugin_list"
        );
    }
}
