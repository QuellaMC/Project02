//! The mem0 package through the host: recall before a turn, capture after
//! it, the search and add tools, and health, over a Mem0 backend and over
//! the embedded engine, each standing on a stub service on the loopback
//! interface.

use std::num::NonZeroU64;
use std::sync::Arc;
use std::time::Duration;

use p02_contracts::{
    CommittedTurn, ContextItemKind, EvidenceStatus, HealthStatus, SourceKind, ToolCallResult,
    TurnIdentity, TurnText,
};
use p02_core::{
    CharacterProfile, EventId, EventIdentity, MessageId, SessionId, SpeakerName, Timestamp,
    TraceId, VisibleMessage, VisibleMessageRole, VisibleText,
};
use p02_plugins::{BeforeCallOutcome, PluginHost, PreparedContext, ToolCallReport, Turn, mem0};
use serde_json::{Value, json};

use crate::storage::Storage;
use crate::stub::{Answer, Stub, embedding};
use crate::support::{bundled_manifest, call, id};

const SERVER_KEY: &str = "m0sk_server-secret";
const PLATFORM_KEY: &str = "platform-secret";
const EMBEDDINGS: &str = "/v1/embeddings";
const COMPLETIONS: &str = "/v1/chat/completions";

/// A host of mem0 alone, with these settings, under a budget of 5 s.
fn host(storage: &Arc<Storage>, settings: &Value) -> PluginHost {
    host_within(storage, settings, 5_000)
}

fn host_within(storage: &Arc<Storage>, settings: &Value, timeout_ms: u64) -> PluginHost {
    PluginHost::builder(Arc::clone(storage) as _)
        .plugin(
            manifest(timeout_ms),
            settings.as_object().unwrap().clone(),
            mem0::create,
        )
        .activate()
        .unwrap()
}

/// The bundled manifest with the database the embedded engine keeps its
/// memories in, which the TypeScript daemon's memory provider refuses, so
/// the descriptor cannot carry it until that daemon goes.
fn manifest(timeout_ms: u64) -> p02_contracts::Manifest {
    bundled_manifest("mem0", |manifest| {
        manifest["runtimePolicy"]["timeoutMs"] = json!(timeout_ms);
        manifest["requestedAccess"]["plugin_database"] = json!("write");
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
    spoken(session, event, ("Sam", line), ("Mira", reply))
}

fn spoken(
    session: &str,
    event: &str,
    (speaker, line): (&str, &str),
    (character, reply): (&str, &str),
) -> (Turn, CommittedTurn) {
    let session_id = SessionId::new(session).unwrap();
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
        current_user_message: VisibleText::normalize(line).unwrap(),
        recent_visible_message_ids: Vec::new(),
    });
    let committed = CommittedTurn::new(Timestamp::new("2026-10-18T01:00:01.000Z").unwrap())
        .with_messages(vec![
            message(1, VisibleMessageRole::User, "local-user", speaker, line),
            message(2, VisibleMessageRole::Character, "mira", character, reply),
        ]);

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
    host.handle_tool_calls(vec![call("c1", tool, input)], turn)
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

async fn health(host: &PluginHost, turn: &Turn) -> (HealthStatus, String) {
    let check = host.health(turn).await;
    let snapshot = &check.snapshots[0];

    (snapshot.status(), snapshot.summary().to_owned())
}

/// Health once its summary says `words`.
async fn health_saying(host: &PluginHost, turn: &Turn, words: &str) -> (HealthStatus, String) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);

    loop {
        let checked = health(host, turn).await;

        if checked.1.contains(words) {
            return checked;
        }

        assert!(
            tokio::time::Instant::now() < deadline,
            "health never said {words:?}: {checked:?}"
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
async fn the_server_backend_asks_its_base_url_and_hands_it_each_turn_under_its_session() {
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
                "run_id": "chat.1",
                "infer": true,
                "metadata": {"project02_sources": ["evt_1"]},
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

    assert_eq!(
        health_saying(&host, &turn, "Queued the last").await,
        (
            HealthStatus::Ok,
            "Mem0 platform API reachable. Queued the last captured turn with the backend."
                .to_owned()
        )
    );

    let requests = stub.requests();
    let asked: Vec<(&str, &str)> = requests
        .iter()
        .map(|request| (request.method.as_str(), request.path.as_str()))
        .collect();

    assert_eq!(
        asked[..3],
        [
            ("POST", "/v3/memories/search/"),
            ("POST", "/v3/memories/add/"),
            ("GET", "/v1/ping/"),
        ]
    );
    assert!(
        asked[3..]
            .iter()
            .all(|asked| *asked == ("GET", "/v1/ping/"))
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
            "run_id": "chat.1",
            "infer": true,
            "metadata": {"project02_sources": ["evt_1"]},
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
        "/search",
        Answer::json(
            200,
            &json!({"results": [{"memory": "A row without an id."}]}),
        ),
    );
    to_server_stub.answer(
        "/memories",
        Answer::json(200, &json!({"event_id": "evt-queued", "status": "PENDING"})),
    );
    to_platform_stub.answer(
        "/v3/memories/add/",
        Answer::json(200, &json!({"results": [{"id": "mem-9"}]})),
    );

    let mut reports = Vec::new();

    for _ in 0..4 {
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
            ("handler_failed", unreadable("search").as_str()),
            ("handler_failed", unreadable("add").as_str()),
            ("handler_failed", unreadable("add").as_str()),
        ]
    );
    assert!(!format!("{reports:?}").contains(SERVER_KEY));
    assert!(!format!("{reports:?}").contains(PLATFORM_KEY));
    assert!(to_server_stub.requests_to("/elsewhere").is_empty());
}

#[tokio::test]
async fn a_turn_is_captured_behind_the_turn_under_the_names_its_session_recorded() {
    let mem0 = Stub::mem0().await;
    let host = host(&Storage::new(), &server(&mem0));
    let mut held = mem0.hold("/memories");
    let (turn, committed) = spoken(
        "chat.1",
        "evt_1",
        ("Samuel", "Line 1."),
        ("Mira the Bold", "Reply 1."),
    );
    let report = host.after_turn_committed(&turn, &committed).await;
    let record = &report.evidence[0];

    assert_eq!(
        (record.status(), record.summary()),
        (
            EvidenceStatus::Accepted,
            "Queued turn for memory extraction."
        )
    );
    assert_eq!(
        (
            record.source_references()[0].kind(),
            record.source_references()[0].id()
        ),
        (SourceKind::ExternalContract, "mem0.capture_queue")
    );
    assert_eq!(
        held.arrived().await.body["messages"],
        json!([
            {"role": "user", "content": "Samuel: Line 1."},
            {"role": "assistant", "content": "Mira the Bold: Reply 1."},
        ])
    );

    held.release(Answer::json(200, &json!({"results": [{"id": "mem-1"}]})));
}

#[tokio::test]
async fn once_eight_captures_wait_the_next_turn_is_not_queued_and_health_says_so() {
    let mem0 = Stub::mem0().await;
    let host = host(&Storage::new(), &server(&mem0));
    let mut held = mem0.hold("/memories");
    let mut recorded = Vec::new();

    for number in 1..=10 {
        let (turn, committed) = exchange(
            "chat.1",
            &format!("evt_{number}"),
            &format!("Line {number}."),
            "Noted.",
        );

        recorded.push(capture(&host, &turn, &committed).await);
    }

    held.arrived().await;

    let not_queued = (
        EvidenceStatus::Degraded,
        "Memory extraction is behind; this turn was not queued for capture.".to_owned(),
    );

    assert!(
        recorded[..8]
            .iter()
            .all(|(status, _)| *status == EvidenceStatus::Accepted)
    );
    assert_eq!(recorded[8..], [not_queued.clone(), not_queued]);

    let (status, summary) = health(&host, &line("hello")).await;

    assert_eq!(status, HealthStatus::Degraded);
    assert!(
        summary.starts_with(
            "2 capture(s) did not complete; most recent: extraction backlog is full (8 queued), \
             so the turn was never sent. Mem0 server reachable."
        ),
        "{summary}"
    );

    held.release(Answer::json(200, &json!({"results": []})));
}

#[tokio::test]
async fn what_is_queued_reaches_the_backend_before_shutdown_ends() {
    let mem0 = Stub::mem0().await;
    let host = host(&Storage::new(), &server(&mem0));
    let mut held = mem0.hold("/memories");

    for number in 1..=3 {
        let (turn, committed) = exchange(
            "chat.1",
            &format!("evt_{number}"),
            &format!("Line {number}."),
            "Noted.",
        );

        capture(&host, &turn, &committed).await;
    }

    held.arrived().await;

    let shutdown = tokio::spawn(async move { host.shutdown(&line("bye")).await });

    held.release(Answer::json(200, &json!({"results": [{"id": "mem-1"}]})));

    let report = shutdown.await.unwrap();

    assert_eq!(
        (report.evidence[0].status(), report.evidence[0].summary()),
        (EvidenceStatus::Accepted, "Closed memory provider.")
    );
    assert_eq!(
        mem0.requests_to("/memories")
            .iter()
            .map(|request| request.body["messages"][0]["content"].clone())
            .collect::<Vec<_>>(),
        ["Sam: Line 1.", "Sam: Line 2.", "Sam: Line 3."]
    );
}

#[tokio::test]
async fn a_capture_the_shutdown_could_not_wait_for_is_reported_lost() {
    let mem0 = Stub::mem0().await;
    let host = host_within(&Storage::new(), &server(&mem0), 500);
    let mut held = mem0.hold("/memories");
    let (turn, committed) = exchange("chat.1", "evt_1", "Line 1.", "Noted.");

    capture(&host, &turn, &committed).await;
    held.arrived().await;

    let report = host.shutdown(&turn).await;

    assert_eq!(
        (report.evidence[0].status(), report.evidence[0].summary()),
        (
            EvidenceStatus::Degraded,
            "Closed memory provider. 1 capture(s) did not complete; most recent: mem0 add was \
             abandoned before the backend answered; whether it completed is unknown."
        )
    );
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
async fn an_empty_recall_adds_nothing_and_a_failing_backend_degrades_the_turn() {
    let mem0 = Stub::mem0().await;
    let host = host(&Storage::new(), &server(&mem0));

    mem0.answer("/search", Answer::json(200, &json!({"results": []})));
    mem0.answer("/search", Answer::json(500, &json!({})));

    let empty = recall(&host, &line("Anything?")).await;
    let failing = recall(&host, &line("And now?")).await;

    assert_eq!(items(&empty), []);
    assert_eq!(
        records(&empty),
        [(EvidenceStatus::Accepted, "Provided 0 memory item(s).")]
    );
    assert_eq!(items(&failing), []);
    assert_eq!(
        records(&failing),
        [(
            EvidenceStatus::Degraded,
            "Optional before-role-model plugin hook degraded: mem0 search failed: HTTP 500."
        )]
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

    let no_results = &none.evidence[0].source_references()[0];

    assert_eq!(
        (no_results.kind(), no_results.id()),
        (SourceKind::Runtime, "evt_1:mem0.search.no_results")
    );
}

#[tokio::test]
async fn the_add_tool_keeps_bounded_text_and_names_the_rows_it_stored_within_a_record() {
    let mem0 = Stub::mem0().await;
    let host = host(&Storage::new(), &server(&mem0));
    let stored: Vec<Value> = (0..40)
        .map(|at| json!({"id": format!("mem-{at}")}))
        .collect();

    mem0.answer("/memories", Answer::json(200, &json!({"results": stored})));

    let report = ask(
        &host,
        "mem0.add",
        json!({"text": "z".repeat(700)}),
        &line("Keep this."),
    )
    .await;
    let added = output(&report);
    let record = &report.evidence[0];

    assert_eq!(
        mem0.requests_to("/memories")[0].body,
        json!({
            "messages": [{"role": "user", "content": format!("{}...", "z".repeat(597))}],
            "user_id": "project02-user",
            "agent_id": "mira",
            "infer": false,
            "metadata": {"project02_sources": ["evt_1"]},
        })
    );
    assert_eq!(added["id"], json!("mem-0"));
    assert_eq!(added["sourceReferences"].as_array().unwrap().len(), 32);
    assert_eq!(
        added["sourceReferences"][0],
        json!({"kind": "memory", "id": "mem-0", "title": "Mem0 memory"})
    );
    assert_eq!(record.summary(), "Added one memory item.");
    assert_eq!(record.source_references().len(), 32);
    assert_eq!(
        record.source_references()[0].kind(),
        SourceKind::Conversation
    );
}

#[tokio::test]
async fn an_add_that_stored_nothing_or_failed_is_a_failed_call() {
    let mem0 = Stub::mem0().await;
    let host = host(&Storage::new(), &server(&mem0));
    let turn = line("Keep this.");

    mem0.answer("/memories", Answer::json(200, &json!({"results": []})));
    mem0.answer("/memories", Answer::json(500, &json!({})));

    let nothing = ask(&host, "mem0.add", json!({"text": "Sam likes tea."}), &turn).await;
    let failed = ask(&host, "mem0.add", json!({"text": "Sam likes tea."}), &turn).await;

    assert_eq!(
        [refusal(&nothing), refusal(&failed)],
        [
            (
                "handler_failed",
                "mem0 add failed: the backend created no memory for it."
            ),
            ("handler_failed", "mem0 add failed: HTTP 500."),
        ]
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

#[tokio::test]
async fn health_names_what_the_settings_lack_and_a_malformed_address_without_echoing_it() {
    let storage = Storage::new();
    let turn = line("hello");
    let rule = "an absolute http:// or https:// address with no embedded credentials, query, or \
                fragment";

    for (settings, sentence) in [
        (
            json!({"backend": "server"}),
            "Mem0 server backend needs the baseUrl config field.".to_owned(),
        ),
        (
            json!({"backend": "platform"}),
            "Mem0 platform backend needs the apiKey config field (MEM0_API_KEY).".to_owned(),
        ),
        (
            json!({"backend": "server", "baseUrl": "https://operator:hunter2@mem0.example"}),
            format!("Mem0 baseUrl must be {rule}."),
        ),
        (
            json!({"backend": "oss", "ossLlmBaseUrl": "localhost:11434/v1"}),
            format!("Mem0 ossLlmBaseUrl must be {rule}."),
        ),
        (
            json!({"backend": "oss", "ossLlmBaseUrl": "http://localhost:11434/v1", "ossEmbedderBaseUrl": "https://api.openai.com/v1/"}),
            "Mem0 OSS embedding at the OpenAI endpoint needs the ossEmbedderApiKey config field \
             (MEM0_OSS_EMBEDDER_API_KEY)."
                .to_owned(),
        ),
    ] {
        let misconfigured = host(&storage, &settings);
        let report = ask(
            &misconfigured,
            "mem0.search",
            json!({"query": "tea"}),
            &turn,
        )
        .await;

        assert_eq!(
            health(&misconfigured, &turn).await,
            (HealthStatus::Unavailable, sentence.clone()),
            "{settings}"
        );
        assert_eq!(refusal(&report), ("handler_failed", sentence.as_str()));
        assert!(!format!("{report:?}").contains("hunter2"));
    }

    let (status, summary) = health(&host(&storage, &json!({"backend": "oss"})), &turn).await;

    assert_eq!(status, HealthStatus::Unavailable);
    assert!(summary.contains("MEM0_OSS_LLM_API_KEY"), "{summary}");
    assert!(summary.chars().count() <= 160);
}

#[tokio::test]
async fn health_pings_the_backend_and_is_unavailable_while_it_cannot_be_reached() {
    let mem0 = Stub::mem0().await;
    let storage = Storage::new();
    let turn = line("hello");
    let unreachable = {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();

        format!("http://{}", listener.local_addr().unwrap())
    };

    assert_eq!(
        health(&host(&storage, &server(&mem0)), &turn).await,
        (HealthStatus::Ok, "Mem0 server reachable.".to_owned())
    );
    assert_eq!(
        mem0.requests()
            .iter()
            .map(|request| (request.method.as_str(), request.path.as_str()))
            .collect::<Vec<_>>(),
        [("GET", "/")]
    );
    assert_eq!(
        health(
            &host(
                &storage,
                &json!({"backend": "server", "baseUrl": unreachable})
            ),
            &turn
        )
        .await,
        (
            HealthStatus::Unavailable,
            "mem0 ping failed: backend unreachable.".to_owned()
        )
    );
}

#[tokio::test]
async fn health_stays_degraded_after_a_lost_capture_and_leads_with_it() {
    let mem0 = Stub::mem0().await;
    let host = host(&Storage::new(), &server(&mem0));
    let (first, first_committed) = exchange("chat.1", "evt_1", "Line 1.", "Noted.");
    let (second, second_committed) = exchange("chat.1", "evt_2", "Line 2.", "Noted.");
    let lost = "1 capture(s) did not complete; most recent: mem0 add failed: HTTP 500.";

    mem0.answer("/memories", Answer::json(500, &json!({})));
    capture(&host, &first, &first_committed).await;

    assert_eq!(
        health_saying(&host, &first, "did not complete").await,
        (
            HealthStatus::Degraded,
            format!("{lost} Mem0 server reachable.")
        )
    );
    assert_eq!(
        capture(&host, &second, &second_committed).await,
        (
            EvidenceStatus::Accepted,
            "Queued turn for memory extraction. 1 earlier capture(s) did not complete.".to_owned()
        )
    );

    mem0.requests_once("/memories", 2).await;

    let (status, summary) = health(&host, &second).await;

    assert_eq!(status, HealthStatus::Degraded);
    assert!(summary.starts_with(lost), "{summary}");
}

#[tokio::test]
async fn the_engine_claims_readiness_only_once_its_model_and_embedder_both_answered() {
    let openai = Stub::openai().await;
    let storage = Storage::new();
    let host = host(&storage, &embedded(&openai, "embed-a"));
    let (turn, committed) = exchange("chat.1", "evt_1", "I like tea.", "Noted.");
    let unproven = (
        HealthStatus::Degraded,
        "Mem0 engine loaded; its model and embedder are contacted on first capture or recall."
            .to_owned(),
    );

    assert_eq!(health(&host, &turn).await, unproven);

    recall(&host, &turn).await;

    assert_eq!(health(&host, &turn).await, unproven);

    openai.answer(COMPLETIONS, Answer::extraction(&["Sam likes tea."]));
    capture(&host, &turn, &committed).await;

    assert_eq!(
        health_saying(&host, &turn, "Stored").await,
        (
            HealthStatus::Ok,
            "Mem0 engine loaded; its model and embedder have answered. Stored 1 memory item(s) \
             from the last captured turn."
                .to_owned()
        )
    );
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
    health_saying(&host, &first, "Stored 1").await;
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
    let host = host(&storage, &embedded(&openai, "embed-a"));
    let (turn, committed) = exchange("chat.1", "evt_1", "Tell me about yourself.", "Gladly.");
    let tea = "Sam likes green tea.";
    let cat = "Sam has a cat named Biscuit.";

    openai.answer(
        COMPLETIONS,
        Answer::extraction(&[tea, cat, "Biscuit sleeps all day."]),
    );
    capture(&host, &turn, &committed).await;
    health_saying(&host, &turn, "Stored 3").await;

    let query = "What tea does Sam like?";
    let recalled = recall(&host, &line(query)).await;
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
    openai.pass(EMBEDDINGS, 2);

    let mut held = openai.hold(EMBEDDINGS);
    let second = host(&storage, &embedded(&openai, "embed-b"));
    let (status, summary) = health(&second, &turn).await;

    assert_eq!(status, HealthStatus::Degraded);
    assert!(
        summary.starts_with("Mem0 engine is re-embedding its memories for a new embedder;"),
        "{summary}"
    );
    assert_eq!(held.arrived().await.body["input"], json!(facts[2]));

    drop(second);
    drop(held);

    let resumed = host(&storage, &embedded(&openai, "embed-b"));

    health_saying(&resumed, &turn, "contacted on first capture or recall").await;

    assert_eq!(
        embedded_texts(&openai, "embed-b"),
        [&facts[..3], &facts[2..]].concat()
    );
    assert_eq!(recall(&resumed, &turn).await.context_items.len(), 5);
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
    openai.pass(EMBEDDINGS, 2);

    let mut held = openai.hold(EMBEDDINGS);
    let changing = host(&storage, &embedded(&openai, "embed-b"));

    health(&changing, &turn).await;

    assert_eq!(held.arrived().await.body["input"], json!(facts[2]));

    changing
        .reload(
            &id("mem0"),
            embedded(&openai, "embed-c").as_object().unwrap(),
        )
        .unwrap();
    drop(held);
    health_saying(&changing, &turn, "contacted on first capture or recall").await;

    assert_eq!(embedded_texts(&openai, "embed-b"), &facts[..3]);
    assert_eq!(embedded_texts(&openai, "embed-c"), facts);
    assert_eq!(recall(&changing, &turn).await.context_items.len(), 5);
}

#[tokio::test]
async fn health_says_why_re_embedding_stopped_and_it_resumes_once_the_embedder_answers() {
    let openai = Stub::openai().await;
    let storage = Storage::new();
    let turn = line("Sam likes tea");
    let first = host(&storage, &embedded(&openai, "embed-a"));

    for fact in ["Sam likes tea at dawn.", "Sam likes tea at dusk."] {
        output(&ask(&first, "mem0.add", json!({"text": fact}), &turn).await);
    }

    drop(first);
    openai.answer(
        EMBEDDINGS,
        Answer::json(404, &json!({"error": "no such model"})),
    );

    let second = host(&storage, &embedded(&openai, "embed-b"));

    assert_eq!(
        health_saying(&second, &turn, "could not").await,
        (
            HealthStatus::Degraded,
            "Mem0 engine could not re-embed its memories for a new embedder (2 to go): the \
             embedder answered HTTP 404."
                .to_owned()
        )
    );

    health_saying(&second, &turn, "contacted on first capture or recall").await;

    assert_eq!(recall(&second, &turn).await.context_items.len(), 2);
}

#[tokio::test]
async fn an_extraction_with_no_memory_list_loses_the_capture_and_health_says_why() {
    let openai = Stub::openai().await;
    let storage = Storage::new();
    let host = host(&storage, &embedded(&openai, "embed-a"));
    let (turn, committed) = exchange("chat.1", "evt_1", "I like tea.", "Noted.");

    openai.answer(COMPLETIONS, Answer::completion("I cannot help with that."));
    capture(&host, &turn, &committed).await;

    let (status, summary) = health_saying(&host, &turn, "did not complete").await;

    assert_eq!(status, HealthStatus::Degraded);
    assert!(
        summary.starts_with(
            "1 capture(s) did not complete; most recent: mem0 add failed: the extraction \
             model's answer held no memory list."
        ),
        "{summary}"
    );
}

#[tokio::test]
async fn the_engine_writes_nothing_but_the_database_it_is_handed() {
    let openai = Stub::openai().await;
    let storage = Storage::new();
    let host = host(&storage, &embedded(&openai, "embed-a"));
    let (turn, committed) = exchange("chat.1", "evt_1", "I like tea.", "Noted.");

    openai.answer(COMPLETIONS, Answer::extraction(&["Sam likes tea."]));
    recall(&host, &turn).await;
    capture(&host, &turn, &committed).await;
    health_saying(&host, &turn, "Stored 1").await;
    output(&ask(&host, "mem0.add", json!({"text": "Sam likes cake."}), &turn).await);

    let files = storage.files_on_disk();

    assert!(
        files
            .iter()
            .all(|name| name.starts_with("mem0.memory.sqlite")),
        "{files:?}"
    );
    assert!(files.contains(&"mem0.memory.sqlite".to_owned()));
}
