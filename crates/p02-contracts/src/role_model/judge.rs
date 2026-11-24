use p02_core::AppNames;
use p02_shared::Identifier;
use serde_json::{Map, Value};

use crate::role_model::answer::{ModelOutput, ProviderAnswer, WrittenCall};
use crate::role_model::decision::{
    CharacterDecision, DecisionRejection, DecisionRejectionReason, DecisionResult, Occasion,
};
use crate::role_model::tools::{ModelToolCall, SEND_MESSAGE};

impl DecisionResult {
    /// The one verdict on a model round of a turn begun from `occasion`,
    /// for her with `apps`, the apps she has now. A provider that failed is
    /// `provider_error`. Text beside the model's calls is its note. With no
    /// call, its text alone is its reply in a turn the person began, and a
    /// thought the character keeps in a moment of her own, where an answer
    /// of nothing at all stands too. Anything else, from no answer in a
    /// person's turn to a call the runtime cannot make or a message in an
    /// app she does not have, is `malformed_output`, and the details say
    /// what to fix, since the model is told them in its next round. A
    /// call's input keeps its credential-named values, to run the call.
    #[must_use]
    pub fn judge(answer: &ProviderAnswer, occasion: Occasion, apps: &AppNames) -> Self {
        let (reason, details) = match answer {
            ProviderAnswer::Answered { output, .. } => match decide(output, occasion, apps) {
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

fn decide(
    output: &ModelOutput,
    occasion: Occasion,
    apps: &AppNames,
) -> Result<CharacterDecision, String> {
    // A thinking model leaves a newline where its reasoning was: blank text
    // is nothing the model said.
    let text = output
        .text
        .as_deref()
        .filter(|text| !text.trim().is_empty());

    if output.tool_calls.is_empty() {
        return match occasion {
            Occasion::Line => {
                let text =
                    text.ok_or("Nothing was sent. Send a message, or do something first.")?;
                let reply =
                    ModelToolCall::reply(text, None).map_err(|error| format!("{error}."))?;

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
        .map(|call| judge_call(call, apps))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(CharacterDecision::judged(calls, text.map(str::to_owned)))
}

fn judge_call(call: &WrittenCall, apps: &AppNames) -> Result<ModelToolCall, String> {
    let Ok(name) = Identifier::new(&call.name) else {
        return Err(format!("\"{}\" is not the name of a tool.", call.name));
    };
    let Value::Object(input) = &call.input else {
        return Err(format!("The arguments of {name} must be a JSON object."));
    };

    if name.as_str() == SEND_MESSAGE {
        return judge_reply(input, apps);
    }

    // The tool's own contract is the host's to judge; here the input only
    // has to cross the JSON boundary.
    ModelToolCall::plugin(name, input.clone()).map_err(|error| format!("{error}."))
}

/// A message: its text, and the app it goes in when she names one, which
/// must be one of `apps`, those she has now.
fn judge_reply(input: &Map<String, Value>, apps: &AppNames) -> Result<ModelToolCall, String> {
    let Some(Value::String(text)) = input.get("text") else {
        return Err("Nothing was sent. A message needs its text as a string.".to_owned());
    };
    let others: Vec<&str> = input
        .keys()
        .map(String::as_str)
        .filter(|key| !["text", "app"].contains(key))
        .collect();

    if !others.is_empty() {
        return Err(format!(
            "Nothing was sent. A message takes only its text, not {}.",
            others.join(", ")
        ));
    }

    let app = match input.get("app") {
        None => None,
        Some(Value::String(app)) if apps.has(app) => Some(app.clone()),
        Some(named) => {
            let named = named
                .as_str()
                .map_or_else(|| named.to_string(), str::to_owned);

            return Err(format!(
                "Nothing was sent. You have no app called \"{named}\"."
            ));
        }
    };

    ModelToolCall::reply(text, app).map_err(|error| format!("{error}."))
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

    /// The apps she has in these rounds: Messages and Telegram.
    fn apps() -> AppNames {
        AppNames::new([("telegram", "Telegram")])
    }

    fn accepted(answer: &ProviderAnswer, occasion: Occasion) -> Value {
        match DecisionResult::judge(answer, occasion, &apps()) {
            DecisionResult::Accepted { decision } => serde_json::to_value(decision).unwrap(),
            DecisionResult::Rejected { rejection } => panic!("{answer:?}: {rejection:?}"),
        }
    }

    /// A message as the model sends it.
    fn sent(text: &str) -> Value {
        json!({"name": "send_message", "input": {"text": text}})
    }

    /// A message as the model sends it in `app`.
    fn sent_in(text: &str, app: &str) -> Value {
        json!({"name": "send_message", "input": {"text": text, "app": app}})
    }

    /// A message as the decision keeps it on the record.
    fn kept(text: &str) -> Value {
        json!({"name": "visible_reply", "input": {"text": text}})
    }

    /// A message of hers is kept with the app she named, one she has: the
    /// app's own chat too, while it is her only one.
    #[test]
    fn calls_are_the_decision_text_beside_them_its_note_and_text_alone_the_reply() {
        let calls = [
            sent("<think>plan it</think> first\r\n"),
            sent_in("second", "telegram"),
            json!({"name": "character_state.patch", "input": {"mood": "angry"}}),
        ];

        assert_eq!(
            accepted(
                &answered(&calls, Some("Let me check what I remember.")),
                Occasion::Line
            ),
            json!({
                "toolCalls": [
                    kept("first"),
                    {"name": "visible_reply", "input": {"text": "second", "app": "telegram"}},
                    {"name": "character_state.patch", "input": {"mood": "angry"}},
                ],
                "text": "Let me check what I remember.",
            })
        );
        assert!(matches!(
            DecisionResult::judge(
                &answered(&[sent_in("hi", "messages")], None),
                Occasion::Line,
                &AppNames::new([])
            ),
            DecisionResult::Accepted { .. }
        ));
        assert_eq!(
            accepted(&answered(&[sent("hi")], Some(" \n\t ")), Occasion::Line),
            json!({"toolCalls": [kept("hi")]})
        );
        assert_eq!(
            accepted(
                &answered(&[], Some("<reasoning>hm</reasoning>Plain hello.")),
                Occasion::Line
            ),
            json!({"toolCalls": [kept("Plain hello.")]})
        );
    }

    /// In a moment of her own, her calls are judged as in any turn, and a
    /// round with none is hers to end: its text a thought kept as written,
    /// or nothing at all.
    #[test]
    fn in_a_moment_text_alone_is_a_thought_and_nothing_at_all_ends_it() {
        assert_eq!(
            accepted(
                &answered(&[sent("Thinking of you.")], Some("I miss them.")),
                Occasion::Moment
            ),
            json!({"toolCalls": [kept("Thinking of you.")], "text": "I miss them."})
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
                "Nothing was sent. Send a message, or do something first.",
                line,
            ),
            (
                answered(&[], Some(" \n")),
                "Nothing was sent. Send a message, or do something first.",
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
                        sent("hi"),
                        json!({"name": "memory.search", "input": "{\"query\": nope"}),
                    ],
                    None,
                ),
                "The arguments of memory.search must be a JSON object.",
                any,
            ),
            (
                answered(
                    &[json!({"name": "send_message", "input": {"text": 1}})],
                    None,
                ),
                "Nothing was sent. A message needs its text as a string.",
                any,
            ),
            (
                answered(
                    &[json!({"name": "send_message", "input": {"text": "hi", "mood": "x"}})],
                    None,
                ),
                "Nothing was sent. A message takes only its text, not mood.",
                any,
            ),
            (
                answered(&[sent_in("hi", "whatsapp")], None),
                "Nothing was sent. You have no app called \"whatsapp\".",
                any,
            ),
            (
                answered(&[sent("<think>still thinking")], None),
                "Nothing was sent. The message was empty.",
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
                    DecisionResult::judge(&answer, occasion, &apps()),
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
