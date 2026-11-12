//! The Responses adapter, as the OpenAI API's, against a model server on
//! the loopback interface.

use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

use p02_contracts::{
    ChatFunctionCall, ChatMessage, ChatToolCall, Invocation, ProviderAnswer, ProviderName,
    ReplyDelta, RoleModelAdapter, TextCompletion, TextCompletionRequest, ToolCallId,
};
use p02_role_model::{OpenaiSettings, ServiceSettings, select_adapter};
use serde_json::{Value, json};

use crate::stub::{Answer, Stub};
use crate::support::wire;

const KEY: &str = "sk-fixture-key";

type Adapter = Arc<dyn RoleModelAdapter>;

/// The OpenAI API at the stub, as a test harness names it.
fn adapter(stub: &Stub) -> Adapter {
    select_adapter(
        None,
        Some(&ServiceSettings::Openai(OpenaiSettings {
            api_key: Some(KEY.to_owned()),
            model: "gpt-6-luna".to_owned(),
            base_url: Some(stub.at("openai/v1")),
        })),
        None,
    )
    .unwrap()
    .unwrap()
}

/// The events that stream a call of `name` at `index`, its arguments in
/// `pieces`, and the call as the finished response holds it.
fn call(index: u64, name: &str, pieces: &[&str]) -> (Vec<String>, Value) {
    let item = |arguments: &str| {
        json!({
            "type": "function_call",
            "id": format!("fc_{index}"),
            "call_id": format!("call_model_{index}"),
            "name": name,
            "arguments": arguments,
        })
    };
    let added =
        json!({"type": "response.output_item.added", "output_index": index, "item": item("")});
    let deltas = pieces.iter().map(|piece| {
        json!({
            "type": "response.function_call_arguments.delta",
            "output_index": index,
            "item_id": format!("fc_{index}"),
            "delta": piece,
        })
    });

    (
        std::iter::once(added)
            .chain(deltas)
            .map(|event| event.to_string())
            .collect(),
        item(&pieces.concat()),
    )
}

/// A message item holding `text`.
fn message(text: &str) -> Value {
    json!({
        "type": "message",
        "role": "assistant",
        "content": [{"type": "output_text", "text": text}],
    })
}

/// The event that ends a response as `response` stands.
fn ended(kind: &str, response: &Value) -> String {
    json!({"type": format!("response.{kind}"), "response": response}).to_string()
}

/// How the round failed: its code, what it says, and the status that
/// answered, if one did.
fn failure(answer: &ProviderAnswer) -> (String, String, Option<u16>) {
    match answer {
        ProviderAnswer::Failed(failure) => (
            failure.code.clone(),
            failure.message.clone(),
            failure.status,
        ),
        ProviderAnswer::Answered { .. } => panic!("the round was answered: {answer:?}"),
    }
}

/// A round of the loop with only her reply offered.
async fn invoke(adapter: &Adapter) -> ProviderAnswer {
    let (messages, tools) = wire(&["visible_reply"]);

    adapter.invoke(&Invocation::new(&messages, &tools)).await
}

/// Two rounds of hers that searched her memory, as the runtime replays
/// them: each call under the runtime's own id, then its result.
fn two_searches() -> Vec<ChatMessage> {
    let id = |round: u32| {
        ToolCallId::new(&format!(
            "evt_00000000-0000-4000-8000-000000000000.trace_00000000-0000-4000-8000-\
             000000000001.round-{round}.1.memory.search"
        ))
        .unwrap()
    };

    [1, 2]
        .into_iter()
        .flat_map(|round| {
            [
                ChatMessage::Assistant {
                    content: (round == 1).then(|| "Looking.".to_owned()),
                    tool_calls: vec![ChatToolCall::new(
                        id(round),
                        ChatFunctionCall {
                            name: "memory.search".to_owned(),
                            arguments: format!("{{\"q\":\"{round}\"}}"),
                        },
                    )],
                },
                ChatMessage::Tool {
                    content: format!("{{\"found\":{round}}}"),
                    tool_call_id: id(round),
                },
            ]
        })
        .collect()
}

/// Search `round` as a request shows it: the call under the id the
/// request gives it, then its result, tied to it by that id.
fn shown_search(round: u32) -> [Value; 2] {
    [
        json!({
            "type": "function_call",
            "call_id": format!("call_{round}"),
            "name": "memory_search",
            "arguments": format!("{{\"q\":\"{round}\"}}"),
        }),
        json!({
            "type": "function_call_output",
            "call_id": format!("call_{round}"),
            "output": format!("{{\"found\":{round}}}"),
        }),
    ]
}

/// A tool of the test's world as the protocol offers it.
fn offered(name: &str) -> Value {
    json!({
        "type": "function",
        "name": name,
        "description": "A tool.",
        "parameters": {"type": "object"},
        "strict": false,
    })
}

#[tokio::test]
async fn a_round_goes_out_in_the_protocol_s_terms_and_its_answer_is_read_back_as_written() {
    let stub = Stub::start().await;
    let (mut messages, tools) = wire(&["visible_reply", "memory.search"]);

    messages.extend(two_searches());

    let (reply, replied) = call(0, "visible_reply", &["{\"text\":\"Hel", "lo.\"}"]);
    let (search, searched) = call(1, "memory_search", &["{\"q\":", "\"sky\"}"]);
    let response = json!({
        "status": "completed",
        "output": [replied, searched, message("A note.")],
        "usage": {"input_tokens": 12, "output_tokens": 34, "total_tokens": 46},
    });

    stub.answer(Answer::events(
        &[reply, search, vec![ended("completed", &response)]].concat(),
    ));

    let heard = Mutex::new(Vec::new());
    let listener = |delta: ReplyDelta| heard.lock().unwrap().push(delta.text);
    let answer = adapter(&stub)
        .invoke(&Invocation::new(&messages, &tools).with_reply_listener(&listener))
        .await;
    let [request] = stub.requests().try_into().unwrap();
    let [first, first_result] = shown_search(1);
    let [second, second_result] = shown_search(2);

    assert_eq!(
        (request.path.as_str(), request.authorization.as_deref()),
        (
            "/openai/v1/responses",
            Some(format!("Bearer {KEY}").as_str())
        )
    );
    assert_eq!(
        request.json(),
        json!({
            "model": "gpt-6-luna",
            "input": [
                {"type": "message", "role": "system", "content": "You are Mira."},
                {"type": "message", "role": "user", "content": "Hello?"},
                {"type": "message", "role": "assistant", "content": "Looking."},
                first,
                first_result,
                second,
                second_result,
            ],
            "tools": [offered("visible_reply"), offered("memory_search")],
            "tool_choice": "auto",
            "stream": true,
            "store": false,
            "max_output_tokens": 32_768,
        })
    );
    assert_eq!(*heard.lock().unwrap(), ["Hel", "lo."]);

    let ProviderAnswer::Answered {
        output,
        finish_reason,
        usage,
    } = answer
    else {
        panic!("the round failed: {answer:?}");
    };

    assert_eq!(
        (
            serde_json::to_value(output).unwrap(),
            finish_reason,
            usage.map(|usage| (usage.prompt_tokens, usage.completion_tokens))
        ),
        (
            json!({
                "toolCalls": [
                    {"name": "visible_reply", "input": {"text": "Hello."}},
                    {"name": "memory.search", "input": {"q": "sky"}},
                ],
                "text": "A note.",
            }),
            Some("completed".to_owned()),
            Some((12, 34))
        )
    );
}

#[tokio::test]
async fn every_end_of_a_round_short_of_an_answer_is_said_as_the_service_s_without_the_key() {
    let stub = Stub::start().await;
    let adapter = adapter(&stub);
    let (reply, _) = call(0, "visible_reply", &["{\"text\":\"Half a th"]);
    let (whole, written) = call(0, "visible_reply", &["{\"text\":\"After a 429.\"}"]);
    let refused = |status: u16, message: String| Answer::Whole {
        status,
        body: json!({"error": {"message": message, "type": "invalid_request_error"}}).to_string(),
    };

    stub.answer(refused(429, "Slow down.".to_owned()));
    stub.answer(Answer::events(
        &[
            whole,
            vec![ended(
                "completed",
                &json!({"status": "completed", "output": [written]}),
            )],
        ]
        .concat(),
    ));

    assert_eq!(
        serde_json::to_value(match invoke(&adapter).await {
            ProviderAnswer::Answered { output, .. } => output,
            failed @ ProviderAnswer::Failed(_) => panic!("{failed:?}"),
        })
        .unwrap()["toolCalls"][0]["input"],
        json!({"text": "After a 429."})
    );
    assert_eq!(stub.requests().len(), 2);

    let cases = [
        (
            refused(401, format!("Incorrect API key provided: {KEY}.")),
            "http_error",
            "OpenAI provider error: Incorrect API key provided: [redacted].",
            Some(401),
        ),
        (
            Answer::events(
                &[
                    reply.clone(),
                    vec![
                        json!({"type": "error", "code": "server_error", "message": format!("The key {KEY} broke.")})
                            .to_string(),
                    ],
                ]
                .concat(),
            ),
            "provider_error",
            "OpenAI provider error: The key [redacted] broke.",
            Some(200),
        ),
        (
            Answer::events(&[ended(
                "failed",
                &json!({"status": "failed", "error": {"code": "server_error", "message": "Overloaded."}}),
            )]),
            "provider_error",
            "OpenAI provider error: Overloaded.",
            Some(200),
        ),
        (
            Answer::events(&[ended(
                "incomplete",
                &json!({"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}),
            )]),
            "provider_error",
            "OpenAI response ended incomplete: max_output_tokens.",
            Some(200),
        ),
        (
            Answer::events(&reply),
            "malformed_response",
            "OpenAI response ended before it finished.",
            Some(200),
        ),
    ];

    for (scripted, code, message, status) in cases {
        stub.answer(scripted);

        let answer = invoke(&adapter).await;

        assert_eq!(
            failure(&answer),
            (code.to_owned(), message.to_owned(), status),
            "{message}"
        );
        assert!(!format!("{answer:?}").contains(KEY));
    }

    // Two for the 429, then one each: a refusal is not tried again.
    assert_eq!(stub.requests().len(), 2 + 5);
}

#[tokio::test]
async fn a_plain_completion_asks_the_same_model_and_reads_its_text() {
    let stub = Stub::start().await;
    let adapter = adapter(&stub);
    let request = TextCompletionRequest {
        instructions: "Condense.".to_owned(),
        input: "<conversation>...</conversation>".to_owned(),
        max_output_chars: NonZeroUsize::new(6_001).unwrap(),
    };
    let completed = |response: Value| Answer::Whole {
        status: 200,
        body: response.to_string(),
    };

    stub.answer(completed(json!({
        "status": "completed",
        "output": [
            {"type": "reasoning", "id": "rs_1", "summary": []},
            message("<think>planning</think>  We spoke of tea.  "),
        ],
    })));

    assert_eq!(
        adapter.complete_text(&request).await,
        TextCompletion::Completed {
            text: "We spoke of tea.".to_owned(),
            provider: ProviderName::Openai,
            model: Some("gpt-6-luna".to_owned()),
        }
    );
    assert_eq!(
        stub.requests()[0].json(),
        json!({
            "model": "gpt-6-luna",
            "input": [
                {"type": "message", "role": "system", "content": "Condense."},
                {"type": "message", "role": "user", "content": "<conversation>...</conversation>"},
            ],
            "store": false,
            "max_output_tokens": 32_768,
        })
    );

    stub.answer(completed(
        json!({"status": "completed", "output": [message("   ")]}),
    ));
    stub.answer(completed(json!({
        "status": "incomplete",
        "incomplete_details": {"reason": "max_output_tokens"},
    })));
    stub.answer(Answer::Whole {
        status: 400,
        body: json!({"error": {"message": format!("No summaries for {KEY}.")}}).to_string(),
    });

    for reason in [
        "OpenAI completion returned no text.",
        "OpenAI response ended incomplete: max_output_tokens.",
        "OpenAI provider error: No summaries for [redacted].",
    ] {
        assert_eq!(
            adapter.complete_text(&request).await,
            TextCompletion::Failed {
                reason: reason.to_owned()
            }
        );
    }
}
