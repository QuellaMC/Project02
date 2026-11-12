//! The Responses adapter, as the OpenAI API's and as a ChatGPT plan's,
//! against a model server on the loopback interface.

use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use p02_contracts::{
    ChatFunctionCall, ChatMessage, ChatToolCall, Invocation, ProviderAnswer, ProviderName,
    ReplyDraft, RoleModelAdapter, TextCompletion, TextCompletionRequest, ToolCallId,
};
use p02_role_model::{
    ChatgptSettings, OpenaiSettings, PlanAccess, PlanSignIn, ServiceSettings, select_adapter,
};
use serde_json::{Value, json};

use crate::stub::{Answer, Stub};
use crate::support::{piece, wire};

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
    let listener = |draft: ReplyDraft| heard.lock().unwrap().push(draft);
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

/// The home's sign-in as a plan's service reaches it: each use hands out
/// `access-<n>` on Sam's account, `n` counting the refreshes so far, each of
/// which keeps the access token it was told was refused; or, signed out,
/// the sentence saying so.
#[derive(Debug, Default)]
struct SignIn {
    signed_out: bool,
    refused: Mutex<Vec<String>>,
}

impl SignIn {
    fn access(&self) -> Result<PlanAccess, String> {
        if self.signed_out {
            return Err("Sign in to your ChatGPT plan first.".to_owned());
        }

        Ok(PlanAccess {
            access_token: format!("access-{}", self.refused.lock().unwrap().len() + 1),
            account_id: "acct-sam".to_owned(),
        })
    }
}

#[async_trait]
impl PlanSignIn for SignIn {
    async fn fresh(&self) -> Result<PlanAccess, String> {
        self.access()
    }

    async fn refreshed(&self, refused: &PlanAccess) -> Result<PlanAccess, String> {
        self.refused
            .lock()
            .unwrap()
            .push(refused.access_token.clone());
        self.access()
    }
}

/// A ChatGPT plan at the stub, as a test harness names it, on `sign_in`.
fn plan(stub: &Stub, sign_in: &Arc<SignIn>) -> Adapter {
    select_adapter(
        None,
        Some(&ServiceSettings::Chatgpt(ChatgptSettings {
            sign_in: Some(Arc::clone(sign_in) as Arc<dyn PlanSignIn>),
            model: "gpt-6.1-sol".to_owned(),
            base_url: Some(stub.at("chatgpt")),
        })),
        None,
    )
    .unwrap()
    .unwrap()
}

/// The event that gives the item at `index` whole.
fn done(index: u64, item: &Value) -> String {
    json!({"type": "response.output_item.done", "output_index": index, "item": item}).to_string()
}

/// A message's text as a plan takes it: one part of `kind`.
fn part(kind: &str, text: &str) -> Value {
    json!([{"type": kind, "text": text}])
}

#[tokio::test]
async fn a_round_on_a_plan_goes_out_as_codex_sends_it_and_its_answer_is_read_from_its_items() {
    let stub = Stub::start().await;
    let (mut messages, tools) = wire(&["visible_reply", "memory.search"]);

    messages.insert(
        1,
        ChatMessage::Developer {
            content: "Be brief.".to_owned(),
        },
    );
    messages.extend(two_searches());

    let (reply, replied) = call(0, "visible_reply", &["{\"text\":\"Hel", "lo.\"}"]);
    let (search, searched) = call(1, "memory_search", &["{\"q\":", "\"sky\"}"]);

    // Each item whole only as it is done: the end, as the plan's service
    // ends an answer, carries none.
    stub.answer(Answer::events(
        &[
            reply,
            vec![done(0, &replied)],
            search,
            vec![
                done(1, &searched),
                done(2, &message("A note.")),
                json!({"type": "response.completed", "response": {}}).to_string(),
            ],
        ]
        .concat(),
    ));

    let heard = Mutex::new(Vec::new());
    let listener = |draft: ReplyDraft| heard.lock().unwrap().push(draft);
    let answer = plan(&stub, &Arc::new(SignIn::default()))
        .invoke(&Invocation::new(&messages, &tools).with_reply_listener(&listener))
        .await;
    let [request] = stub.requests().try_into().unwrap();
    let body = request.json();
    let session = body["prompt_cache_key"].as_str().unwrap();
    let [first, first_result] = shown_search(1);
    let [second, second_result] = shown_search(2);

    assert_eq!(
        [
            Some(request.path.as_str()),
            request.authorization.as_deref(),
            request.header("chatgpt-account-id"),
            request.header("originator"),
            request.header("accept"),
            request.header("session-id"),
        ],
        [
            Some("/chatgpt/responses"),
            Some("Bearer access-1"),
            Some("acct-sam"),
            Some("codex-tui"),
            Some("text/event-stream"),
            Some(session),
        ]
    );
    assert!(uuid::Uuid::parse_str(session).is_ok(), "{session}");
    assert_eq!(
        body,
        json!({
            "model": "gpt-6.1-sol",
            "instructions": "",
            "input": [
                {"type": "message", "role": "developer", "content": part("input_text", "You are Mira.")},
                {"type": "message", "role": "developer", "content": part("input_text", "Be brief.")},
                {"type": "message", "role": "user", "content": part("input_text", "Hello?")},
                {"type": "message", "role": "assistant", "content": part("output_text", "Looking.")},
                first,
                first_result,
                second,
                second_result,
            ],
            "tools": [offered("visible_reply"), offered("memory_search")],
            "tool_choice": "auto",
            "stream": true,
            "store": false,
            "reasoning": {"effort": "low"},
            "include": ["reasoning.encrypted_content"],
            "prompt_cache_key": session,
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
        (serde_json::to_value(output).unwrap(), finish_reason, usage),
        (
            json!({
                "toolCalls": [
                    {"name": "visible_reply", "input": {"text": "Hello."}},
                    {"name": "memory.search", "input": {"q": "sky"}},
                ],
                "text": "A note.",
            }),
            Some("completed".to_owned()),
            None
        )
    );
}

#[tokio::test]
async fn a_401_on_a_plan_is_asked_once_more_refreshed_and_a_second_turns_the_sign_in_down() {
    let stub = Stub::start().await;
    let sign_in = Arc::new(SignIn::default());
    let adapter = plan(&stub, &sign_in);
    let unauthorized = || Answer::Whole {
        status: 401,
        body: json!({"detail": "Unauthorized"}).to_string(),
    };
    let (reply, replied) = call(0, "visible_reply", &["{\"text\":\"Again.\"}"]);

    stub.answer(unauthorized());
    stub.answer(Answer::events(
        &[
            reply,
            vec![ended(
                "completed",
                &json!({"status": "completed", "output": [replied]}),
            )],
        ]
        .concat(),
    ));
    assert!(matches!(
        invoke(&adapter).await,
        ProviderAnswer::Answered { .. }
    ));

    stub.answer(unauthorized());
    stub.answer(unauthorized());
    assert_eq!(
        failure(&invoke(&adapter).await),
        (
            "http_error".to_owned(),
            "ChatGPT turned down your sign-in. Sign in to your ChatGPT plan again.".to_owned(),
            Some(401)
        )
    );
    assert_eq!(
        stub.requests()
            .iter()
            .map(|request| request.authorization.clone().unwrap())
            .collect::<Vec<_>>(),
        [
            "Bearer access-1",
            "Bearer access-2",
            "Bearer access-2",
            "Bearer access-3"
        ]
    );
    assert_eq!(*sign_in.refused.lock().unwrap(), ["access-1", "access-2"]);

    let signed_out = plan(
        &stub,
        &Arc::new(SignIn {
            signed_out: true,
            ..SignIn::default()
        }),
    );

    assert_eq!(
        failure(&invoke(&signed_out).await),
        (
            "provider_error".to_owned(),
            "ChatGPT could not be asked: Sign in to your ChatGPT plan first.".to_owned(),
            None
        )
    );
    assert_eq!(stub.requests().len(), 4);
}

#[tokio::test]
async fn a_plan_s_limit_and_its_busy_service_are_said_in_its_words_and_no_failure_names_its_tokens()
{
    let stub = Stub::start().await;
    let adapter = plan(&stub, &Arc::new(SignIn::default()));
    let limit =
        json!({"type": "usage_limit_reached", "message": "The usage limit has been reached"});
    let limited = "ChatGPT says your plan's limit is reached; it resets later.";
    let refused = |status: u16, body: Value| Answer::Whole {
        status,
        body: body.to_string(),
    };
    let busy = || {
        refused(
            429,
            json!({"error": {"type": "rate_limit_exceeded", "message": "Slow down."}}),
        )
    };
    // Each case: the answers scripted, the round's failure, and how many
    // requests it made: a plan used up is asked no more until it resets.
    let cases = [
        (
            vec![refused(429, json!({"error": limit}))],
            ("http_error", limited, Some(429)),
            1,
        ),
        (
            vec![Answer::events(&[ended(
                "failed",
                &json!({"status": "failed", "error": limit}),
            )])],
            ("provider_error", limited, Some(200)),
            1,
        ),
        (
            vec![busy(), busy(), busy()],
            (
                "http_error",
                "ChatGPT is busy. Try again in a moment.",
                Some(429),
            ),
            3,
        ),
        (
            vec![refused(400, json!({"detail": "Unsupported model."}))],
            (
                "http_error",
                "ChatGPT provider error: Unsupported model.",
                Some(400),
            ),
            1,
        ),
        (
            vec![Answer::events(&[json!({
                "type": "error",
                "message": "access-1 may not be used for acct-sam.",
            })
            .to_string()])],
            (
                "provider_error",
                "ChatGPT provider error: [redacted] may not be used for [redacted].",
                Some(200),
            ),
            1,
        ),
    ];

    for (answers, (code, message, status), asked) in cases {
        let before = stub.requests().len();

        for scripted in answers {
            stub.answer(scripted);
        }

        let answer = invoke(&adapter).await;
        let shown = format!("{answer:?}");

        assert_eq!(
            failure(&answer),
            (code.to_owned(), message.to_owned(), status),
            "{message}"
        );
        assert_eq!(stub.requests().len() - before, asked, "{message}");
        assert!(
            !shown.contains("access-1") && !shown.contains("acct-sam"),
            "{shown}"
        );
    }
}

#[tokio::test]
async fn a_plain_completion_on_a_plan_is_streamed_as_every_request_of_it_and_read_from_its_items() {
    let stub = Stub::start().await;
    let adapter = plan(&stub, &Arc::new(SignIn::default()));
    let request = TextCompletionRequest {
        instructions: "Condense.".to_owned(),
        input: "<conversation>...</conversation>".to_owned(),
        max_output_chars: NonZeroUsize::new(6_001).unwrap(),
    };

    stub.answer(Answer::events(&[
        done(0, &message("<think>planning</think>  We spoke of tea.  ")),
        json!({"type": "response.done"}).to_string(),
    ]));

    assert_eq!(
        adapter.complete_text(&request).await,
        TextCompletion::Completed {
            text: "We spoke of tea.".to_owned(),
            provider: ProviderName::Openai,
            model: Some("gpt-6.1-sol".to_owned()),
        }
    );

    let [asked] = stub.requests().try_into().unwrap();
    let body = asked.json();

    assert_eq!(
        asked.header("session-id"),
        body["prompt_cache_key"].as_str()
    );
    assert_eq!(
        body,
        json!({
            "model": "gpt-6.1-sol",
            "input": [
                {"type": "message", "role": "developer", "content": part("input_text", "Condense.")},
                {
                    "type": "message",
                    "role": "user",
                    "content": part("input_text", "<conversation>...</conversation>"),
                },
            ],
            "stream": true,
            "store": false,
            "instructions": "",
            "reasoning": {"effort": "low"},
            "include": ["reasoning.encrypted_content"],
            "prompt_cache_key": body["prompt_cache_key"],
        })
    );
}
