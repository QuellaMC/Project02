//! The character-memory package over Mira's data: the batches that change
//! her two notebooks, whole or not at all, and what her trusted frame shows
//! of them.

use std::num::NonZeroU32;

use p02_contracts::{CuratedSection, ToolCallResult};
use p02_plugins::{BeforeCallOutcome, PluginHost, ToolCallReport, Turn};
use serde_json::{Value, json};

use crate::home::{MiraHome, text_of};
use crate::support::{call, id, turn, turn_in};

const PLUGIN: &str = "character-memory";

fn memory_host(home: &MiraHome) -> PluginHost {
    home.host(&[(PLUGIN, json!({}))])
}

async fn update(host: &PluginHost, operations: Value) -> ToolCallReport {
    host.handle_tool_calls(
        vec![call(
            "m1",
            "memory.update",
            json!({"operations": operations}),
        )],
        &turn(),
    )
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
        ToolCallResult::Accepted { output } => panic!("accepted {output}"),
    }
}

fn add(target: &str, text: &str) -> Value {
    json!({"action": "add", "target": target, "text": text})
}

fn stored(home: &MiraHome) -> Option<Value> {
    text_of(&home.plugin_file(PLUGIN, "memory.json"))
        .map(|text| serde_json::from_str(&text).unwrap())
}

fn usage(notes: (usize, usize), profile: (usize, usize)) -> Value {
    json!({
        "notes": {"usedChars": notes.0, "capChars": 2200, "entryCount": notes.1},
        "user_profile": {"usedChars": profile.0, "capChars": 1375, "entryCount": profile.1},
    })
}

async fn sections(host: &PluginHost, turn: &Turn) -> Vec<CuratedSection> {
    match host.before_role_model_call(turn).await {
        BeforeCallOutcome::Prepared(prepared) => prepared
            .curated_sections
            .iter()
            .map(|section| section.section().clone())
            .collect(),
        BeforeCallOutcome::Rejected(rejection) => panic!("the turn was rejected: {rejection:?}"),
    }
}

#[tokio::test]
async fn a_batch_applies_whole_saying_what_each_change_came_to_and_how_full_each_notebook_is() {
    let home = MiraHome::new();
    let host = memory_host(&home);
    let first = update(
        &host,
        json!([
            add("notes", "Likes green tea."),
            add("notes", "  Likes black tea. "),
            add("user_profile", "Is called Sam."),
        ]),
    )
    .await;
    let second = update(
        &host,
        json!([
            add("notes", "Likes green tea."),
            {"action": "replace", "target": "notes", "old_text": "black", "text": "Likes oolong."},
            {"action": "remove", "target": "user_profile", "old_text": "Sam"},
        ]),
    )
    .await;
    let collapsed = update(
        &host,
        json!([{
            "action": "replace",
            "target": "notes",
            "old_text": "oolong",
            "text": "Likes green tea.",
        }]),
    )
    .await;
    let change = |action: &str, target: &str, status: &str| json!({"action": action, "target": target, "status": status});

    assert_eq!(
        output(&first),
        &json!({
            "status": "accepted",
            "appliedChanges": [
                change("add", "notes", "applied"),
                change("add", "notes", "applied"),
                change("add", "user_profile", "applied"),
            ],
            "usage": usage((35, 2), (14, 1)),
            "visibleNextSession": true,
        }),
        "an entry is kept trimmed"
    );
    assert_eq!(
        output(&second)["appliedChanges"],
        json!([
            change("add", "notes", "duplicate"),
            change("replace", "notes", "applied"),
            change("remove", "user_profile", "applied"),
        ])
    );
    assert_eq!(output(&second)["usage"], usage((32, 2), (0, 0)));
    assert_eq!(
        output(&collapsed)["appliedChanges"],
        json!([change("replace", "notes", "duplicate")]),
        "a replace onto another entry's text collapses the two"
    );
    assert_eq!(
        stored(&home),
        Some(json!({"version": 1, "notes": ["Likes green tea."], "userProfile": []}))
    );
}

#[tokio::test]
async fn a_failing_batch_changes_nothing_and_says_why_repeating_no_entry() {
    let home = MiraHome::new();
    let host = memory_host(&home);

    update(
        &host,
        json!([
            add("notes", "Likes green tea."),
            add("notes", "Likes black tea.")
        ]),
    )
    .await;

    let kept = stored(&home);
    let missing = update(
        &host,
        json!([
            add("notes", "Plays chess."),
            {"action": "remove", "target": "notes", "old_text": "coffee"},
        ]),
    )
    .await;
    let ambiguous = update(
        &host,
        json!([
            add("notes", "Plays go."),
            {"action": "replace", "target": "notes", "old_text": "Likes", "text": "Hm."},
        ]),
    )
    .await;
    let controlled = update(&host, json!([add("notes", "A bell \u{7}.")])).await;

    assert_eq!(
        refused(&missing),
        (
            "memory_old_text_not_found",
            "No notes entry contains the given old_text."
        )
    );
    assert_eq!(
        refused(&ambiguous),
        (
            "memory_old_text_ambiguous",
            "old_text selects 2 notes entries; use a longer unique substring."
        )
    );
    assert_eq!(
        refused(&controlled),
        (
            "memory_entry_invalid",
            "notes entry text must be non-empty and free of control characters."
        )
    );
    assert_eq!(stored(&home), kept);
}

#[tokio::test]
async fn a_batch_past_a_notebooks_rendered_capacity_or_its_entry_limit_is_refused() {
    let home = MiraHome::new();
    let host = memory_host(&home);
    let (long, longer) = ("a".repeat(1_100), "b".repeat(1_097));
    let full = update(&host, json!([add("notes", &long), add("notes", &longer)])).await;
    let over = update(&host, json!([add("notes", "c")])).await;
    let profile = update(&host, json!([add("user_profile", &"d".repeat(1_376))])).await;

    assert_eq!(output(&full)["usage"]["notes"]["usedChars"], 2_200);
    assert_eq!(
        refused(&over),
        (
            "memory_capacity_exceeded",
            "notes would hold 2204/2200 chars; compress or remove entries first."
        )
    );
    assert_eq!(
        refused(&profile),
        (
            "memory_capacity_exceeded",
            "user_profile would hold 1376/1375 chars; compress or remove entries first."
        )
    );

    let crowded = MiraHome::new();
    let many = memory_host(&crowded);
    let entries: Vec<Value> = (0..256)
        .map(|entry| add("notes", &entry.to_string()))
        .collect();

    for batch in entries.chunks(8) {
        output(&update(&many, Value::from(batch.to_vec())).await);
    }

    assert_eq!(
        refused(&update(&many, json!([add("notes", "256")])).await),
        (
            "memory_capacity_exceeded",
            "notes would hold 257/256 entries; merge or remove entries first."
        ),
        "the document the store writes holds no more entries"
    );
}

#[tokio::test]
async fn her_frame_shows_her_notebooks_as_they_were_when_her_session_began_and_no_empty_one() {
    let home = MiraHome::new();
    let host = memory_host(&home);

    assert_eq!(sections(&host, &turn()).await, []);

    update(&host, json!([add("notes", "Likes tea.")])).await;

    assert_eq!(
        sections(&host, &turn_in("chat.1", "evt_2", &[])).await,
        [],
        "a write shows only from the next session"
    );
    assert_eq!(
        sections(&host, &turn_in("chat.2", "evt_3", &[])).await,
        [
            CuratedSection::new(id("notes"), "Notes to yourself", "Likes tea.").with_usage(
                NonZeroU32::new(10).unwrap(),
                NonZeroU32::new(2_200).unwrap()
            )
        ]
    );
}
