//! The NVIDIA adapter against a model server on the loopback interface.

use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use p02_contracts::{
    Invocation, ProviderAnswer, ProviderName, RawOutput, ReplyDelta, RoleModelAdapter,
    TextCompletion, TextCompletionRequest,
};
use p02_role_model::{NvidiaSettings, select_adapter};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::stub::{Answer, Stub};
use crate::support::{DONE, call_piece, content, envelope, event_text, finish, usage, wire};

const KEY: &str = "nvapi-fixture-key";

type Adapter = Arc<dyn RoleModelAdapter>;

/// The NVIDIA provider as `settings` choose it, its silence bounded at
/// `shortened` when the harness shortens it.
fn nvidia(settings: &NvidiaSettings, shortened: Option<Duration>) -> Adapter {
    select_adapter(None, Some(settings), shortened)
        .unwrap()
        .unwrap()
}

fn keyed(stub: &Stub) -> NvidiaSettings {
    NvidiaSettings {
        api_key: Some(KEY.to_owned()),
        model: Some("fixture-model".to_owned()),
        base_url: Some(stub.base_url()),
    }
}

fn adapter(stub: &Stub) -> Adapter {
    nvidia(&keyed(stub), None)
}

/// A round of the loop with `tools` offered, and every draft it heard.
async fn invoke(adapter: &Adapter, tools: &[&str]) -> (RawOutput, Vec<ReplyDelta>) {
    let heard = Mutex::new(Vec::new());
    let listener = |delta: ReplyDelta| heard.lock().unwrap().push(delta);
    let (messages, tools) = wire(tools);
    let invocation = Invocation::new(&messages, &tools).with_reply_listener(&listener);
    let output = adapter.invoke(&envelope("Hello?"), &invocation).await;

    (output, heard.into_inner().unwrap())
}

fn decision(output: &RawOutput) -> Value {
    match &output.answer {
        ProviderAnswer::Text(text) => serde_json::from_str(text).unwrap(),
        ProviderAnswer::Failed { details } => panic!("the round failed: {details}"),
    }
}

/// How the round failed: its code, what it says, and the status that
/// answered, if one did.
fn failure(output: &RawOutput) -> (String, String, Option<u16>) {
    let metadata = output.provider_metadata.clone().unwrap();
    let error = metadata.error.unwrap();

    assert_eq!(
        output.answer,
        ProviderAnswer::Failed {
            details: error.message.clone()
        }
    );

    (
        error.code,
        error.message,
        metadata.response.and_then(|response| response.status),
    )
}

fn delta(text: &str) -> ReplyDelta {
    ReplyDelta {
        reply: 0,
        text: text.to_owned(),
    }
}

fn exchange(output: &RawOutput) -> Value {
    output.provider_exchange.clone().unwrap().as_value().clone()
}

#[tokio::test]
async fn a_round_is_a_streamed_completion_at_the_endpoint_under_the_bearer_key() {
    let stub = Stub::start().await;

    stub.answer(Answer::events(&[
        content("Hello "),
        content("from the model."),
        finish("stop"),
        usage(&json!({"prompt_tokens": 12, "completion_tokens": 34})),
        DONE.to_owned(),
    ]));

    let (output, heard) = invoke(&adapter(&stub), &["visible_reply", "runtime.plugin.list"]).await;
    let [request] = stub.requests().try_into().unwrap();
    let body = String::from_utf8(request.body.to_vec()).unwrap();

    assert_eq!(request.path, "/v1/chat/completions");
    assert_eq!(
        request.header("authorization"),
        Some("Bearer nvapi-fixture-key")
    );
    assert_eq!(request.header("content-type"), Some("application/json"));
    assert_eq!(
        body,
        concat!(
            "{\"model\":\"fixture-model\",\"messages\":[{\"role\":\"system\",\"content\":\"You are Mira.\"},",
            "{\"role\":\"user\",\"content\":\"Hello?\"}],\"tools\":[",
            "{\"type\":\"function\",\"function\":{\"name\":\"visible_reply\",\"description\":\"A tool.\",\"parameters\":{\"type\":\"object\"}}},",
            "{\"type\":\"function\",\"function\":{\"name\":\"runtime_plugin_list\",\"description\":\"A tool.\",\"parameters\":{\"type\":\"object\"}}}],",
            "\"tool_choice\":\"auto\",\"parallel_tool_calls\":true,\"stream\":true,\"stream_options\":{\"include_usage\":true},",
            "\"temperature\":1,\"top_p\":1,\"max_tokens\":16384,\"reasoning_budget\":16384,",
            "\"chat_template_kwargs\":{\"enable_thinking\":true}}"
        )
    );
    // Plain content is never drafted: it becomes the reply whole, at the commit.
    assert_eq!(heard, []);
    assert_eq!(
        decision(&output),
        json!({"toolCalls": [{"name": "visible_reply", "input": {"text": "Hello from the model."}}]})
    );
    assert_eq!(
        serde_json::to_value(output.provider_metadata.as_ref().unwrap()).unwrap(),
        json!({
            "provider": "nvidia",
            "model": "fixture-model",
            "request": {"endpoint": format!("{}/chat/completions", stub.base_url()), "messageCount": 2},
            "response": {"status": 200},
        })
    );

    let exchange = exchange(&output);

    assert_eq!(
        serde_json::to_string(&exchange["requestBody"]).unwrap(),
        body
    );
    assert_eq!(exchange["finishReason"], json!("stop"));
    assert_eq!(
        exchange["usage"],
        json!({"prompt_tokens": 12, "completion_tokens": 34})
    );
    assert_eq!(
        exchange["toolNameMappings"],
        json!([
            {"runtimeName": "visible_reply", "providerName": "visible_reply"},
            {"runtimeName": "runtime.plugin.list", "providerName": "runtime_plugin_list"},
        ])
    );
    assert_eq!(
        exchange["nativeAssistantMessage"],
        json!({"role": "assistant", "content": "Hello from the model."})
    );
}

#[tokio::test]
async fn a_server_of_one_s_own_needs_no_key_and_nvidia_s_cloud_is_not_asked_without_one() {
    let stub = Stub::start().await;
    let open = nvidia(
        &NvidiaSettings {
            base_url: Some(stub.base_url()),
            ..NvidiaSettings::default()
        },
        None,
    );

    stub.answer(Answer::events(&[
        content("Hi."),
        finish("stop"),
        DONE.to_owned(),
    ]));
    invoke(&open, &["visible_reply"]).await;

    let [request] = stub.requests().try_into().unwrap();

    assert_eq!(request.header("authorization"), None);
    assert_eq!(
        request.json()["model"],
        json!("nvidia/nemotron-3-nano-30b-a3b")
    );

    let (output, _) = invoke(&nvidia(&NvidiaSettings::default(), None), &[]).await;
    let metadata = serde_json::to_value(output.provider_metadata.as_ref().unwrap()).unwrap();

    assert_eq!(
        failure(&output),
        (
            "missing_api_key".to_owned(),
            "NVIDIA provider requires the nvidiaApiKey setting.".to_owned(),
            None
        )
    );
    assert_eq!(
        metadata["request"],
        json!({"endpoint": "https://integrate.api.nvidia.com/v1/chat/completions"})
    );
}

#[tokio::test]
async fn a_visible_reply_is_drafted_as_its_arguments_arrive_and_never_the_words_beside_it() {
    let stub = Stub::start().await;
    let adapter = adapter(&stub);
    let writer = stub.stream(Duration::ZERO);
    let (drafted, mut drafts) = mpsc::unbounded_channel();
    let listener = move |delta: ReplyDelta| drafted.send(delta).unwrap();
    let (messages, tools) = wire(&["visible_reply"]);
    let invocation = Invocation::new(&messages, &tools).with_reply_listener(&listener);
    let envelope = envelope("Hello?");
    let write = |data: &str| writer.send(event_text(data)).unwrap();
    let (output, heard) = tokio::join!(adapter.invoke(&envelope, &invocation), async {
        let mut heard = Vec::new();

        write(&content("A note to myself. "));
        write(&call_piece(
            0,
            Some(("call_reply", "visible_reply")),
            "{\"te",
        ));
        write(&call_piece(0, None, "xt\": \"Hi"));
        // Drafted while the rest of the call is still to come.
        heard.push(drafts.recv().await.unwrap());
        write(&call_piece(0, None, " there\\u0021 <thi"));
        heard.push(drafts.recv().await.unwrap());
        write(&call_piece(0, None, "nk>secret</think> <thin\"}"));
        heard.push(drafts.recv().await.unwrap());
        write(&content("More of the note."));
        write(&finish("tool_calls"));
        write(DONE);
        // `<thin` could have opened a tag until the message was whole.
        heard.push(drafts.recv().await.unwrap());
        heard
    });

    assert_eq!(
        heard,
        [delta("Hi"), delta(" there! "), delta(" "), delta("<thin")]
    );
    assert_eq!(
        decision(&output),
        json!({
            "toolCalls": [{
                "name": "visible_reply",
                "input": {"text": "Hi there! <think>secret</think> <thin"},
            }],
            "text": "A note to myself. More of the note.",
        })
    );
}

#[tokio::test]
async fn calls_come_back_under_the_runtime_s_names_with_their_ids_and_arguments_kept() {
    let stub = Stub::start().await;

    stub.answer(Answer::events(&[
        content("Checking."),
        call_piece(0, Some(("call_list", "runtime_plugin_list")), "{}"),
        call_piece(
            1,
            Some(("call_patch", "character_state_patch")),
            "{\"mood\": \"curious\"}",
        ),
        call_piece(
            2,
            Some(("call_bad", "visible_reply")),
            "{\"text\": not-json",
        ),
        call_piece(3, Some(("call_unknown", "memory_list")), "{}"),
        finish("tool_calls"),
        DONE.to_owned(),
    ]));

    let (output, _) = invoke(
        &adapter(&stub),
        &[
            "visible_reply",
            "runtime.plugin.list",
            "character_state.patch",
        ],
    )
    .await;

    assert_eq!(
        decision(&output),
        json!({
            "toolCalls": [
                {"name": "runtime.plugin.list", "input": {}},
                {"name": "character_state.patch", "input": {"mood": "curious"}},
                {"name": "visible_reply", "input": "{\"text\": not-json"},
                {"name": "memory_list", "input": {}},
            ],
            "text": "Checking.",
        })
    );
    assert_eq!(
        exchange(&output)["nativeAssistantMessage"]["tool_calls"][1],
        json!({
            "id": "call_patch",
            "type": "function",
            "function": {"name": "character_state_patch", "arguments": "{\"mood\": \"curious\"}"},
        })
    );
}

/// Reasoning never closed hides the rest of the text, so it says nothing,
/// as empty content does: the parser refuses it and the model is told.
#[tokio::test]
async fn an_answer_that_says_nothing_reaches_the_parser_as_no_call() {
    let stub = Stub::start().await;
    let adapter = adapter(&stub);

    stub.answer(Answer::events(&[
        content("<think>never closed"),
        finish("stop"),
        DONE.to_owned(),
    ]));
    stub.answer(Answer::events(&[
        content(""),
        finish("stop"),
        DONE.to_owned(),
    ]));

    let (unterminated, _) = invoke(&adapter, &["visible_reply"]).await;
    let (empty, _) = invoke(&adapter, &["visible_reply"]).await;

    assert_eq!(decision(&unterminated), json!({"toolCalls": []}));
    assert_eq!(decision(&empty), json!({"toolCalls": []}));
}

#[tokio::test]
async fn the_provider_s_silence_is_bounded_before_the_headers_and_between_chunks() {
    let silence = Duration::from_secs(1);
    let gap = Duration::from_millis(300);
    let stub = Stub::start().await;
    let adapter = nvidia(&keyed(&stub), Some(silence));
    let timed_out = (
        "request_timeout".to_owned(),
        "NVIDIA provider request timed out after 1000ms.".to_owned(),
        None,
    );

    let release = stub.hold();
    let (held, _) = invoke(&adapter, &["visible_reply"]).await;

    assert_eq!(failure(&held), timed_out);
    // A timeout is never tried again.
    assert_eq!(stub.requests().len(), 1);
    drop(release);

    let writer = stub.stream(Duration::ZERO);

    writer.send(event_text(&content("Let me"))).unwrap();

    let (stalled, _) = invoke(&adapter, &["visible_reply"]).await;

    assert_eq!(failure(&stalled), timed_out);
    drop(writer);

    // Headers late and each chunk late, every wait inside the bound and
    // all of them together far past it.
    let writer = stub.stream(gap);
    let (steady, ()) = tokio::join!(invoke(&adapter, &["visible_reply"]), async {
        for piece in [
            content("Slow "),
            content("and "),
            content("steady."),
            finish("stop"),
            DONE.to_owned(),
        ] {
            tokio::time::sleep(gap).await;
            writer.send(event_text(&piece)).unwrap();
        }
    });

    assert_eq!(
        decision(&steady.0),
        json!({"toolCalls": [{"name": "visible_reply", "input": {"text": "Slow and steady."}}]})
    );
}

#[tokio::test]
async fn a_transport_fault_or_a_busy_provider_is_tried_again_and_a_refusal_is_not() {
    let stub = Stub::start().await;
    let adapter = adapter(&stub);
    let reply = |text: &str| Answer::events(&[content(text), finish("stop"), DONE.to_owned()]);
    let slow_down = |attempt: u32| Answer::Whole {
        status: 429,
        body: json!({"error": {"message": format!("Slow down ({attempt}).")}}).to_string(),
    };

    stub.answer(Answer::Whole {
        status: 503,
        body: "upstream unavailable".to_owned(),
    });
    stub.answer(reply("After a 503."));

    let (recovered, _) = invoke(&adapter, &["visible_reply"]).await;
    let [first, second] = stub.requests().try_into().unwrap();

    assert_eq!(
        decision(&recovered)["toolCalls"][0]["input"]["text"],
        json!("After a 503.")
    );
    assert_eq!(first.body, second.body);

    // A client of its own, so the round opens the connection that drops.
    stub.drop_next_connection();
    stub.answer(reply("After a drop."));

    let (reconnected, _) = invoke(&self::adapter(&stub), &["visible_reply"]).await;

    assert_eq!(
        decision(&reconnected)["toolCalls"][0]["input"]["text"],
        json!("After a drop.")
    );
    assert_eq!(stub.connections_still_to_drop(), 0);

    for attempt in 1..=3 {
        stub.answer(slow_down(attempt));
    }

    let (exhausted, _) = invoke(&adapter, &["visible_reply"]).await;

    assert_eq!(
        failure(&exhausted),
        (
            "http_error".to_owned(),
            "NVIDIA provider error: Slow down (3).".to_owned(),
            Some(429)
        )
    );

    stub.answer(Answer::Whole {
        status: 401,
        body: json!({"message": format!("Who are you, {KEY}?")}).to_string(),
    });
    stub.answer(Answer::Whole {
        status: 400,
        body: "not json".to_owned(),
    });

    let (unauthorized, _) = invoke(&adapter, &["visible_reply"]).await;
    let (bad, _) = invoke(&adapter, &["visible_reply"]).await;

    assert_eq!(
        failure(&unauthorized),
        (
            "http_error".to_owned(),
            "NVIDIA provider error: Who are you, [redacted]?".to_owned(),
            Some(401)
        )
    );
    assert_eq!(failure(&bad).1, "NVIDIA provider HTTP 400: not json");
    // Two then one, then three for the 429s, then one each.
    assert_eq!(stub.requests().len(), 2 + 1 + 3 + 1 + 1);
}

#[tokio::test]
async fn an_answer_that_is_no_whole_completion_fails_the_round_without_the_key() {
    let stub = Stub::start().await;
    let adapter = adapter(&stub);
    let drafted = call_piece(
        0,
        Some(("call_reply", "visible_reply")),
        "{\"text\": \"Half a th",
    );
    let cases = [
        (
            vec![drafted.clone(), "[]".to_owned()],
            "malformed_response",
            "NVIDIA stream chunk must be an object.".to_owned(),
        ),
        (
            vec![json!({"error": {"message": format!("The key {KEY} was refused.")}}).to_string()],
            "provider_error",
            "NVIDIA provider error: The key [redacted] was refused.".to_owned(),
        ),
        (
            vec![drafted.clone(), finish("length"), DONE.to_owned()],
            "provider_error",
            "NVIDIA response finish_reason \"length\" is not terminal.".to_owned(),
        ),
        (
            vec![drafted.clone(), DONE.to_owned()],
            "malformed_response",
            "NVIDIA response choice.finish_reason is required.".to_owned(),
        ),
        (
            vec![drafted],
            "malformed_response",
            "NVIDIA response choice.finish_reason is required.".to_owned(),
        ),
    ];

    for (frames, code, message) in cases {
        stub.answer(Answer::events(&frames));

        let (output, _) = invoke(&adapter, &["visible_reply"]).await;

        assert_eq!(
            failure(&output),
            (code.to_owned(), message, Some(200)),
            "{frames:?}"
        );
        assert!(!format!("{output:?}").contains(KEY));
    }
}

#[tokio::test]
async fn a_plain_completion_asks_the_same_model_without_tools_or_thinking() {
    let stub = Stub::start().await;
    let adapter = adapter(&stub);
    let request = TextCompletionRequest {
        instructions: "Condense.".to_owned(),
        input: "<conversation>...</conversation>".to_owned(),
        max_output_chars: NonZeroUsize::new(6_001).unwrap(),
    };
    let completion = |content: &str, finish_reason: &str| Answer::Whole {
        status: 200,
        body: json!({
            "choices": [{
                "finish_reason": finish_reason,
                "message": {"role": "assistant", "content": content},
            }],
        })
        .to_string(),
    };

    stub.answer(completion(
        "<think>planning</think>  We spoke of tea.  ",
        "stop",
    ));

    assert_eq!(
        adapter.complete_text(&request).await,
        TextCompletion::Completed {
            text: "We spoke of tea.".to_owned(),
            provider: ProviderName::Nvidia,
            model: Some("fixture-model".to_owned()),
        }
    );
    assert_eq!(
        stub.requests()[0].json(),
        json!({
            "model": "fixture-model",
            "messages": [
                {"role": "system", "content": "Condense."},
                {"role": "user", "content": "<conversation>...</conversation>"},
            ],
            "stream": false,
            "temperature": 0.3,
            "top_p": 1,
            "max_tokens": 3_001,
            "chat_template_kwargs": {"enable_thinking": false},
        })
    );

    stub.answer(completion("   ", "stop"));
    stub.answer(completion("We spoke of", "length"));
    stub.answer(Answer::Whole {
        status: 400,
        body: json!({"error": {"message": format!("No summaries for {KEY}.")}}).to_string(),
    });

    for reason in [
        "NVIDIA completion returned no text.",
        "NVIDIA completion ended with finish_reason \"length\" instead of finishing.",
        "NVIDIA provider error: No summaries for [redacted].",
    ] {
        assert_eq!(
            adapter.complete_text(&request).await,
            TextCompletion::Failed {
                reason: reason.to_owned()
            }
        );
    }

    assert_eq!(
        nvidia(&NvidiaSettings::default(), None)
            .complete_text(&request)
            .await,
        TextCompletion::Failed {
            reason: "NVIDIA provider has no API key.".to_owned()
        }
    );
}

/// model.provider-timeout-default: the provider silence bound is 30 seconds unless shortened
#[tokio::test(start_paused = true)]
async fn the_provider_s_silence_is_bounded_at_thirty_seconds_unless_shortened() {
    let stub = Stub::start().await;
    let adapter = adapter(&stub);
    let _release = stub.hold();
    let started = Instant::now();
    let invoking = invoke(&adapter, &["visible_reply"]);

    tokio::pin!(invoking);

    tokio::select! {
        biased;
        _ = &mut invoking => panic!("the round ended before the bound"),
        () = tokio::time::sleep(Duration::from_millis(29_999)) => {}
    }

    let (output, _) = invoking.await;

    assert_eq!(started.elapsed(), Duration::from_secs(30));
    assert_eq!(
        failure(&output).1,
        "NVIDIA provider request timed out after 30000ms."
    );
}
