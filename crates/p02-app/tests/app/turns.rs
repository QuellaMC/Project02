//! Lines through a character's thread: the turn and what it says as it
//! goes, the ledger of submissions, the routing of a conversation to its
//! character, a turn the runtime fails, and a failure behind a turn.

use std::sync::Arc;

use p02_app::CharacterState::{Ready, Starting};
use p02_app::Event;
use serde_json::json;

use crate::support::{Ear, Gate, Round, Toy, World, line, open, said, settle, wire};

/// A daemon on a home with the bundled Mira starts her on its first
/// reconcile; her thread opens as the same conversation every time, and a
/// line through it completes with the person's line and her reply, said
/// on the stream as the turn goes, the turn running with its draft until
/// it completes.
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

        async move { daemon.deliver(line).await }
    });

    gate.reached().await;
    ear.drain();
    assert_eq!(
        wire(&ear.running()),
        json!([{
            "characterId": "mira",
            "conversationId": conversation,
            "source": "web",
            "clientMessageId": "hello",
            "drafts": [{"draftId": "1.0", "text": "Hi, Sam."}],
        }])
    );
    gate.open();

    let delivered = turn.await.unwrap();
    let completed = ear
        .until(|event| matches!(event, Event::TurnCompleted { .. }))
        .await;
    let progress: Vec<String> = ear
        .heard
        .iter()
        .filter_map(|event| match event {
            Event::TurnProgress { progress, .. } => {
                Some(wire(progress)["kind"].as_str().unwrap().to_owned())
            }
            _ => None,
        })
        .collect();

    assert_eq!(said(&delivered), ["Hello there", "Hi, Sam."]);
    assert_eq!(
        progress,
        [
            "user_message",
            "reply_delta",
            "reply_delta",
            "visible_reply"
        ]
    );
    assert_eq!(
        wire(&completed),
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
    assert_eq!(wire(&ear.running()), json!([]));
}

/// One turn per submission: a repeat while the turn runs and one after it
/// get its outcome, the model asked once, and a new id runs a new turn.
#[tokio::test(start_paused = true)]
async fn a_repeated_submission_gets_its_turns_outcome_and_runs_nothing() {
    let world = World::new();
    let daemon = world.daemon(Vec::new()).await;

    daemon.reconcile().await;

    let conversation = open(&daemon).await;
    let gate = Arc::new(Gate::default());
    let deliver = |text: &str, id: &str| {
        let daemon = daemon.clone();
        let line = line(&conversation, text, id);

        tokio::spawn(async move { daemon.deliver(line).await })
    };

    gate.shut();
    world.model.script([Round::says(&["Hi."]).held(&gate)]);

    let first = deliver("Hello there", "hello");

    gate.reached().await;

    let joined = deliver("Hello there", "hello");

    settle().await;
    gate.open();

    let outcome = wire(&first.await.unwrap());

    assert_eq!(wire(&joined.await.unwrap()), outcome);
    assert_eq!(
        wire(
            &daemon
                .deliver(line(&conversation, "Hello there", "hello"))
                .await
        ),
        outcome
    );
    assert_eq!(world.model.asked(), 1);
    assert_eq!(
        said(
            &daemon
                .deliver(line(&conversation, "Hello there", "again"))
                .await
        ),
        ["Hello there", "Hello."]
    );
    assert_eq!(world.model.asked(), 2);
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
    let outcome = daemon
        .deliver(line(&conversation, "Remember tea.", "tea"))
        .await;
    let failure = wire(
        &ear.until(|event| matches!(event, Event::MaintenanceFailed { .. }))
            .await,
    );
    let summary = &wire(&daemon.health().await)["characters"][0];

    assert_eq!(said(&outcome), ["Remember tea.", "Hello."]);
    assert_eq!(
        failure["message"],
        "afterTurnCommitted plugin hook failed: The diary is full."
    );
    assert_eq!(summary["state"], "ready");
    assert_eq!(summary["maintenance"]["message"], failure["message"]);
}
