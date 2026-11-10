//! The NVIDIA adapter against a model server on the loopback interface.

use std::num::NonZeroUsize;
use std::sync::Arc;
use std::time::Duration;

use p02_contracts::{
    Invocation, ProviderAnswer, ProviderName, RoleModelAdapter, TextCompletion,
    TextCompletionRequest,
};
use p02_role_model::{NvidiaSettings, select_adapter};
use p02_shared::BaseUrl;
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::stub::{Answer, Stub};
use crate::support::{DONE, call_piece, content, finish, wire};

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

/// A round of the loop with `tools` offered.
async fn invoke(adapter: &Adapter, tools: &[&str]) -> ProviderAnswer {
    let (messages, tools) = wire(tools);

    adapter.invoke(&Invocation::new(&messages, &tools)).await
}

/// What the model wrote, as a record keeps it.
fn output(answer: &ProviderAnswer) -> Value {
    match answer {
        ProviderAnswer::Answered { output, .. } => serde_json::to_value(output).unwrap(),
        ProviderAnswer::Failed(failure) => panic!("the round failed: {failure:?}"),
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

    let recovered = invoke(&adapter, &["visible_reply"]).await;
    let [first, second] = stub.requests().try_into().unwrap();

    assert_eq!(output(&recovered)["text"], json!("After a 503."));
    assert_eq!(first.body, second.body);

    // A client of its own, so the round opens the connection that drops.
    stub.drop_next_connection();
    stub.answer(reply("After a drop."));

    let reconnected = invoke(&self::adapter(&stub), &["visible_reply"]).await;

    assert_eq!(output(&reconnected)["text"], json!("After a drop."));
    assert_eq!(stub.connections_still_to_drop(), 0);

    for attempt in 1..=3 {
        stub.answer(slow_down(attempt));
    }

    let exhausted = invoke(&adapter, &["visible_reply"]).await;

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

    let unauthorized = invoke(&adapter, &["visible_reply"]).await;
    let bad = invoke(&adapter, &["visible_reply"]).await;

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

        let answer = invoke(&adapter, &["visible_reply"]).await;

        assert_eq!(
            failure(&answer),
            (code.to_owned(), message, Some(200)),
            "{frames:?}"
        );
        assert!(!format!("{answer:?}").contains(KEY));
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
}

/// Whether settings give a character a model is answered by building it:
/// no service chosen makes none, NVIDIA's cloud without a key is refused
/// saying what to add, and a server of the person's own needs no key.
#[test]
fn a_model_is_built_from_a_chosen_service_with_a_key_or_a_server_of_ones_own() {
    let built = |settings: Option<&NvidiaSettings>| {
        select_adapter(None, settings, None).map(|adapter| adapter.is_some())
    };
    let own = NvidiaSettings {
        base_url: Some(BaseUrl::parse("http://localhost:1234/v1").unwrap()),
        ..NvidiaSettings::default()
    };

    assert!(matches!(built(None), Ok(false)));
    assert_eq!(
        built(Some(&NvidiaSettings::default()))
            .err()
            .map(|refused| refused.to_string()),
        Some("add your NVIDIA API key".to_owned())
    );
    assert!(matches!(built(Some(&own)), Ok(true)));
}

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

    let answer = invoking.await;

    assert_eq!(started.elapsed(), Duration::from_secs(30));
    assert_eq!(
        failure(&answer).1,
        "NVIDIA provider request timed out after 30000ms."
    );
}
