//! The session-history package through the host: its index, its search
//! and its read, over a character's session history.

use p02_contracts::{CommittedTurn, ContextItemKind, ResolvedConfig, ToolCallResult};
use p02_core::{Timestamp, VisibleMessageRole};
use p02_plugins::{BeforeCallOutcome, PluginHost, ToolCallReport, Turn, session_history};
use serde_json::{Value, json};
use std::sync::Arc;

use crate::storage::Storage;
use crate::support::{Enable, Gate, Scripted, Spec, bundled_manifest, call, turn, turn_in};

const INDEX: &str = "session-index";

/// A host of session-history alone, under a budget of `timeout_ms`.
fn history_host(storage: &Arc<Storage>, timeout_ms: u64) -> PluginHost {
    PluginHost::builder(Arc::clone(storage) as _)
        .plugin(
            bundled_manifest("session-history", |manifest| {
                manifest["runtimePolicy"]["timeoutMs"] = json!(timeout_ms);
            }),
            ResolvedConfig::default(),
            session_history::create,
        )
        .activate()
        .unwrap()
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

fn refused(report: &ToolCallReport) -> (&str, &str) {
    match &report.result {
        ToolCallResult::Rejected { reason, message } => (reason, message),
        ToolCallResult::Accepted { output } => panic!("answered {output}"),
    }
}

/// The sessions a search found, sorted.
fn found(output: &Value) -> Vec<&str> {
    let mut sessions: Vec<&str> = output["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|view| view["sessionId"].as_str().unwrap())
        .collect();

    sessions.sort_unstable();
    sessions
}

fn matched(view: &Value) -> &Value {
    view["aroundMatch"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["matched"] == json!(true))
        .unwrap()
}

/// The numbers of the messages listed, `chat.1:message-13` being 13.
fn numbers(messages: &Value) -> Vec<u64> {
    messages
        .as_array()
        .unwrap()
        .iter()
        .map(|message| {
            let id = message["messageId"].as_str().unwrap();

            id.rsplit_once(":message-").unwrap().1.parse().unwrap()
        })
        .collect()
}

fn committed() -> CommittedTurn {
    CommittedTurn::new(Timestamp::new("2026-10-18T01:00:00.000Z").unwrap())
}

#[tokio::test]
async fn a_search_finds_what_the_model_cannot_see_by_routed_literal_queries() {
    let storage = Storage::new();
    let history = &storage.history;
    let long = format!("{} anchovy pizza {}", "a".repeat(300), "b".repeat(300));

    history.exchange(
        "chat.1",
        "The kraken surfaced near the pier.",
        "The kraken waved.",
    );
    history.exchange("chat.2", "Echoed kraken phrase.", "Echoed kraken phrase.");
    history.exchange("chat.3", "我们讨论了插件权限设计吗？", "讨论过。");
    history.exchange("chat.4", "Привет, как дела?", "Хорошо!");
    history.exchange("chat.5", &long, "Noted.");
    history.say(
        "chat.6",
        VisibleMessageRole::User,
        "My locker code is zephyr77.",
    );
    history.say(
        "chat.6",
        VisibleMessageRole::User,
        "Is zephyr77 still my code?",
    );
    history.say(
        "chat.6",
        VisibleMessageRole::Character,
        "One moment, the phrase is glimmerwing.",
    );

    // What the model sees now: the person's line and its own interim reply.
    let now = turn_in("chat.6", "evt_6", &["chat.6:message-2", "chat.6:message-3"]);
    let host = history_host(&storage, 5_000);
    let queries = [
        "kraken",
        "插件权限",
        "su",
        "ПР",
        "\"kraken\" OR pier*",
        "zephyr77",
        "glimmerwing",
        "anchovy",
    ];
    let reports = host
        .handle_tool_calls(
            queries
                .iter()
                .map(|query| call("c1", "sessions.search", json!({"query": query})))
                .collect(),
            &now,
        )
        .await;
    let results: Vec<&Value> = reports.iter().map(output).collect();

    assert_eq!(
        results
            .iter()
            .map(|result| found(result))
            .collect::<Vec<_>>(),
        [
            vec!["chat.1", "chat.2"],
            vec!["chat.3"],
            vec!["chat.1"],
            vec!["chat.4"],
            vec![],
            vec!["chat.6"],
            vec![],
            vec!["chat.5"],
        ]
    );
    assert_eq!(results[0]["totalSessionsWithHits"], json!(2));

    let echoed = results[0]["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|view| view["sessionId"] == json!("chat.2"))
        .unwrap();

    assert_eq!(
        matched(echoed)["messageId"],
        json!("chat.2:message-2"),
        "the newest of equal hits"
    );
    assert_eq!(
        matched(&results[5]["sessions"][0])["text"],
        json!("My locker code is zephyr77.")
    );

    let pizza = matched(&results[7]["sessions"][0]);
    let text = pizza["text"].as_str().unwrap();
    let snippet = pizza["snippet"].as_str().unwrap();
    let at = snippet.find("anchovy").unwrap();

    assert_eq!(text.chars().count(), 200);
    assert!(text.ends_with("..."));
    assert_eq!(snippet.chars().count(), 160);
    assert!(
        snippet.starts_with("...a") && snippet.ends_with("b..."),
        "{snippet}"
    );
    assert!(snippet.contains("a anchovy pizza b"), "{snippet}");
    assert!(at.abs_diff(80) < 10, "{snippet}");
}

#[tokio::test]
async fn a_read_scrolls_a_session_by_anchor_and_says_what_it_could_not_find() {
    let storage = Storage::new();
    let history = &storage.history;
    let story = "A very long story. ".repeat(3_700);

    for turn in 0..10 {
        let line = if turn == 6 {
            "Where did we put the anchovy pizza?".to_owned()
        } else {
            format!("Filler question {turn}.")
        };

        history.exchange("chat.1", &line, &format!("Filler answer {turn}."));
    }

    history.exchange("chat.1", "Tell me a story.", &story);
    history.damage("chat.1");
    history.damage_catalog();

    let now = turn_in("chat.2", "evt_2", &[]);
    let host = history_host(&storage, 5_000);
    let view = ask(&host, "sessions.search", json!({"query": "anchovy"}), &now).await;
    let view = &output(&view)["sessions"][0];
    let around = ask(
        &host,
        "sessions.read",
        json!({"sessionId": "chat.1", "anchorMessageId": "chat.1:message-13", "window": 2}),
        &now,
    )
    .await;
    let latest = ask(&host, "sessions.read", json!({"sessionId": "chat.1"}), &now).await;
    let unknown = ask(&host, "sessions.read", json!({"sessionId": "nope"}), &now).await;
    let unanchored = ask(
        &host,
        "sessions.read",
        json!({"sessionId": "chat.1", "anchorMessageId": "chat.1:message-99"}),
        &now,
    )
    .await;

    assert_eq!(
        [
            numbers(&view["conversationStart"]),
            numbers(&view["aroundMatch"]),
            numbers(&view["conversationEnd"]),
        ],
        [vec![1, 2], vec![10, 11, 12, 13, 14, 15, 16], vec![21, 22]]
    );
    assert_eq!(numbers(&output(&around)["messages"]), [11, 12, 13, 14, 15]);
    assert_eq!(
        (
            &output(&around)["hasBefore"],
            &output(&around)["hasAfter"],
            &output(&around)["damagedRecordsSkipped"],
        ),
        (&json!(true), &json!(true), &json!(2))
    );
    assert_eq!(
        numbers(&output(&latest)["messages"]),
        [15, 16, 17, 18, 19, 20, 21, 22]
    );
    assert_eq!(
        (&output(&latest)["hasBefore"], &output(&latest)["hasAfter"]),
        (&json!(true), &json!(false))
    );
    assert_eq!(
        output(&latest)["messages"][7]["text"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        400
    );
    assert_eq!(
        refused(&unknown),
        (
            "session_not_found",
            "Session \"nope\" is not in this character's history."
        )
    );
    assert_eq!(
        refused(&unanchored),
        (
            "message_not_found",
            "Message \"chat.1:message-99\" is not in session \"chat.1\"."
        )
    );

    let hidden = "/home/someone/.project02/character-data/mira/sessions/chat.1/raw-events.jsonl";

    history.fail(&format!("permission denied: {hidden}"));

    let failed = ask(&host, "sessions.read", json!({"sessionId": "chat.1"}), &now).await;
    let seen = serde_json::to_string(&(&failed.result, &failed.evidence)).unwrap();

    assert_eq!(refused(&failed).0, "session_history_read_failed");
    assert!(!seen.contains("/home/someone"), "{seen}");
}

#[tokio::test]
async fn with_session_history_on_the_trusted_notes_carry_its_recall_guidance() {
    let storage = Storage::new();
    let guided = history_host(&storage, 5_000)
        .before_role_model_call(&turn())
        .await;
    let unguided = PluginHost::builder(Storage::new())
        .enable(
            &Spec::new("other"),
            Arc::new(Scripted::answering(ContextItemKind::RuntimeNote, 1)),
        )
        .activate()
        .unwrap()
        .before_role_model_call(&turn())
        .await;
    let guidance = |outcome: &BeforeCallOutcome| match outcome {
        BeforeCallOutcome::Prepared(prepared) => prepared
            .runtime_notes
            .iter()
            .any(|note| note.text().contains("sessions.search")),
        BeforeCallOutcome::Rejected(rejection) => panic!("rejected: {rejection:?}"),
    };

    assert!(guidance(&guided));
    assert!(!guidance(&unguided));
}

#[tokio::test]
async fn the_index_holds_what_the_history_committed_and_is_rebuilt_from_it() {
    let storage = Storage::new();
    let opener = storage.opener("session-history");
    let kraken = async |host: &PluginHost| {
        let elsewhere = turn_in("chat.9", "evt_9", &[]);
        let report = ask(
            host,
            "sessions.search",
            json!({"query": "kraken"}),
            &elsewhere,
        )
        .await;

        found(output(&report))
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };

    storage
        .history
        .exchange("chat.1", "The kraken surfaced.", "Noted.");

    let host = history_host(&storage, 5_000);
    let indexed = host.after_turn_committed(&turn(), &committed()).await;

    assert_eq!(
        indexed.evidence[0].summary(),
        "Caught the session index up to the committed turn."
    );
    assert_eq!(opener.opened(), 1, "the index opened once, and stays open");
    assert_eq!(kraken(&host).await, ["chat.1"]);
    assert_eq!(opener.opened(), 1);

    storage
        .history
        .exchange("chat.2", "The kraken dove.", "Gone.");
    storage.history.shrink("chat.1", 0);
    assert_eq!(
        kraken(&host).await,
        ["chat.2"],
        "a log that shrank is read again from its start"
    );
    drop(host);

    let version = opener.version(INDEX);

    opener.stamp_version(INDEX, 99);
    assert_eq!(kraken(&history_host(&storage, 5_000)).await, ["chat.2"]);
    assert_eq!(
        opener.version(INDEX),
        version,
        "rebuilt at the plugin's version"
    );

    opener.corrupt(INDEX);
    assert_eq!(kraken(&history_host(&storage, 5_000)).await, ["chat.2"]);
    assert_eq!(opener.version(INDEX), version);

    let off = Storage::new();
    let without = PluginHost::builder(Arc::clone(&off) as _)
        .enable(
            &Spec {
                declared: json!(["after_turn_committed"]),
                ..Spec::new("other")
            },
            Arc::new(Scripted::default()),
        )
        .activate()
        .unwrap();

    off.history
        .exchange("chat.1", "The kraken surfaced.", "Noted.");
    without.after_turn_committed(&turn(), &committed()).await;
    assert_eq!(
        off.opener("session-history").opened(),
        0,
        "with the plugin off, nothing is kept"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_catch_up_stopped_with_its_hook_goes_on_where_it_stopped() {
    let storage = Storage::new();
    let gate = Arc::new(Gate::default());

    for line in ["One.", "Two.", "Three.", "Four.", "Five."] {
        storage
            .history
            .say("chat.1", VisibleMessageRole::User, line);
    }

    storage
        .history
        .say("chat.1", VisibleMessageRole::Character, "A dolphin!");
    storage.history.serve_at_most(1);
    storage.history.hold_after(2, Arc::clone(&gate));

    let host = history_host(&storage, 500);
    let dolphin = json!({"query": "dolphin"});
    let stopped = ask(&host, "sessions.search", dolphin.clone(), &turn()).await;

    assert_eq!(refused(&stopped).0, "handler_timeout");

    gate.open();

    let resumed = ask(
        &host,
        "sessions.search",
        dolphin,
        &turn_in("chat.2", "evt_2", &[]),
    )
    .await;

    assert_eq!(found(output(&resumed)), ["chat.1"]);
    assert_eq!(
        storage
            .history
            .reads()
            .iter()
            .map(|(_, cursor)| cursor.as_deref())
            .collect::<Vec<_>>(),
        [
            None,
            Some("1"),
            Some("2"),
            Some("3"),
            Some("4"),
            Some("5"),
            Some("6")
        ],
        "each slice read once, from where the last one ended"
    );
}

#[tokio::test]
async fn a_search_at_full_fan_out_over_four_byte_text_stays_inside_the_json_limits() {
    let storage = Storage::new();
    let wide = "\u{1f600}".repeat(300);
    let speaker = "\u{1f600}".repeat(100);

    for session in 1..=5 {
        let session = format!("chat.{session}");

        for at in 0..11 {
            let text = if at == 5 {
                format!("needle {wide}")
            } else {
                wide.clone()
            };

            storage
                .history
                .say_as(&session, VisibleMessageRole::User, &speaker, &text);
        }
    }

    let host = history_host(&storage, 5_000);
    let report = ask(
        &host,
        "sessions.search",
        json!({"query": "needle", "sessionLimit": 5}),
        &turn_in("chat.9", "evt_9", &[]),
    )
    .await;
    let views = output(&report)["sessions"].as_array().unwrap();

    assert_eq!(views.len(), 5);
    assert!(
        views
            .iter()
            .all(|view| view["aroundMatch"].as_array().unwrap().len() == 7)
    );
}
