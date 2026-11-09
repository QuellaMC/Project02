use p02_shared::Identifier;
use serde_json::{Map, Value};

use crate::role_model::answer::{ModelOutput, ProviderAnswer, WrittenCall};
use crate::role_model::decision::{
    CharacterDecision, DecisionRejection, DecisionRejectionReason, DecisionResult,
};
use crate::role_model::tools::{ModelToolCall, VISIBLE_REPLY};

impl DecisionResult {
    /// The one verdict on a model round. A provider that failed is
    /// `provider_error`. In a person's turn the model replies or calls a
    /// tool: its text alone is its reply, and text beside its calls is its
    /// note; anything else, from no answer at all to a call the runtime
    /// cannot make, is `malformed_output`, and the details say what to
    /// fix, since the model is told them in its next round. A call's input
    /// keeps its credential-named values, to run the call.
    #[must_use]
    pub fn judge(answer: &ProviderAnswer) -> Self {
        let (reason, details) = match answer {
            ProviderAnswer::Answered { output, .. } => match decide(output) {
                Ok(decision) => return Self::Accepted { decision },
                Err(details) => (DecisionRejectionReason::MalformedOutput, details),
            },
            ProviderAnswer::Failed(failure) => (
                DecisionRejectionReason::ProviderError,
                failure.message.clone(),
            ),
        };

        Self::Rejected {
            rejection: DecisionRejection {
                reason,
                details: Some(details),
            },
        }
    }
}

fn decide(output: &ModelOutput) -> Result<CharacterDecision, String> {
    // A thinking model leaves a newline where its reasoning was: blank text
    // is nothing the model said.
    let text = output
        .text
        .as_deref()
        .filter(|text| !text.trim().is_empty());

    if output.tool_calls.is_empty() {
        let text = text.ok_or("Reply with visible_reply or call a tool.")?;
        let reply = ModelToolCall::reply(text).map_err(|error| format!("{error}."))?;

        return Ok(CharacterDecision::judged(vec![reply], None));
    }

    let calls = output
        .tool_calls
        .iter()
        .map(judge_call)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(CharacterDecision::judged(calls, text.map(str::to_owned)))
}

fn judge_call(call: &WrittenCall) -> Result<ModelToolCall, String> {
    let Ok(name) = Identifier::new(&call.name) else {
        return Err(format!("\"{}\" is not the name of a tool.", call.name));
    };
    let Value::Object(input) = &call.input else {
        return Err(format!("The arguments of {name} must be a JSON object."));
    };

    if name.as_str() == VISIBLE_REPLY {
        return judge_reply(input);
    }

    // The tool's own contract is the host's to judge; here the input only
    // has to cross the JSON boundary.
    ModelToolCall::plugin(name, input.clone()).map_err(|error| format!("{error}."))
}

fn judge_reply(input: &Map<String, Value>) -> Result<ModelToolCall, String> {
    let Some(Value::String(text)) = input.get("text") else {
        return Err("visible_reply needs its text as a string.".to_owned());
    };
    let others: Vec<&str> = input
        .keys()
        .map(String::as_str)
        .filter(|key| *key != "text")
        .collect();

    if !others.is_empty() {
        return Err(format!(
            "visible_reply takes only text, not {}.",
            others.join(", ")
        ));
    }

    ModelToolCall::reply(text).map_err(|error| format!("{error}."))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn answered(calls: &[Value], text: Option<&str>) -> ProviderAnswer {
        ProviderAnswer::Answered {
            output: ModelOutput {
                tool_calls: calls
                    .iter()
                    .map(|call| WrittenCall {
                        name: call["name"].as_str().unwrap().to_owned(),
                        input: call["input"].clone(),
                    })
                    .collect(),
                text: text.map(str::to_owned),
            },
            finish_reason: None,
            usage: None,
        }
    }

    fn accepted(answer: &ProviderAnswer) -> Value {
        match DecisionResult::judge(answer) {
            DecisionResult::Accepted { decision } => serde_json::to_value(decision).unwrap(),
            DecisionResult::Rejected { rejection } => panic!("{answer:?}: {rejection:?}"),
        }
    }

    fn reply(text: &str) -> Value {
        json!({"name": "visible_reply", "input": {"text": text}})
    }

    #[test]
    fn calls_are_the_decision_text_beside_them_its_note_and_text_alone_the_reply() {
        let calls = [
            reply("<think>plan it</think> first\r\n"),
            reply("second"),
            json!({"name": "character_state.patch", "input": {"mood": "angry"}}),
        ];

        assert_eq!(
            accepted(&answered(&calls, Some("Let me check what I remember."))),
            json!({
                "toolCalls": [
                    reply("first"),
                    reply("second"),
                    {"name": "character_state.patch", "input": {"mood": "angry"}},
                ],
                "text": "Let me check what I remember.",
            })
        );
        assert_eq!(
            accepted(&answered(&[reply("hi")], Some(" \n\t "))),
            json!({"toolCalls": [reply("hi")]})
        );
        assert_eq!(
            accepted(&answered(
                &[],
                Some("<reasoning>hm</reasoning>Plain hello.")
            )),
            json!({"toolCalls": [reply("Plain hello.")]})
        );
    }

    #[test]
    fn what_cannot_be_acted_on_is_malformed_with_what_to_fix() {
        let many_fields: Map<String, Value> = (0..257)
            .map(|index| (format!("field{index}"), json!(index)))
            .collect();
        let cases = [
            (
                answered(&[], None),
                "Reply with visible_reply or call a tool.",
            ),
            (
                answered(&[], Some(" \n")),
                "Reply with visible_reply or call a tool.",
            ),
            (
                answered(&[json!({"name": "memory search", "input": {}})], None),
                "\"memory search\" is not the name of a tool.",
            ),
            (
                answered(
                    &[
                        reply("hi"),
                        json!({"name": "memory.search", "input": "{\"query\": nope"}),
                    ],
                    None,
                ),
                "The arguments of memory.search must be a JSON object.",
            ),
            (
                answered(
                    &[json!({"name": "visible_reply", "input": {"text": 1}})],
                    None,
                ),
                "visible_reply needs its text as a string.",
            ),
            (
                answered(
                    &[json!({"name": "visible_reply", "input": {"text": "hi", "mood": "x"}})],
                    None,
                ),
                "visible_reply takes only text, not mood.",
            ),
            (
                answered(&[reply("<think>still thinking")], None),
                "visible_reply text must not be empty.",
            ),
            (
                answered(
                    &[json!({"name": "memory.capture", "input": many_fields})],
                    None,
                ),
                "Model tool \"memory.capture\" input exceeds the JSON container entry limit.",
            ),
        ];

        for (answer, details) in cases {
            assert_eq!(
                DecisionResult::judge(&answer),
                DecisionResult::Rejected {
                    rejection: DecisionRejection {
                        reason: DecisionRejectionReason::MalformedOutput,
                        details: Some(details.to_owned()),
                    }
                },
                "{answer:?}"
            );
        }
    }
}
