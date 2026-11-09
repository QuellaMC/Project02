use p02_shared::{Credentials, Identifier};
use serde_json::{Map, Value};

use crate::role_model::decision::{
    CharacterDecision, DecisionRejection, DecisionRejectionReason, DecisionResult,
};
use crate::role_model::tools::{ModelToolCall, VISIBLE_REPLY};

impl DecisionResult {
    /// The one judge of what a model round wrote. Anything the decision
    /// contract does not allow, from the shape of the answer to a blank
    /// reply, is `malformed_output`, and the details say what to fix: the
    /// model is told them in its next round.
    ///
    /// `credentials` decides what a plugin tool input keeps: its
    /// credential-named values as the model sent them, to run the call, or
    /// redacted, to record the round.
    #[must_use]
    pub fn parse(raw_output: &str, credentials: Credentials) -> Self {
        match parse_decision(raw_output, credentials) {
            Ok(decision) => Self::Accepted { decision },
            Err(details) => Self::Rejected {
                rejection: DecisionRejection {
                    reason: DecisionRejectionReason::MalformedOutput,
                    details: Some(details),
                },
            },
        }
    }
}

fn parse_decision(raw_output: &str, credentials: Credentials) -> Result<CharacterDecision, String> {
    let Ok(output) = serde_json::from_str::<Value>(raw_output) else {
        return Err("Adapter output must be valid JSON.".to_owned());
    };
    let Value::Object(output) = output else {
        return Err("Adapter output must be a CharacterDecision JSON object.".to_owned());
    };

    if let Some(keys) = unsupported_keys(&output, &["toolCalls", "text"]) {
        return Err(format!("Decision includes unsupported fields: {keys}."));
    }

    let Some(Value::Array(calls)) = output.get("toolCalls") else {
        return Err("Decision toolCalls must be an array.".to_owned());
    };

    if calls.is_empty() {
        return Err(
            "Decision toolCalls must not be empty: reply with visible_reply or call a tool."
                .to_owned(),
        );
    }

    let tool_calls = calls
        .iter()
        .enumerate()
        .map(|(index, call)| parse_call(index, call, credentials))
        .collect::<Result<Vec<_>, _>>()?;

    // A thinking model leaves a newline where its reasoning was: blank
    // text is nothing the model said, not a refusal.
    let text = match output.get("text") {
        None => None,
        Some(Value::String(text)) if text.trim().is_empty() => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => return Err("Decision text must be a string.".to_owned()),
    };

    Ok(CharacterDecision::judged(tool_calls, text))
}

fn parse_call(
    index: usize,
    call: &Value,
    credentials: Credentials,
) -> Result<ModelToolCall, String> {
    let Value::Object(call) = call else {
        return Err(format!("Decision toolCalls[{index}] must be an object."));
    };

    if let Some(keys) = unsupported_keys(call, &["name", "input"]) {
        return Err(format!(
            "Decision toolCalls[{index}] includes unsupported fields: {keys}."
        ));
    }

    let Some(Value::String(name)) = call.get("name") else {
        return Err(format!(
            "Decision toolCalls[{index}].name must be a string."
        ));
    };
    let Ok(name) = Identifier::new(name) else {
        return Err(format!(
            "Decision toolCalls[{index}].name must start with a letter and use only letters, \
             numbers, dots, underscores, or hyphens."
        ));
    };
    let Some(Value::Object(input)) = call.get("input") else {
        return Err(format!(
            "Decision toolCalls[{index}].input for tool \"{name}\" must be a JSON object; the \
             tool call's arguments were not one."
        ));
    };

    if name.as_str() == VISIBLE_REPLY {
        return parse_reply(index, input);
    }

    // The tool's own contract is the host's to judge; here the input only
    // has to cross the JSON boundary.
    ModelToolCall::plugin(name, input.clone(), credentials).map_err(|error| format!("{error}."))
}

fn parse_reply(index: usize, input: &Map<String, Value>) -> Result<ModelToolCall, String> {
    let Some(Value::String(text)) = input.get("text") else {
        return Err(format!(
            "Decision toolCalls[{index}].input.text must be a string."
        ));
    };

    if let Some(keys) = unsupported_keys(input, &["text"]) {
        return Err(format!(
            "visible_reply input includes unsupported fields: {keys}."
        ));
    }

    ModelToolCall::reply(text).map_err(|error| format!("{error}."))
}

/// The keys of `record` outside `supported`, in document order.
fn unsupported_keys(record: &Map<String, Value>, supported: &[&str]) -> Option<String> {
    let unsupported: Vec<&str> = record
        .keys()
        .map(String::as_str)
        .filter(|key| !supported.contains(key))
        .collect();

    (!unsupported.is_empty()).then(|| unsupported.join(", "))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::role_model::decision::DECISION_CONTRACT_VERSION;

    fn accepted(raw: &Value) -> CharacterDecision {
        match DecisionResult::parse(&raw.to_string(), Credentials::Redact) {
            DecisionResult::Accepted { decision } => decision,
            DecisionResult::Rejected { rejection } => panic!("{raw}: {rejection:?}"),
        }
    }

    fn reply(text: &str) -> Value {
        json!({"name": "visible_reply", "input": {"text": text}})
    }

    #[test]
    fn an_answer_in_the_contract_becomes_a_stamped_decision() {
        let decision = accepted(&json!({
            "toolCalls": [
                reply("<think>plan it</think> first\r\n"),
                reply("second"),
                {"name": "character_state.patch", "input": {"mood": "angry"}},
            ],
            "text": "Let me check what I remember.",
        }));

        assert_eq!(
            serde_json::to_value(&decision).unwrap(),
            json!({
                "version": DECISION_CONTRACT_VERSION,
                "toolCalls": [
                    reply("first"),
                    reply("second"),
                    {"name": "character_state.patch", "input": {"mood": "angry"}},
                ],
                "text": "Let me check what I remember.",
            })
        );
        assert_eq!(
            accepted(&json!({"toolCalls": [reply("hi")], "text": " \n\t "})).text(),
            None
        );
    }

    #[test]
    fn an_answer_outside_the_contract_is_malformed_with_what_to_fix() {
        let many_fields: Map<String, Value> = (0..257)
            .map(|index| (format!("field{index}"), json!(index)))
            .collect();
        let cases = [
            ("not json".to_owned(), "Adapter output must be valid JSON."),
            (
                r#"{"toolCalls":[{"name":"visible_reply","input":{"text":"\ud83d"}}]}"#.to_owned(),
                "Adapter output must be valid JSON.",
            ),
            (
                "[]".to_owned(),
                "Adapter output must be a CharacterDecision JSON object.",
            ),
            (
                json!({
                    "version": DECISION_CONTRACT_VERSION,
                    "toolCalls": [reply("hello")],
                    "sideEffect": "write a file",
                })
                .to_string(),
                "Decision includes unsupported fields: version, sideEffect.",
            ),
            (
                json!({"toolCalls": "visible_reply"}).to_string(),
                "Decision toolCalls must be an array.",
            ),
            (
                json!({"toolCalls": [], "text": "folded model note"}).to_string(),
                "Decision toolCalls must not be empty: reply with visible_reply or call a tool.",
            ),
            (
                json!({"toolCalls": ["visible_reply"]}).to_string(),
                "Decision toolCalls[0] must be an object.",
            ),
            (
                json!({"toolCalls": [{"tool": "visible_reply", "input": {}}]}).to_string(),
                "Decision toolCalls[0] includes unsupported fields: tool.",
            ),
            (
                json!({"toolCalls": [{"name": 7, "input": {}}]}).to_string(),
                "Decision toolCalls[0].name must be a string.",
            ),
            (
                json!({"toolCalls": [{"name": "memory search", "input": {}}]}).to_string(),
                "Decision toolCalls[0].name must start with a letter and use only letters, \
                 numbers, dots, underscores, or hyphens.",
            ),
            (
                json!({"toolCalls": [{"name": "memory.search", "input": "{\"query\": nope"}]})
                    .to_string(),
                "Decision toolCalls[0].input for tool \"memory.search\" must be a JSON object; \
                 the tool call's arguments were not one.",
            ),
            (
                json!({"toolCalls": [{"name": "visible_reply", "input": {"text": 1}}]}).to_string(),
                "Decision toolCalls[0].input.text must be a string.",
            ),
            (
                json!({
                    "toolCalls": [{"name": "visible_reply", "input": {"text": "hi", "mood": "x"}}],
                })
                .to_string(),
                "visible_reply input includes unsupported fields: mood.",
            ),
            (
                json!({"toolCalls": [reply("<think>still thinking")]}).to_string(),
                "visible_reply text must not be empty.",
            ),
            (
                json!({"toolCalls": [reply("   ")]}).to_string(),
                "visible_reply text must not be empty.",
            ),
            (
                json!({"toolCalls": [reply("hi")], "text": 3}).to_string(),
                "Decision text must be a string.",
            ),
            (
                json!({"toolCalls": [{"name": "memory.capture", "input": many_fields}]})
                    .to_string(),
                "Model tool \"memory.capture\" input exceeds the JSON container entry limit.",
            ),
        ];

        for (raw, details) in cases {
            assert_eq!(
                DecisionResult::parse(&raw, Credentials::Redact),
                DecisionResult::Rejected {
                    rejection: DecisionRejection {
                        reason: DecisionRejectionReason::MalformedOutput,
                        details: Some(details.to_owned()),
                    }
                },
                "{raw}"
            );
        }
    }

    #[test]
    fn a_tool_input_keeps_its_credentials_to_run_and_redacts_them_to_record() {
        let raw = json!({"toolCalls": [{"name": "mem0.add", "input": {"api_key": "m0sk_live"}}]})
            .to_string();
        let input = |credentials| match DecisionResult::parse(&raw, credentials) {
            DecisionResult::Accepted { decision } => {
                serde_json::to_value(decision.tool_calls()).unwrap()[0]["input"].clone()
            }
            DecisionResult::Rejected { rejection } => panic!("{rejection:?}"),
        };

        assert_eq!(input(Credentials::Keep), json!({"api_key": "m0sk_live"}));
        assert_eq!(input(Credentials::Redact), json!({"api_key": "[redacted]"}));
    }
}
