use p02_shared::Identifier;
use serde_json::{Map, Value};

use crate::role_model::answer::{ModelOutput, ProviderAnswer, WrittenCall};
use crate::role_model::decision::{
    CharacterDecision, DecisionRejection, DecisionRejectionReason, DecisionResult, Occasion,
};
use crate::role_model::tools::{ModelToolCall, VISIBLE_REPLY};

impl DecisionResult {
    /// The one verdict on a model round of a turn begun from `occasion`. A
    /// provider that failed is `provider_error`. Text beside the model's
    /// calls is its note. With no call, its text alone is its reply in a
    /// turn the person began, and a thought the character keeps in a moment
    /// of her own, where an answer of nothing at all stands too. Anything
    /// else, from no answer in a person's turn to a call the runtime cannot
    /// make, is `malformed_output`, and the details say what to fix, since
    /// the model is told them in its next round. A call's input keeps its
    /// credential-named values, to run the call.
    #[must_use]
    pub fn judge(answer: &ProviderAnswer, occasion: Occasion) -> Self {
        let (reason, details) = match answer {
            ProviderAnswer::Answered { output, .. } => match decide(output, occasion) {
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

fn decide(output: &ModelOutput, occasion: Occasion) -> Result<CharacterDecision, String> {
    // A thinking model leaves a newline where its reasoning was: blank text
    // is nothing the model said.
    let text = output
        .text
        .as_deref()
        .filter(|text| !text.trim().is_empty());

    if output.tool_calls.is_empty() {
        return match occasion {
            Occasion::Line => {
                let text = text.ok_or("Reply with visible_reply or call a tool.")?;
                let reply = ModelToolCall::reply(text).map_err(|error| format!("{error}."))?;

                Ok(CharacterDecision::judged(vec![reply], None))
            }
            Occasion::Moment => Ok(CharacterDecision::judged(
                Vec::new(),
                text.map(str::to_owned),
            )),
        };
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

    fn accepted(answer: &ProviderAnswer, occasion: Occasion) -> Value {
        match DecisionResult::judge(answer, occasion) {
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
            accepted(
                &answered(&calls, Some("Let me check what I remember.")),
                Occasion::Line
            ),
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
            accepted(&answered(&[reply("hi")], Some(" \n\t ")), Occasion::Line),
            json!({"toolCalls": [reply("hi")]})
        );
        assert_eq!(
            accepted(
                &answered(&[], Some("<reasoning>hm</reasoning>Plain hello.")),
                Occasion::Line
            ),
            json!({"toolCalls": [reply("Plain hello.")]})
        );
    }

    /// In a moment of her own, her calls are judged as in any turn, and a
    /// round with none is hers to end: its text a thought kept as written,
    /// or nothing at all.
    #[test]
    fn in_a_moment_text_alone_is_a_thought_and_nothing_at_all_ends_it() {
        assert_eq!(
            accepted(
                &answered(&[reply("Thinking of you.")], Some("I miss them.")),
                Occasion::Moment
            ),
            json!({"toolCalls": [reply("Thinking of you.")], "text": "I miss them."})
        );
        assert_eq!(
            accepted(
                &answered(&[], Some("<think>hm</think>I miss them.")),
                Occasion::Moment
            ),
            json!({"toolCalls": [], "text": "<think>hm</think>I miss them."})
        );

        for nothing in [answered(&[], None), answered(&[], Some(" \n"))] {
            assert_eq!(
                accepted(&nothing, Occasion::Moment),
                json!({"toolCalls": []})
            );
        }
    }

    #[test]
    fn what_cannot_be_acted_on_is_malformed_with_what_to_fix() {
        let many_fields: Map<String, Value> = (0..257)
            .map(|index| (format!("field{index}"), json!(index)))
            .collect();
        let line = [Occasion::Line].as_slice();
        let any = [Occasion::Line, Occasion::Moment].as_slice();
        let cases = [
            (
                answered(&[], None),
                "Reply with visible_reply or call a tool.",
                line,
            ),
            (
                answered(&[], Some(" \n")),
                "Reply with visible_reply or call a tool.",
                line,
            ),
            (
                answered(&[json!({"name": "memory search", "input": {}})], None),
                "\"memory search\" is not the name of a tool.",
                any,
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
                any,
            ),
            (
                answered(
                    &[json!({"name": "visible_reply", "input": {"text": 1}})],
                    None,
                ),
                "visible_reply needs its text as a string.",
                any,
            ),
            (
                answered(
                    &[json!({"name": "visible_reply", "input": {"text": "hi", "mood": "x"}})],
                    None,
                ),
                "visible_reply takes only text, not mood.",
                any,
            ),
            (
                answered(&[reply("<think>still thinking")], None),
                "visible_reply text must not be empty.",
                any,
            ),
            (
                answered(
                    &[json!({"name": "memory.capture", "input": many_fields})],
                    None,
                ),
                "Model tool \"memory.capture\" input exceeds the JSON container entry limit.",
                any,
            ),
        ];

        for (answer, details, occasions) in cases {
            for &occasion in occasions {
                assert_eq!(
                    DecisionResult::judge(&answer, occasion),
                    DecisionResult::Rejected {
                        rejection: DecisionRejection {
                            reason: DecisionRejectionReason::MalformedOutput,
                            details: Some(details.to_owned()),
                        }
                    },
                    "{answer:?} in a turn begun from {occasion:?}"
                );
            }
        }
    }
}
