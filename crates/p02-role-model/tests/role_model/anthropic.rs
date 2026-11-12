//! The Anthropic adapter, as the Claude API's, against a model server on
//! the loopback interface.

use std::iter::once;
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

use p02_contracts::{
    ChatFunctionCall, ChatMessage, ChatToolCall, Invocation, ProviderAnswer, ProviderName,
    ReplyDraft, RoleModelAdapter, TextCompletion, TextCompletionRequest, ToolCallId,
};
use p02_role_model::{AnthropicSettings, ServiceSettings, select_adapter};
use serde_json::{Value, json};

use crate::stub::{Answer, Stub};
use crate::support::{piece, wire};

const KEY: &str = "sk-ant-fixture-key";

type Adapter = Arc<dyn RoleModelAdapter>;

/// The Claude API at the stub, as a test harness names it, asked for a
/// model the setting offers, which takes Anthropic's own fallback.
fn adapter(stub: &Stub) -> Adapter {
    select_adapter(
        None,
        Some(&ServiceSettings::Anthropic(AnthropicSettings {
            api_key: Some(KEY.to_owned()),
            model: "claude-opus-5-5".to_owned(),
            fallback: true,
            base_url: Some(stub.at("anthropic/v1")),
        })),
        None,
    )
    .unwrap()
    .unwrap()
}

/// A message streamed: its start, these events, as the service streams
/// them, and whatever ends it among them.
fn message(events: &[Vec<String>]) -> Answer {
    let start = json!({
        "type": "message_start",
        "message": {
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "content": [],
            "model": "claude-opus-5-5",
            "stop_reason": null,
            "usage": {"input_tokens": 12, "output_tokens": 1},
        },
    });

    Answer::events(&[vec![start.to_string()], events.concat()].concat())
}

/// The events of the block at `index` that starts as `block`, then streams
/// `deltas`.
fn block(index: u64, block: &Value, deltas: Vec<Value>) -> Vec<String> {
    once(json!({"type": "content_block_start", "index": index, "content_block": block}))
        .chain(
            deltas.into_iter().map(
                |delta| json!({"type": "content_block_delta", "index": index, "delta": delta}),
            ),
        )
        .chain(once(json!({"type": "content_block_stop", "index": index})))
        .map(|event| event.to_string())
        .collect()
}

/// A call of the tool the model knows as `name`, its arguments in `pieces`.
fn tool_use(index: u64, name: &str, pieces: &[&str]) -> Vec<String> {
    block(
        index,
        &json!({"type": "tool_use", "id": format!("toolu_{index}"), "name": name, "input": {}}),
        pieces
            .iter()
            .map(|piece| json!({"type": "input_json_delta", "partial_json": piece}))
            .collect(),
    )
}

fn text(index: u64, text: &str) -> Vec<String> {
    block(
        index,
        &json!({"type": "text", "text": ""}),
        vec![json!({"type": "text_delta", "text": text})],
    )
}

/// The model thinking before it answers, and the signature of its thought.
fn thinking(index: u64) -> Vec<String> {
    block(
        index,
        &json!({"type": "thinking", "thinking": ""}),
        vec![
            json!({"type": "thinking_delta", "thinking": "She asks how I am."}),
            json!({"type": "signature_delta", "signature": "c2lnbmVk"}),
        ],
    )
}

/// The events that stop a message for `reason`, its output tokens counted,
/// with `details` beside the reason when it has them.
fn stopped_with(reason: &str, details: Option<Value>) -> Vec<String> {
    let mut delta = json!({"stop_reason": reason, "stop_sequence": null});

    if let Some(details) = details {
        delta["stop_details"] = details;
    }

    vec![
        json!({"type": "message_delta", "delta": delta, "usage": {"output_tokens": 34}})
            .to_string(),
        json!({"type": "message_stop"}).to_string(),
    ]
}

fn stopped(reason: &str) -> Vec<String> {
    stopped_with(reason, None)
}

/// A message the model declined to write, for `category` when the service
/// names one.
fn declined(category: Option<&str>) -> Answer {
    message(&[stopped_with(
        "refusal",
        Some(json!({"type": "refusal", "category": category, "explanation": "Not this."})),
    )])
}

/// The service refusing a request under `status`, as its error body says.
fn refused(status: u16, kind: &str, message: &str) -> Answer {
    Answer::Whole {
        status,
        body: json!({
            "type": "error",
            "error": {"type": kind, "message": message},
            "request_id": "req_1",
        })
        .to_string(),
    }
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
/// them: two searches at once beside a note, then one more, each call
/// under the runtime's own id, and then each round's results.
fn searches() -> Vec<ChatMessage> {
    let id = |round: u32, call: u32| {
        ToolCallId::new(&format!(
            "evt_turn.trace_turn.round-{round}.{call}.memory.search"
        ))
        .unwrap()
    };
    let search = |round: u32, call: u32, query: &str| {
        ChatToolCall::new(
            id(round, call),
            ChatFunctionCall {
                name: "memory.search".to_owned(),
                arguments: format!("{{\"q\":\"{query}\"}}"),
            },
        )
    };
    let result = |round: u32, call: u32, found: u32| ChatMessage::Tool {
        content: format!("{{\"found\":{found}}}"),
        tool_call_id: id(round, call),
    };

    vec![
        ChatMessage::Assistant {
            content: Some("Looking.".to_owned()),
            tool_calls: vec![search(1, 1, "tea"), search(1, 2, "sky")],
        },
        result(1, 1, 1),
        result(1, 2, 2),
        ChatMessage::Assistant {
            content: None,
            tool_calls: vec![search(2, 1, "rain")],
        },
        result(2, 1, 3),
    ]
}

/// A search as a request shows it, under the id the request gives it.
fn shown_search(call: u32, query: &str) -> Value {
    json!({
        "type": "tool_use",
        "id": format!("call_{call}"),
        "name": "memory_search",
        "input": {"q": query},
    })
}

/// A search's result as a request shows it, tied to its call by that id.
fn shown_result(call: u32, found: u32) -> Value {
    json!({
        "type": "tool_result",
        "tool_use_id": format!("call_{call}"),
        "content": format!("{{\"found\":{found}}}"),
    })
}

/// A tool of the test's world as the protocol offers it.
fn offered(name: &str) -> Value {
    json!({
        "name": name,
        "description": "A tool.",
        "input_schema": {"type": "object"},
        "eager_input_streaming": true,
    })
}

#[tokio::test]
async fn a_round_goes_out_in_the_protocol_s_terms_and_its_answer_is_read_back_as_written() {
    let stub = Stub::start().await;
    let (mut messages, tools) = wire(&["visible_reply", "memory.search"]);

    messages.insert(
        1,
        ChatMessage::Developer {
            content: "Be brief.".to_owned(),
        },
    );
    messages.extend(searches());
    messages.push(ChatMessage::System {
        content: "Your last reply could not be used.".to_owned(),
    });
    stub.answer(message(&[
        thinking(0),
        text(1, "A note."),
        tool_use(2, "visible_reply", &["{\"text\":\"Hel", "lo.\"}"]),
        tool_use(3, "memory_search", &["{\"q\":", "\"sky\"}"]),
        stopped("tool_use"),
    ]));

    let heard = Mutex::new(Vec::new());
    let listener = |draft: ReplyDraft| heard.lock().unwrap().push(draft);
    let answer = adapter(&stub)
        .invoke(&Invocation::new(&messages, &tools).with_reply_listener(&listener))
        .await;
    let [request] = stub.requests().try_into().unwrap();

    assert_eq!(
        [
            Some(request.path.as_str()),
            request.header("x-api-key"),
            request.header("anthropic-version"),
            request.header("anthropic-beta"),
            request.header("content-type"),
            request.authorization.as_deref(),
        ],
        [
            Some("/anthropic/v1/messages"),
            Some(KEY),
            Some("2026-10-21"),
            Some("server-side-fallback-2026-07-01"),
            Some("application/json"),
            None,
        ]
    );
    assert_eq!(
        request.json(),
        json!({
            "model": "claude-opus-5-5",
            "max_tokens": 32_768,
            "system": "You are Mira.\n\nBe brief.",
            "messages": [
                {"role": "user", "content": "Hello?"},
                {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "Looking."},
                        shown_search(1, "tea"),
                        shown_search(2, "sky"),
                    ],
                },
                {"role": "user", "content": [shown_result(1, 1), shown_result(2, 2)]},
                {"role": "assistant", "content": [shown_search(3, "rain")]},
                {"role": "user", "content": [shown_result(3, 3)]},
                {"role": "system", "content": "Your last reply could not be used."},
            ],
            "tools": [offered("visible_reply"), offered("memory_search")],
            "stream": true,
            "fallbacks": "default",
        })
    );
    assert_eq!(*heard.lock().unwrap(), [piece("Hel"), piece("lo.")]);

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
            Some("tool_use".to_owned()),
            Some((12, 34))
        )
    );
}

/// A decline in the middle of her reply, taken over by Anthropic's
/// fallback: the reply the declining model left half written is let go, in
/// the answer and as a draft, its note stays, and the fallback's reply is
/// drafted as the round's first, which the answer holds it as.
#[tokio::test]
async fn a_fallback_taking_over_lets_go_the_reply_before_it_and_drafts_its_own_in_its_place() {
    let stub = Stub::start().await;
    let (messages, tools) = wire(&["visible_reply"]);

    stub.answer(message(&[
        text(0, "A note."),
        tool_use(1, "visible_reply", &["{\"text\":\"Half a"]),
        block(
            2,
            &json!({
                "type": "fallback",
                "from": {"model": "claude-opus-5-5"},
                "to": {"model": "claude-opus-4-8"},
            }),
            Vec::new(),
        ),
        tool_use(3, "visible_reply", &["{\"text\":\"Who", "le.\"}"]),
        stopped("tool_use"),
    ]));

    let heard = Mutex::new(Vec::new());
    let listener = |draft: ReplyDraft| heard.lock().unwrap().push(draft);
    let answer = adapter(&stub)
        .invoke(&Invocation::new(&messages, &tools).with_reply_listener(&listener))
        .await;

    assert_eq!(
        *heard.lock().unwrap(),
        [
            piece("Half a"),
            ReplyDraft::LetGo,
            piece("Who"),
            piece("le."),
        ]
    );

    let ProviderAnswer::Answered { output, .. } = answer else {
        panic!("the round failed: {answer:?}");
    };

    assert_eq!(
        serde_json::to_value(output).unwrap(),
        json!({
            "toolCalls": [{"name": "visible_reply", "input": {"text": "Whole."}}],
            "text": "A note.",
        })
    );
}

#[tokio::test]
async fn every_end_of_a_round_short_of_an_answer_is_said_as_claude_s_without_the_key() {
    let stub = Stub::start().await;
    let adapter = adapter(&stub);
    let reply = tool_use(0, "visible_reply", &["{\"text\":\"Half a th"]);

    stub.answer(refused(529, "overloaded_error", "Overloaded."));
    stub.answer(message(&[
        tool_use(0, "visible_reply", &["{\"text\":\"After a 529.\"}"]),
        stopped("end_turn"),
    ]));

    assert_eq!(
        serde_json::to_value(match invoke(&adapter).await {
            ProviderAnswer::Answered { output, .. } => output,
            failed @ ProviderAnswer::Failed(_) => panic!("{failed:?}"),
        })
        .unwrap()["toolCalls"][0]["input"],
        json!({"text": "After a 529."})
    );
    assert_eq!(stub.requests().len(), 2);

    let cases = [
        (
            refused(
                401,
                "authentication_error",
                &format!("invalid x-api-key {KEY}"),
            ),
            "http_error",
            "Claude provider error: invalid x-api-key [redacted]",
            Some(401),
        ),
        (
            message(&[
                reply.clone(),
                vec![
                    json!({
                        "type": "error",
                        "error": {"type": "api_error", "message": format!("The key {KEY} broke.")},
                    })
                    .to_string(),
                ],
            ]),
            "provider_error",
            "Claude provider error: The key [redacted] broke.",
            Some(200),
        ),
        (
            declined(Some("cyber")),
            "provider_error",
            "Claude declined to answer (cyber).",
            Some(200),
        ),
        (
            declined(None),
            "provider_error",
            "Claude declined to answer.",
            Some(200),
        ),
        (
            message(&[reply.clone(), stopped("max_tokens")]),
            "provider_error",
            "Claude response was cut short: max_tokens.",
            Some(200),
        ),
        (
            message(&[
                reply.clone(),
                vec![json!({"type": "message_stop"}).to_string()],
            ]),
            "malformed_response",
            "Claude response stop_reason is required.",
            Some(200),
        ),
        (
            message(&[reply]),
            "malformed_response",
            "Claude response ended before it finished.",
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

    // Two for the 529, then one each: a refusal is not tried again.
    assert_eq!(stub.requests().len(), 2 + 7);
}

#[tokio::test]
async fn a_plain_completion_streams_from_the_same_model_and_reads_its_text() {
    let stub = Stub::start().await;
    let adapter = adapter(&stub);
    let request = TextCompletionRequest {
        instructions: "Condense.".to_owned(),
        input: "<conversation>...</conversation>".to_owned(),
        max_output_chars: NonZeroUsize::new(6_001).unwrap(),
    };

    stub.answer(message(&[
        thinking(0),
        text(1, "<think>planning</think>  We spoke of tea.  "),
        stopped("end_turn"),
    ]));

    assert_eq!(
        adapter.complete_text(&request).await,
        TextCompletion::Completed {
            text: "We spoke of tea.".to_owned(),
            provider: ProviderName::Anthropic,
            model: Some("claude-opus-5-5".to_owned()),
        }
    );
    assert_eq!(
        stub.requests()[0].json(),
        json!({
            "model": "claude-opus-5-5",
            "max_tokens": 32_768,
            "system": "Condense.",
            "messages": [{"role": "user", "content": "<conversation>...</conversation>"}],
            "stream": true,
            "fallbacks": "default",
        })
    );

    stub.answer(message(&[text(0, "   "), stopped("end_turn")]));
    stub.answer(message(&[text(0, "We spoke of"), stopped("max_tokens")]));
    stub.answer(refused(
        400,
        "invalid_request_error",
        &format!("No summaries for {KEY}."),
    ));

    for reason in [
        "Claude completion returned no text.",
        "Claude response was cut short: max_tokens.",
        "Claude provider error: No summaries for [redacted].",
    ] {
        assert_eq!(
            adapter.complete_text(&request).await,
            TextCompletion::Failed {
                reason: reason.to_owned()
            }
        );
    }
}
