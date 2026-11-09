//! The character-state package over Mira's data: the checkpoint her log
//! stands behind, and the note before a turn that shows it.

use std::time::Duration;

use p02_contracts::CharacterStorage;
use p02_plugins::{BeforeCallOutcome, PluginHost, ToolCallReport};
use serde_json::{Value, json};

use crate::home::{MiraHome, delete, rewrite, text_of};
use crate::support::{call, id, run_round, turn};

const PLUGIN: &str = "character-state";

fn state_host(home: &MiraHome) -> PluginHost {
    home.host(&[(PLUGIN, json!({}))])
}

async fn patch(host: &PluginHost, call_id: &str, input: Value) -> ToolCallReport {
    run_round(
        host,
        vec![call(call_id, "character_state.patch", input)],
        &turn(),
    )
    .await
    .remove(0)
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

/// A crash can leave a line the store committed after the checkpoint it
/// never got to write: her log is the truth.
#[tokio::test]
async fn a_checkpoint_gone_or_outgrown_is_folded_anew_from_her_log() {
    let home = MiraHome::new();
    let host = state_host(&home);
    let checkpoint = home.plugin_file(PLUGIN, "checkpoint.json");

    patch(&host, "p1", json!({"mood": "curious"})).await;
    delete(&checkpoint);

    assert!(notes(&host).await[0].contains("mood=curious; energy=medium"));
    assert!(
        text_of(&checkpoint).is_some(),
        "the rebuilt checkpoint is written"
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
