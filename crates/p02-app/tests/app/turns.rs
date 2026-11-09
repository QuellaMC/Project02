//! Lines through a character's thread: the turn and what it says as it
//! goes, and a failure behind a turn.

use std::sync::Arc;

use p02_app::CharacterState::{Ready, Starting};
use p02_app::Event;
use serde_json::json;

use crate::support::{Ear, Gate, Round, Toy, World, line, open, told, wire};

/// A daemon on a home with the bundled Mira starts her on its first
/// reconcile; her thread opens as the same conversation every time, and a
/// line queued for her completes with the person's line and her reply,
/// said on the stream as the turn goes: the turn running with her draft as
/// it grows, whole each time, then its commit and the turn without it,
/// then its completion.
#[tokio::test(start_paused = true)]
async fn a_line_through_her_thread_completes_as_the_stream_tells() {
    let world = World::new();
    let daemon = world.daemon(Vec::new()).await;
    let mut ear = Ear::on(&daemon);

    daemon.reconcile().await;
    assert_eq!(ear.states("mira"), []);
    ear.reached("mira", Ready).await;
    assert_eq!(ear.states("mira"), [Starting, Ready]);
    assert_eq!(
        wire(&daemon.health().await)["characters"],
        json!([{"id": "mira", "displayName": "Mira", "enabled": true, "state": "ready"}])
    );

    let conversation = open(&daemon).await;
    let gate = Arc::new(Gate::default());

    assert_eq!(open(&daemon).await, conversation);
    gate.shut();
    world.model.script([Round::says(&["Hi, Sam."])
        .drafting(&["Hi, ", "Sam."])
        .held(&gate)]);

    let turn = tokio::spawn({
        let daemon = daemon.clone();
        let line = line(&conversation, "  Hello there ", "hello");

        async move { told(&daemon, line).await }
    });
    let running = |drafts| {
        json!({
            "characterId": "mira",
            "conversationId": conversation,
            "source": "web",
            "clientMessageId": "hello",
            "drafts": drafts,
        })
    };

    gate.reached().await;
    ear.drain();
    assert_eq!(
        wire(&ear.running().last()),
        running(json!([{"draftId": "1.0", "text": "Hi, Sam."}]))
    );
    gate.open();

    let delivered = turn.await.unwrap();

    ear.until(|event| matches!(event, Event::TurnCompleted { .. }))
        .await;

    let told: Vec<String> = ear
        .heard
        .iter()
        .filter_map(|event| match event {
            Event::TurnProgress { progress, .. } => {
                Some(wire(progress)["kind"].as_str().unwrap().to_owned())
            }
            Event::TurnRunning(_) | Event::TurnCompleted { .. } => {
                Some(wire(event)["kind"].as_str().unwrap().to_owned())
            }
            _ => None,
        })
        .collect();

    assert_eq!(delivered.said, ["Hello there", "Hi, Sam."]);
    assert_eq!(
        told,
        [
            "user_message",
            "turn_running",
            "turn_running",
            "turn_running",
            "visible_reply",
            "turn_running",
            "turn_completed"
        ]
    );
    assert_eq!(
        wire(&ear.running()),
        json!([
            running(json!([])),
            running(json!([{"draftId": "1.0", "text": "Hi, "}])),
            running(json!([{"draftId": "1.0", "text": "Hi, Sam."}])),
            running(json!([])),
        ])
    );
    assert_eq!(
        delivered.ended,
        json!({
            "kind": "turn_completed",
            "characterId": "mira",
            "conversationId": conversation,
            "source": "web",
            "clientMessageId": "hello",
            "status": "completed",
            "committed": true,
        })
    );
}

/// The plugins' work after a turn's commit that fails leaves the turn
/// completed and her ready, and is told on the stream and in her summary.
#[tokio::test(start_paused = true)]
async fn the_plugins_work_failing_after_a_turn_is_maintenance() {
    let world = World::new();
    let daemon = world
        .daemon(vec![Toy::new("diary").failing_after_turns().plugin()])
        .await;

    daemon.reconcile().await;

    let conversation = open(&daemon).await;
    let mut ear = Ear::on(&daemon);
    let turn = told(&daemon, line(&conversation, "Remember tea.", "tea")).await;
    let failure = wire(
        &ear.until(|event| matches!(event, Event::MaintenanceFailed { .. }))
            .await,
    );
    let summary = &wire(&daemon.health().await)["characters"][0];

    assert_eq!(turn.said, ["Remember tea.", "Hello."]);
    assert_eq!(
        failure["message"],
        "afterTurnCommitted plugin hook failed: The diary is full."
    );
    assert_eq!(summary["state"], "ready");
    assert_eq!(summary["maintenance"]["message"], failure["message"]);
}
