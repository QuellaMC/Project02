//! The character-state package over Mira's data: her state as each patch
//! leaves it, in her log and its checkpoint, and as the note before a turn
//! shows it.

use std::sync::Arc;
use std::time::Duration;

use p02_contracts::{
    CharacterStorage, FactoryInput, HookContext, StoreAccess, ToolCall, ToolCallId,
    ToolCallOutcome, ToolCallResult,
};
use p02_plugins::{BeforeCallOutcome, PluginHost, ToolCallReport};
use serde_json::{Map, Value, json};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::home::{MiraHome, bundled, delete, rewrite, text_of};
use crate::support::{call, id, tool, turn};

const PLUGIN: &str = "character-state";

fn state_host(home: &MiraHome) -> PluginHost {
    home.host(&[(PLUGIN, json!({}))])
}

async fn patch(host: &PluginHost, call_id: &str, input: Value) -> ToolCallReport {
    host.handle_tool_calls(vec![call(call_id, "character_state.patch", input)], &turn())
        .await
        .remove(0)
}

fn output(report: &ToolCallReport) -> &Value {
    match &report.result {
        ToolCallResult::Accepted { output } => output,
        ToolCallResult::Rejected { reason, message } => panic!("{reason}: {message}"),
    }
}

/// The runtime notes the plugin hands the next model call.
async fn notes(host: &PluginHost) -> Vec<String> {
    match host.before_role_model_call(&turn()).await {
        BeforeCallOutcome::Prepared(prepared) => prepared
            .runtime_notes
            .iter()
            .map(|note| note.text().to_owned())
            .collect(),
        BeforeCallOutcome::Rejected(rejection) => panic!("the turn was rejected: {rejection:?}"),
    }
}

fn state(mood: &str, energy: &str) -> Value {
    json!({
        "mood": mood,
        "energy": energy,
        "attention": "present",
        "currentActivity": "idle",
        "socialOrientation": "open",
    })
}

#[tokio::test]
async fn a_patch_lands_in_her_log_then_its_checkpoint_and_shows_in_the_next_note() {
    let home = MiraHome::new();
    let host = state_host(&home);
    let curious = patch(&host, "p1", json!({"mood": "curious"})).await;
    let unchanged = patch(&host, "p2", json!({"mood": "curious"})).await;
    let log = text_of(&home.plugin_file(PLUGIN, "events.jsonl")).unwrap();
    let checkpoint: Value =
        serde_json::from_str(&text_of(&home.plugin_file(PLUGIN, "checkpoint.json")).unwrap())
            .unwrap();

    assert_eq!(
        output(&curious),
        &json!({
            "status": "accepted",
            "current": state("curious", "medium"),
            "appliedChanges": [{"field": "mood", "before": "steady", "after": "curious"}],
        })
    );
    assert_eq!(
        output(&unchanged)["appliedChanges"],
        json!([]),
        "a patch that changes nothing says so"
    );
    assert_eq!(
        log.lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect::<Vec<Value>>(),
        [
            json!({
                "eventId": "evt_1",
                "callId": "p1",
                "input": {"mood": "curious"},
                "before": state("steady", "medium"),
                "after": state("curious", "medium"),
            }),
            json!({
                "eventId": "evt_1",
                "callId": "p2",
                "input": {"mood": "curious"},
                "before": state("curious", "medium"),
                "after": state("curious", "medium"),
            }),
        ]
    );
    assert_eq!(
        checkpoint,
        json!({
            "version": 1,
            "eventCount": 2,
            "storeRevision": 4,
            "current": {"current": state("curious", "medium")},
        }),
        "each patch's checkpoint lands after its line, the store's last write"
    );
    assert_eq!(
        notes(&host).await,
        [
            "How you are right now (your own inner state, not theirs): mood=curious; \
             energy=medium; attention=present; activity=idle; social=open"
        ]
    );
}

/// The host refuses any value the contract does not enumerate, so the
/// plugin's own judge is met only by a call made under a looser contract.
#[tokio::test]
async fn a_value_the_contract_admits_and_the_state_does_not_take_is_refused_writing_nothing() {
    let home = MiraHome::new();
    let (manifest, factory) = bundled(PLUGIN);
    let plugin = factory(&FactoryInput::new(manifest, &Map::new()).unwrap()).unwrap();
    let (context, _hold) = HookContext::new(
        id(PLUGIN),
        Arc::new(turn().identity().clone()),
        Instant::now() + Duration::from_secs(10),
        CancellationToken::new(),
    )
    .with_character_file_store(home.data().file_store(&id(PLUGIN)), StoreAccess::ReadWrite);
    let looser = ToolCall::new(
        ToolCallId::new("p1").unwrap(),
        &tool("character_state.patch"),
        json!({"mood": "angry"}).as_object().unwrap().clone(),
    )
    .unwrap();
    let outcome = plugin.handle_tool_call(&looser, &context).await.unwrap();

    assert!(
        matches!(
            &outcome,
            ToolCallOutcome::Rejected { reason, message, .. }
                if reason == "invalid_state_value"
                    && message == "character_state.patch field \"mood\" has unsupported value \"angry\"."
        ),
        "{outcome:?}"
    );
    assert_eq!(text_of(&home.plugin_file(PLUGIN, "events.jsonl")), None);
    assert_eq!(text_of(&home.plugin_file(PLUGIN, "checkpoint.json")), None);
}

/// A crash can leave a line twice, or a line the store committed after the
/// checkpoint it never got to write: either way her log is the truth.
#[tokio::test]
async fn a_checkpoint_gone_or_outgrown_is_folded_anew_from_her_log_a_repeated_line_counting_once() {
    let home = MiraHome::new();
    let host = state_host(&home);
    let events = home.plugin_file(PLUGIN, "events.jsonl");
    let checkpoint = home.plugin_file(PLUGIN, "checkpoint.json");

    patch(&host, "p1", json!({"mood": "curious"})).await;

    let line = text_of(&events).unwrap();

    rewrite(
        &events,
        &format!("{line}{}", line.replace("\"curious\"", "\"playful\"")),
    );
    delete(&checkpoint);

    assert!(notes(&host).await[0].contains("mood=curious; energy=medium"));
    assert_eq!(
        serde_json::from_str::<Value>(&text_of(&checkpoint).unwrap()).unwrap()["eventCount"],
        1,
        "the rebuilt checkpoint is written, the repeated line counted once"
    );

    let backend = home.data().file_store(&id(PLUGIN));
    let mut files = backend
        .lease(std::time::Instant::now() + Duration::from_secs(5))
        .unwrap();

    files
        .append_jsonl(
            "events.jsonl",
            &json!({
                "eventId": "evt_2",
                "callId": "p2",
                "input": {"energy": "high"},
                "before": state("curious", "medium"),
                "after": state("curious", "high"),
            }),
        )
        .unwrap();
    drop(files);

    assert!(notes(&host).await[0].contains("mood=curious; energy=high"));
}

#[tokio::test]
async fn a_checkpoint_of_another_version_fails_the_turn_closed_and_is_left_as_it_is() {
    let home = MiraHome::new();
    let host = state_host(&home);
    let checkpoint = home.plugin_file(PLUGIN, "checkpoint.json");

    patch(&host, "p1", json!({"mood": "curious"})).await;

    let mut newer: Value = serde_json::from_str(&text_of(&checkpoint).unwrap()).unwrap();

    newer["version"] = json!(2);
    rewrite(&checkpoint, &newer.to_string());

    let BeforeCallOutcome::Rejected(rejection) = host.before_role_model_call(&turn()).await else {
        panic!("a checkpoint it does not read rejects the turn");
    };

    assert_eq!(rejection.reason(), "plugin_before_role_model_call_rejected");
    assert_eq!(
        rejection.message,
        "Character State checkpoint.json is of a version this build does not read, so it is \
         left as it is."
    );
    assert_eq!(text_of(&checkpoint), Some(newer.to_string()));
}
