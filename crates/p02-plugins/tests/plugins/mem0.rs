//! The mem0 package through the host: recall before a turn, capture after
//! it, the search and add tools, and re-embedding, over a Mem0 backend and
//! over the embedded engine, each standing on a stub service on the
//! loopback interface.

use std::num::NonZeroU64;
use std::sync::Arc;
use std::time::Duration;

use p02_contracts::{
    CommittedTurn, ContextItemKind, EvidenceStatus, ResolvedConfig, SourceKind, SourceReference,
    ToolCallResult, TurnIdentity, TurnText,
};
use p02_core::{
    CharacterProfile, EventId, EventIdentity, MessageId, SessionId, SpeakerName, Timestamp,
    TraceId, VisibleMessage, VisibleMessageRole, VisibleText,
};
use p02_plugins::{BeforeCallOutcome, PluginHost, PreparedContext, ToolCallReport, Turn, mem0};
use serde_json::{Value, json};

use crate::storage::Storage;
use crate::stub::{Answer, Stub, embedding};
use crate::support::{builder, bundled_manifest, call, id, run_round};

const SERVER_KEY: &str = "m0sk_server-secret";
const PLATFORM_KEY: &str = "platform-secret";
const EMBEDDINGS: &str = "/v1/embeddings";
const COMPLETIONS: &str = "/v1/chat/completions";

/// A host of mem0 alone, with these settings, under a budget of 5 s.
fn host(storage: &Arc<Storage>, settings: &Value) -> PluginHost {
    host_within(storage, settings, 5_000)
}

fn host_within(storage: &Arc<Storage>, settings: &Value, timeout_ms: u64) -> PluginHost {
    builder(Arc::clone(storage) as _)
        .plugin(
            manifest(timeout_ms),
            settings.as_object().unwrap().clone(),
            mem0::create,
        )
        .activate()
        .unwrap()
}

/// The bundled manifest, its hooks bounded at `timeout_ms`.
fn manifest(timeout_ms: u64) -> p02_contracts::Manifest {
    bundled_manifest("mem0", |manifest| {
        manifest["runtimePolicy"]["timeoutMs"] = json!(timeout_ms);
    })
}

fn server(stub: &Stub) -> Value {
    json!({"backend": "server", "baseUrl": stub.base_url(), "apiKey": SERVER_KEY})
}

fn platform(stub: &Stub) -> Value {
    json!({"backend": "platform", "baseUrl": stub.base_url(), "apiKey": PLATFORM_KEY})
}

fn embedded(stub: &Stub, embedder: &str) -> Value {
    json!({
        "backend": "oss",
        "ossLlmBaseUrl": stub.base_url(),
        "ossLlmModel": "extractor",
        "ossEmbedderModel": embedder,
    })
}

/// Sam's line and Mira's reply in `session`, as event `event`: the turn,
/// and the turn once committed.
fn exchange(session: &str, event: &str, line: &str, reply: &str) -> (Turn, CommittedTurn) {
    spoken(session, event, Some(("Sam", line)), ("Mira", reply))
}

/// A turn in `session`, as event `event`, that a speaker's `line` began, or
/// a moment of hers when none did, and the character's `reply` in it: the
/// turn, and the turn once committed.
fn spoken(
    session: &str,
    event: &str,
    line: Option<(&str, &str)>,
    (character, reply): (&str, &str),
) -> (Turn, CommittedTurn) {
    let session_id = SessionId::parse(session).unwrap();
    let message = |number: u64, role, speaker_id: &str, name: &str, text: &str| VisibleMessage {
        id: MessageId::new(session_id.clone(), NonZeroU64::new(number).unwrap()),
        role,
        speaker_id: id(speaker_id),
        speaker_name: SpeakerName::new(name).unwrap(),
        text: VisibleText::normalize(text).unwrap(),
    };
    let turn = Turn::new(TurnIdentity {
        session_id: session_id.clone(),
        event: EventIdentity::new(
            EventId::new(event).unwrap(),
            TraceId::new(&format!("trace-{event}")).unwrap(),
            Timestamp::new("2026-10-18T01:00:00.000Z").unwrap(),
        )
        .unwrap(),
        character: CharacterProfile {
            id: id("mira"),
            display_name: SpeakerName::new("Mira").unwrap(),
        },
    })
    .with_text(TurnText {
        current_user_message: line.map(|(_, text)| VisibleText::normalize(text).unwrap()),
        recent_visible_message_ids: Vec::new(),
    });
    let committed = CommittedTurn::new(Timestamp::new("2026-10-18T01:00:01.000Z").unwrap())
        .with_messages(
            line.map(|(speaker, text)| {
                message(1, VisibleMessageRole::User, "local-user", speaker, text)
            })
            .into_iter()
            .chain([message(
                2,
                VisibleMessageRole::Character,
                "mira",
                character,
                reply,
            )])
            .collect(),
        );

    (turn, committed)
}

fn line(text: &str) -> Turn {
    exchange("chat.1", "evt_1", text, "Hm.").0
}

async fn recall(host: &PluginHost, turn: &Turn) -> PreparedContext {
    match host.before_role_model_call(turn).await {
        BeforeCallOutcome::Prepared(prepared) => prepared,
        BeforeCallOutcome::Rejected(rejection) => panic!("rejected: {rejection:?}"),
    }
}

/// The record the capture of a committed turn left.
async fn capture(
    host: &PluginHost,
    turn: &Turn,
    committed: &CommittedTurn,
) -> (EvidenceStatus, String) {
    let report = host.after_turn_committed(turn, committed).await;
    let record = &report.evidence[0];

    (record.status(), record.summary().to_owned())
}

async fn ask(host: &PluginHost, tool: &str, input: Value, turn: &Turn) -> ToolCallReport {
    run_round(host, vec![call("c1", tool, input)], turn)
        .await
        .remove(0)
}

fn output(report: &ToolCallReport) -> &Value {
    match &report.result {
        ToolCallResult::Accepted { output } => output,
        ToolCallResult::Rejected { reason, message } => panic!("{reason}: {message}"),
    }
}

fn refusal(report: &ToolCallReport) -> (&str, &str) {
    match &report.result {
        ToolCallResult::Rejected { reason, message } => (reason, message),
        ToolCallResult::Accepted { output } => panic!("answered {output}"),
    }
}

/// Ends `host` once the captures it queued settled, and says what its
/// shutdown recorded.
async fn drained(host: PluginHost) -> String {
    host.shutdown().await.evidence[0].summary().to_owned()
}

/// Recalls `turn` until `count` memories come back, as re-embedding
/// catches up.
async fn recalls(host: &PluginHost, turn: &Turn, count: usize) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);

    loop {
        let found = recall(host, turn).await.context_items.len();

        if found == count {
            return;
        }

        assert!(
            tokio::time::Instant::now() < deadline,
            "recall found {found} memories, never {count}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The recalled items' texts and confidences.
fn items(prepared: &PreparedContext) -> Vec<(&str, Option<f64>)> {
    prepared
        .context_items
        .iter()
        .map(|item| (item.item().text(), item.item().confidence()))
        .collect()
}

fn records(prepared: &PreparedContext) -> Vec<(EvidenceStatus, &str)> {
    prepared
        .evidence
        .iter()
        .map(|record| (record.status(), record.summary()))
        .collect()
}

fn rows(texts: &[&str], score: f64) -> Answer {
    Answer::json(
        200,
        &json!({
            "results": texts
                .iter()
                .enumerate()
                .map(|(at, text)| json!({"id": format!("mem-{at}"), "memory": text, "score": score}))
                .collect::<Vec<_>>(),
        }),
    )
}

/// The texts embedded by `model`, in the order they were asked for.
fn embedded_texts(stub: &Stub, model: &str) -> Vec<String> {
    stub.requests_to(EMBEDDINGS)
        .into_iter()
        .filter(|request| request.body["model"] == model)
        .map(|request| request.body["input"].as_str().unwrap().to_owned())
        .collect()
}

/// Which of `facts` `model` embedded, in the order they were asked for:
/// what re-embedding asked, without the lines recalls asked for.
fn embedded_facts(stub: &Stub, model: &str, facts: &[&str]) -> Vec<String> {
    embedded_texts(stub, model)
        .into_iter()
        .filter(|text| facts.contains(&text.as_str()))
        .collect()
}

fn cosine(left: &[f32], right: &[f32]) -> f64 {
    let (mut dot, mut left_norm, mut right_norm) = (0.0_f64, 0.0_f64, 0.0_f64);

    for (&left, &right) in left.iter().zip(right) {
        let (left, right) = (f64::from(left), f64::from(right));

        dot += left * right;
        left_norm += left * left;
        right_norm += right * right;
    }

    dot / (left_norm.sqrt() * right_norm.sqrt())
}

#[tokio::test]
async fn the_server_backend_asks_its_base_url_and_hands_it_each_turn() {
    let mem0 = Stub::mem0().await;
    let storage = Storage::new();
    let (turn, committed) = exchange("chat.1", "evt_1", "Remember the lighthouse.", "I will.");
    let to_server = host(&storage, &server(&mem0));

    recall(&to_server, &turn).await;
    capture(&to_server, &turn, &committed).await;

    let add = mem0.requests_once("/memories", 1).await.remove(0);
    let search = mem0.requests_to("/search").remove(0);

    assert_eq!(
        (search.method.as_str(), search.body.clone()),
        (
            "POST",
            json!({
                "query": "Remember the lighthouse.",
                "user_id": "project02-user",
                "agent_id": "mira",
                "limit": 5,
            })
        )
    );
    assert_eq!(
        (add.method.as_str(), add.body.clone()),
        (
            "POST",
            json!({
                "messages": [
                    {"role": "user", "content": "Sam: Remember the lighthouse."},
                    {"role": "assistant", "content": "Mira: I will."},
                ],
                "user_id": "project02-user",
                "agent_id": "mira",
                "infer": true,
            })
        )
    );

    for request in [&search, &add] {
        assert_eq!(request.header("x-api-key"), Some(SERVER_KEY));
        assert_eq!(request.header("authorization"), None);
    }

    let with_a_token = host(
        &storage,
        &json!({"backend": "server", "baseUrl": mem0.base_url(), "apiKey": "server-jwt"}),
    );

    recall(&with_a_token, &turn).await;

    let last = mem0.requests().pop().unwrap();

    assert_eq!(last.header("authorization"), Some("Bearer server-jwt"));
    assert_eq!(last.header("x-api-key"), None);
}

#[tokio::test]
async fn the_platform_backend_speaks_version_3_under_token_auth() {
    let stub = Stub::mem0().await;
    let host = host(&Storage::new(), &platform(&stub));
    let (turn, committed) = exchange("chat.1", "evt_1", "Do I like tea?", "You do.");

    stub.answer(
        "/v3/memories/search/",
        Answer::json(
            200,
            &json!({"results": [
                {"id": "row-1", "memory": "Prefers tea.", "score": 0.83},
                {"id": 42, "text": "Numeric id row."},
            ]}),
        ),
    );
    stub.answer(
        "/v3/memories/add/",
        Answer::json(200, &json!({"event_id": "evt-queued", "status": "PENDING"})),
    );

    let recalled = recall(&host, &turn).await;

    assert_eq!(
        items(&recalled),
        [("Prefers tea.", Some(0.83)), ("Numeric id row.", None)]
    );
    assert_eq!(
        recalled.context_items[1].item().source_references()[0].id(),
        "42"
    );

    capture(&host, &turn, &committed).await;
    stub.requests_once("/v3/memories/add/", 1).await;

    let requests = stub.requests();
    let asked: Vec<(&str, &str)> = requests
        .iter()
        .map(|request| (request.method.as_str(), request.path.as_str()))
        .collect();

    assert_eq!(
        asked,
        [
            ("POST", "/v3/memories/search/"),
            ("POST", "/v3/memories/add/"),
        ]
    );
    assert_eq!(
        requests[0].body,
        json!({
            "query": "Do I like tea?",
            "filters": {"user_id": "project02-user", "agent_id": "mira"},
            "top_k": 5,
        })
    );
    assert_eq!(
        requests[1].body,
        json!({
            "messages": [
                {"role": "user", "content": "Sam: Do I like tea?"},
                {"role": "assistant", "content": "Mira: You do."},
            ],
            "user_id": "project02-user",
            "agent_id": "mira",
            "infer": true,
        })
    );

    for request in &requests {
        assert_eq!(
            request.header("authorization"),
            Some("Token platform-secret")
        );
    }
}

#[tokio::test]
async fn a_redirect_an_unreadable_answer_or_another_backends_answer_fails_the_call_without_the_key()
{
    let to_server_stub = Stub::mem0().await;
    let to_platform_stub = Stub::mem0().await;
    let storage = Storage::new();
    let to_server = host(&storage, &server(&to_server_stub));
    let to_platform = host(&storage, &platform(&to_platform_stub));
    let turn = line("What do you remember?");

    to_server_stub.answer(
        "/search",
        Answer::redirect(&format!("{}/elsewhere", to_server_stub.base_url())),
    );
    to_server_stub.answer(
        "/search",
        Answer::json(
            401,
            &json!({"detail": format!("The key {SERVER_KEY} was rejected.")}),
        ),
    );
    to_server_stub.answer("/search", Answer::text(200, "not json"));
    to_server_stub.answer(
        "/memories",
        Answer::json(200, &json!({"event_id": "evt-queued", "status": "PENDING"})),
    );
    to_platform_stub.answer(
        "/v3/memories/add/",
        Answer::json(200, &json!({"results": [{"id": "mem-9"}]})),
    );

    let mut reports = Vec::new();

    for _ in 0..3 {
        reports.push(
            ask(
                &to_server,
                "mem0.search",
                json!({"query": "lighthouse"}),
                &turn,
            )
            .await,
        );
    }

    reports.push(
        ask(
            &to_server,
            "mem0.add",
            json!({"text": "The lighthouse is red."}),
            &turn,
        )
        .await,
    );
    reports.push(
        ask(
            &to_platform,
            "mem0.add",
            json!({"text": "The harbor is quiet."}),
            &turn,
        )
        .await,
    );

    let unreadable = |operation: &str| {
        format!("mem0 {operation} failed: backend returned an unreadable response body.")
    };

    assert_eq!(
        reports.iter().map(refusal).collect::<Vec<_>>(),
        [
            ("handler_failed", "mem0 search failed: HTTP 302."),
            ("handler_failed", "mem0 search failed: HTTP 401."),
            ("handler_failed", unreadable("search").as_str()),
            ("handler_failed", unreadable("add").as_str()),
            ("handler_failed", unreadable("add").as_str()),
        ]
    );
    assert!(!format!("{reports:?}").contains(SERVER_KEY));
    assert!(!format!("{reports:?}").contains(PLATFORM_KEY));
    assert!(to_server_stub.requests_to("/elsewhere").is_empty());
}

/// A moment of Mira's own, which no line began, has nothing to recall by
/// and nothing to learn from: the backend is never asked, and her end waits
/// on no capture.
#[tokio::test]
async fn a_moment_recalls_nothing_by_itself_and_queues_no_capture() {
    let mem0 = Stub::mem0().await;
    let host = host(&Storage::new(), &server(&mem0));
    let (turn, committed) = spoken("chat.1", "evt_1", None, ("Mira", "Thinking of you."));
    let recalled = recall(&host, &turn).await;
    let captured = host.after_turn_committed(&turn, &committed).await;

    assert_eq!(recalled, PreparedContext::default());
    assert!(captured.evidence.is_empty(), "{captured:?}");
    assert_eq!(drained(host).await, "Closed memory provider.");
    assert!(mem0.requests().is_empty());
}

#[tokio::test]
async fn a_capture_the_shutdown_could_not_wait_for_is_reported_lost() {
    let mem0 = Stub::mem0().await;
    let host = host_within(&Storage::new(), &server(&mem0), 500);
    let mut held = mem0.hold("/memories");
    let (turn, committed) = exchange("chat.1", "evt_1", "Line 1.", "Noted.");

    capture(&host, &turn, &committed).await;
    held.arrived().await;

    let report = host.shutdown().await;

    assert_eq!(
        (report.evidence[0].status(), report.evidence[0].summary()),
        (
            EvidenceStatus::Degraded,
            "Closed memory provider. mem0 add was abandoned before the backend answered; \
             whether it completed is unknown."
        )
    );
}

#[tokio::test]
async fn a_failed_capture_is_forgotten_once_a_capture_after_it_completes() {
    let mem0 = Stub::mem0().await;
    let host = host(&Storage::new(), &server(&mem0));

    mem0.answer("/memories", Answer::json(500, &json!({})));

    for number in 1..=2 {
        let (turn, committed) = exchange(
            "chat.1",
            &format!("evt_{number}"),
            &format!("Line {number}."),
            "Noted.",
        );

        capture(&host, &turn, &committed).await;
    }

    assert_eq!(drained(host).await, "Closed memory provider.");
}

#[tokio::test]
async fn recall_brings_at_most_five_memories_each_bounded_and_sourced_to_its_own() {
    let mem0 = Stub::mem0().await;
    let host = host(&Storage::new(), &server(&mem0));
    let long = "x".repeat(700);
    let texts = [
        "Sam likes tea.",
        "Sam lives by the sea.",
        "Sam has a cat.",
        "Sam reads at night.",
        long.as_str(),
        "Sam hums when thinking.",
    ];
    let scores = [0.9, 1.7, -0.2, 0.5, 0.4, 0.3];

    mem0.answer(
        "/search",
        Answer::json(
            200,
            &json!({
                "results": texts.iter().zip(scores).enumerate().map(|(at, (text, score))| {
                    json!({"id": format!("mem-{at}"), "memory": text, "score": score})
                }).collect::<Vec<_>>(),
            }),
        ),
    );

    let recalled = recall(&host, &line("What do I like?")).await;
    let cut = format!("{}...", "x".repeat(597));

    assert_eq!(
        items(&recalled),
        [
            ("Sam likes tea.", Some(0.9)),
            ("Sam lives by the sea.", Some(1.0)),
            ("Sam has a cat.", Some(0.0)),
            ("Sam reads at night.", Some(0.5)),
            (cut.as_str(), Some(0.4)),
        ]
    );

    for (at, item) in recalled.context_items.iter().enumerate() {
        let item = item.item();
        let source = &item.source_references()[0];

        assert_eq!(item.kind(), ContextItemKind::Memory);
        assert_eq!(item.id().as_str(), format!("memory.mem-{at}"));
        assert_eq!(
            (source.kind(), source.id(), source.title()),
            (
                SourceKind::Memory,
                format!("mem-{at}").as_str(),
                Some("Mem0 memory")
            )
        );
        assert_eq!(item.redaction_labels()[0].as_str(), "memory");
    }

    assert_eq!(
        records(&recalled),
        [(EvidenceStatus::Accepted, "Provided 5 memory item(s).")]
    );
}

#[tokio::test]
async fn the_search_tool_answers_at_most_five_bounded_sourced_items_and_a_search_that_finds_none() {
    let mem0 = Stub::mem0().await;
    let host = host(&Storage::new(), &server(&mem0));
    let long = "y".repeat(700);
    let texts: Vec<String> = (0..7)
        .map(|at| {
            if at == 4 {
                long.clone()
            } else {
                format!("Memory {at}.")
            }
        })
        .collect();
    let texts: Vec<&str> = texts.iter().map(String::as_str).collect();
    let turn = line("What do you remember?");

    mem0.answer("/search", rows(&texts, 0.5));
    mem0.answer("/search", Answer::json(200, &json!({"results": []})));

    let found = ask(&host, "mem0.search", json!({"query": "memories"}), &turn).await;
    let none = ask(
        &host,
        "mem0.search",
        json!({"query": "nothing at all"}),
        &turn,
    )
    .await;

    assert_eq!(
        output(&found),
        &json!({
            "items": (0..5).map(|at| json!({
                "id": format!("mem-{at}"),
                "text": if at == 4 { format!("{}...", "y".repeat(597)) } else { format!("Memory {at}.") },
                "sourceReferences": [{"kind": "memory", "id": format!("mem-{at}"), "title": "Mem0 memory"}],
                "confidence": 0.5,
            })).collect::<Vec<_>>(),
        })
    );
    assert_eq!(output(&none), &json!({"items": []}));
}

#[tokio::test]
async fn the_add_tool_keeps_the_text_as_written_and_names_the_memory_it_stored() {
    let mem0 = Stub::mem0().await;
    let host = host(&Storage::new(), &server(&mem0));
    let text = "z".repeat(700);

    mem0.answer(
        "/memories",
        Answer::json(200, &json!({"results": [{"id": "mem-0"}, {"id": "mem-1"}]})),
    );

    let report = ask(
        &host,
        "mem0.add",
        json!({"text": text}),
        &line("Keep this."),
    )
    .await;
    let record = &report.evidence[0];

    assert_eq!(
        mem0.requests_to("/memories")[0].body,
        json!({
            "messages": [{"role": "user", "content": text}],
            "user_id": "project02-user",
            "agent_id": "mira",
            "infer": false,
        })
    );
    assert_eq!(
        output(&report),
        &json!({
            "id": "mem-0",
            "sourceReferences": [{"kind": "memory", "id": "mem-0", "title": "Mem0 memory"}],
        })
    );
    assert_eq!(record.summary(), "Added one memory item.");
    assert_eq!(
        record
            .source_references()
            .iter()
            .map(SourceReference::kind)
            .collect::<Vec<_>>(),
        [SourceKind::Conversation, SourceKind::Memory]
    );
}

#[tokio::test]
async fn an_add_the_backend_keeps_already_says_so_and_one_it_failed_fails() {
    let mem0 = Stub::mem0().await;
    let host = host(&Storage::new(), &server(&mem0));
    let turn = line("Keep this.");

    mem0.answer("/memories", Answer::json(200, &json!({"results": []})));
    mem0.answer("/memories", Answer::json(500, &json!({})));

    let kept = ask(&host, "mem0.add", json!({"text": "Sam likes tea."}), &turn).await;
    let failed = ask(&host, "mem0.add", json!({"text": "Sam likes tea."}), &turn).await;

    assert_eq!(output(&kept), &json!({"alreadyKept": true}));
    assert_eq!(
        refusal(&failed),
        ("handler_failed", "mem0 add failed: HTTP 500.")
    );
}

#[tokio::test]
async fn a_queued_platform_add_is_never_claimed_as_stored() {
    let stub = Stub::mem0().await;
    let host = host(&Storage::new(), &platform(&stub));

    stub.answer(
        "/v3/memories/add/",
        Answer::json(200, &json!({"event_id": "evt-queued", "status": "PENDING"})),
    );

    let report = ask(
        &host,
        "mem0.add",
        json!({"text": "The harbor is quiet."}),
        &line("Keep that."),
    )
    .await;

    assert_eq!(
        output(&report),
        &json!({
            "queued": true,
            "sourceReferences": [
                {"kind": "external_contract", "id": "evt-queued", "title": "Queued mem0 memory write"},
            ],
        })
    );
    assert_eq!(
        report.evidence[0].summary(),
        "Queued one memory item for the backend to store."
    );
}

#[tokio::test]
async fn an_add_abandoned_at_the_deadline_warns_that_it_may_have_landed() {
    let mem0 = Stub::mem0().await;
    let host = host_within(&Storage::new(), &server(&mem0), 1_000);
    let _held = mem0.hold("/memories");
    let report = ask(
        &host,
        "mem0.add",
        json!({"text": "Sam likes tea."}),
        &line("Keep this."),
    )
    .await;

    assert_eq!(
        refusal(&report),
        (
            "handler_failed",
            "mem0 add was abandoned before the backend answered; whether it completed is unknown."
        )
    );
}

#[test]
fn the_check_says_what_the_settings_lack_and_never_echoes_a_malformed_address() {
    let manifest = manifest(5_000);
    let rule = "an absolute http:// or https:// address with no embedded credentials, query, or \
                fragment";

    for (settings, sentence) in [
        (
            json!({"backend": "server"}),
            "Long-Term Memory needs a server address.".to_owned(),
        ),
        (
            json!({"backend": "platform"}),
            "Long-Term Memory needs an API key.".to_owned(),
        ),
        (
            json!({"backend": "server", "baseUrl": "https://operator:hunter2@mem0.example"}),
            format!("Long-Term Memory's server address must be {rule}."),
        ),
        (
            json!({"backend": "oss", "ossLlmBaseUrl": "localhost:11434/v1"}),
            format!("Long-Term Memory's server for Remembering must be {rule}."),
        ),
        (
            json!({"backend": "oss", "ossLlmBaseUrl": "http://localhost:11434/v1", "ossEmbedderBaseUrl": "https://api.openai.com/v1/"}),
            "Long-Term Memory needs an API key for Searching.".to_owned(),
        ),
        (
            json!({"backend": "oss"}),
            "Long-Term Memory needs an API key for Remembering, or a server for it such as \
             Ollama."
                .to_owned(),
        ),
    ] {
        let config = ResolvedConfig::resolve(manifest.config(), settings.as_object().unwrap());

        assert_eq!(mem0::check_setup(&config), Err(sentence), "{settings}");
    }
}

#[tokio::test]
async fn a_turn_is_extracted_with_mem0s_prompt_its_sessions_messages_and_its_nearest_memories() {
    let openai = Stub::openai().await;
    let storage = Storage::new();
    let host = host(&storage, &embedded(&openai, "embed-a"));
    let (first, first_committed) = exchange("chat.1", "evt_1", "I love green tea.", "Noted.");
    let (second, second_committed) = exchange(
        "chat.1",
        "evt_2",
        "My cat Biscuit knocked my telescope over.",
        "Oh no!",
    );

    openai.answer(COMPLETIONS, Answer::extraction(&["Sam loves green tea."]));
    capture(&host, &first, &first_committed).await;
    capture(&host, &second, &second_committed).await;

    let extraction = openai.requests_once(COMPLETIONS, 2).await.remove(1);
    let messages = extraction.body["messages"].as_array().unwrap();
    let system = messages[0]["content"].as_str().unwrap();

    assert_eq!(extraction.body["model"], json!("extractor"));
    assert_eq!(
        extraction.body["response_format"],
        json!({"type": "json_object"})
    );
    assert_eq!(messages[0]["role"], json!("system"));
    assert!(system.starts_with("\n# ROLE\n\nYou are a Memory Extractor"));
    assert_eq!(system.chars().count(), 33_655);
    assert_eq!(messages[1]["role"], json!("user"));
    assert_eq!(
        messages[1]["content"],
        json!(
            "## Summary\n\n\n## Last k Messages\nuser: Sam: I love green tea.\nassistant: Mira: \
             Noted.\n\n\n## Recently Extracted Memories\n[]\n\n## Existing Memories\n\
             [{\"id\":\"0\",\"text\":\"Sam loves green tea.\"}]\n\n## New Messages\nuser: Sam: My \
             cat Biscuit knocked my telescope over.\nassistant: Mira: Oh no!\n\n## Observation \
             Date\n2026-10-18\n\n## Current Date\n2026-10-18\n\n## Custom Instructions\nRefer to \
             people by the names used in the conversation; never call anyone \"user\" or \
             \"assistant\".\n\n# Output:"
        )
    );

    let conversation = &openai.requests_to(EMBEDDINGS)[0];

    assert_eq!(
        conversation.body,
        json!({
            "model": "embed-a",
            "input": "user: Sam: I love green tea.\nassistant: Mira: Noted.",
            "encoding_format": "float",
        })
    );
}

#[tokio::test]
async fn an_add_is_stored_while_a_capture_waits_on_the_extraction_model() {
    let openai = Stub::openai().await;
    let storage = Storage::new();
    let host = host(&storage, &embedded(&openai, "embed-a"));
    let (turn, committed) = exchange("chat.1", "evt_1", "I like tea.", "Noted.");
    let mut held = openai.hold(COMPLETIONS);

    capture(&host, &turn, &committed).await;
    held.arrived().await;

    let report = ask(&host, "mem0.add", json!({"text": "Sam likes cake."}), &turn).await;

    assert_eq!(output(&report)["sourceReferences"][0]["kind"], "memory");
    held.release(Answer::extraction(&[]));
}

#[tokio::test]
async fn recall_ranks_each_memory_by_the_vector_of_its_own_text_and_leaves_out_the_unalike() {
    let openai = Stub::openai().await;
    let storage = Storage::new();
    let capturing = host(&storage, &embedded(&openai, "embed-a"));
    let (turn, committed) = exchange("chat.1", "evt_1", "Tell me about yourself.", "Gladly.");
    let tea = "Sam likes green tea.";
    let cat = "Sam has a cat named Biscuit.";

    openai.answer(
        COMPLETIONS,
        Answer::extraction(&[tea, cat, "Biscuit sleeps all day."]),
    );
    capture(&capturing, &turn, &committed).await;
    assert_eq!(drained(capturing).await, "Closed memory provider.");

    let query = "What tea does Sam like?";
    let recalled = recall(&host(&storage, &embedded(&openai, "embed-a")), &line(query)).await;
    let alike = |text| cosine(&embedding("embed-a", query), &embedding("embed-a", text));

    assert_eq!(
        embedded_texts(&openai, "embed-a")[1..],
        [tea, cat, "Biscuit sleeps all day.", query]
    );
    assert_eq!(
        items(&recalled),
        [(tea, Some(alike(tea))), (cat, Some(alike(cat)))]
    );
    assert!(alike(tea) > alike(cat) && alike(cat) > 0.1);
}

#[tokio::test]
async fn a_crash_in_the_middle_of_re_embedding_resumes_where_it_stopped() {
    let openai = Stub::openai().await;
    let storage = Storage::new();
    let turn = line("Sam likes tea");
    let facts = [
        "Sam likes tea at dawn.",
        "Sam likes tea at noon.",
        "Sam likes tea at dusk.",
        "Sam likes tea at night.",
        "Sam likes tea at midnight.",
    ];
    let first = host(&storage, &embedded(&openai, "embed-a"));

    for fact in facts {
        output(&ask(&first, "mem0.add", json!({"text": fact}), &turn).await);
    }

    drop(first);
    // The recall's own line and the first two memories pass; the third
    // memory is held while the engine that asked for it goes.
    openai.pass(EMBEDDINGS, 3);

    let mut held = openai.hold(EMBEDDINGS);
    let second = host(&storage, &embedded(&openai, "embed-b"));

    recall(&second, &turn).await;

    assert_eq!(held.arrived().await.body["input"], json!(facts[2]));

    drop(second);
    drop(held);

    let resumed = host(&storage, &embedded(&openai, "embed-b"));

    recalls(&resumed, &turn, 5).await;

    assert_eq!(
        embedded_facts(&openai, "embed-b", &facts),
        [&facts[..3], &facts[2..]].concat()
    );
}

#[tokio::test]
async fn a_second_embedder_change_in_the_middle_of_re_embedding_re_embeds_for_the_newest() {
    let openai = Stub::openai().await;
    let storage = Storage::new();
    let turn = line("Sam likes tea");
    let facts = [
        "Sam likes tea at dawn.",
        "Sam likes tea at noon.",
        "Sam likes tea at dusk.",
        "Sam likes tea at night.",
        "Sam likes tea at midnight.",
    ];
    let first = host(&storage, &embedded(&openai, "embed-a"));

    for fact in facts {
        output(&ask(&first, "mem0.add", json!({"text": fact}), &turn).await);
    }

    drop(first);
    openai.pass(EMBEDDINGS, 3);

    let mut held = openai.hold(EMBEDDINGS);
    let changing = host(&storage, &embedded(&openai, "embed-b"));

    recall(&changing, &turn).await;

    assert_eq!(held.arrived().await.body["input"], json!(facts[2]));

    // Built again on a third embedder while the second still re-embeds.
    let newest = host(&storage, &embedded(&openai, "embed-c"));

    drop(changing);
    drop(held);
    recalls(&newest, &turn, 5).await;

    assert_eq!(embedded_facts(&openai, "embed-b", &facts), &facts[..3]);
    assert_eq!(embedded_facts(&openai, "embed-c", &facts), facts);
}

#[tokio::test]
async fn re_embedding_that_stopped_on_a_failure_resumes_once_the_embedder_answers() {
    let openai = Stub::openai().await;
    let storage = Storage::new();
    let turn = line("Sam likes tea");
    let facts = ["Sam likes tea at dawn.", "Sam likes tea at dusk."];
    let first = host(&storage, &embedded(&openai, "embed-a"));

    for fact in facts {
        output(&ask(&first, "mem0.add", json!({"text": fact}), &turn).await);
    }

    drop(first);

    // The embedder refuses the recall's own line and the first memory.
    for _ in 0..2 {
        openai.answer(
            EMBEDDINGS,
            Answer::json(404, &json!({"error": "no such model"})),
        );
    }

    let second = host(&storage, &embedded(&openai, "embed-b"));

    recall(&second, &turn).await;
    openai.requests_once(EMBEDDINGS, 4).await;
    recalls(&second, &turn, 2).await;

    assert_eq!(
        embedded_facts(&openai, "embed-b", &facts),
        [facts[0], facts[0], facts[1]]
    );
}

#[tokio::test]
async fn an_extraction_with_no_memory_list_loses_the_capture_and_the_shutdown_says_why() {
    let openai = Stub::openai().await;
    let storage = Storage::new();
    let host = host(&storage, &embedded(&openai, "embed-a"));
    let (turn, committed) = exchange("chat.1", "evt_1", "I like tea.", "Noted.");

    openai.answer(COMPLETIONS, Answer::completion("I cannot help with that."));
    capture(&host, &turn, &committed).await;

    assert_eq!(
        drained(host).await,
        "Closed memory provider. mem0 add failed: the extraction model's answer held no memory \
         list."
    );
}
