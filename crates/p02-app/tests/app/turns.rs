//! Lines through a character's thread: the turn and what it says as it
//! goes, the ledger of submissions, the routing of a conversation to its
//! character, a turn the runtime fails, and a failure behind a turn.

use std::sync::{Arc, Mutex};

use p02_app::CharacterState::{Failed, Ready, Starting};
use p02_app::{Event, TurnOutcome};
use serde_json::json;

use crate::support::{
    Ear, Gate, Round, Toy, World, id, line, make_read_only, open, restore, said, settle, wire,
    write,
};

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

    assert_eq!(daemon.reconcile().await.starting, [id("mira")]);
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
    assert_eq!(
        wire(&daemon.running_turns()),
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
    assert_eq!(wire(&daemon.running_turns()), json!([]));
}

/// turns.fatal-turn-refuses-queued: A delivery queued behind a fatal turn is refused `character_unavailable` rather than run after the restart.
#[tokio::test(start_paused = true)]
async fn lines_queued_behind_a_fatal_turn_are_refused_and_she_restarts_once() {
    let world = World::new();
    let daemon = world.daemon(Vec::new()).await;

    daemon.reconcile().await;

    let conversation = open(&daemon).await;
    let log = world.log(&conversation, 1);
    let writable = Arc::new(Mutex::new(None));
    let gate = Arc::new(Gate::default());
    let mut ear = Ear::on(&daemon);
    let deliver = |text: &str, id: &str| {
        let daemon = daemon.clone();
        let line = line(&conversation, text, id);

        tokio::spawn(async move { daemon.deliver(line).await })
    };

    gate.shut();
    world.model.script([Round::says(&["Hi."]).held(&gate).then({
        let (log, writable) = (log.clone(), Arc::clone(&writable));

        move || *writable.lock().unwrap() = Some(make_read_only(&log))
    })]);

    let fatal = deliver("Hello there", "hello");

    gate.reached().await;

    let queued = [
        deliver("Are you there?", "there"),
        deliver("Hello?", "again"),
    ];

    settle().await;
    gate.open();

    let failed = fatal.await.unwrap();

    restore(&log, writable.lock().unwrap().take().unwrap());
    assert!(
        matches!(
            failed,
            TurnOutcome::Failed {
                committed: true,
                ..
            }
        ),
        "{failed:?}"
    );

    for refused in queued {
        let refused = wire(&refused.await.unwrap());

        assert_eq!(refused["status"], "refused");
        assert_eq!(refused["reason"], "character_unavailable");
    }

    ear.reached("mira", Ready).await;
    assert_eq!(ear.states("mira"), [Failed, Starting, Ready]);

    let next = daemon
        .deliver(line(&conversation, "Back again", "back"))
        .await;

    assert_eq!(said(&next), ["Back again", "Hello."]);
    assert_eq!(wire(&next)["conversationId"], conversation);
}

/// A line on a conversation this run never opened is routed by the store's
/// record of it: refused while its character is not running and completed
/// there once she is, under the same id; a conversation the home does not
/// hold is unknown, and one whose record cannot be read is said to be,
/// naming it.
#[tokio::test(start_paused = true)]
async fn a_conversation_this_run_never_opened_is_routed_by_its_record() {
    let world = World::new();
    let earlier = world.daemon(Vec::new()).await;

    earlier.reconcile().await;

    let conversation = open(&earlier).await;

    earlier
        .deliver(line(&conversation, "Before the restart.", "before"))
        .await;
    earlier.stop().await;

    let daemon = world.daemon(Vec::new()).await;
    let after = line(&conversation, "After the restart.", "after");
    let refused = wire(&daemon.deliver(after.clone()).await);

    assert_eq!(refused["reason"], "character_unavailable");
    assert_eq!(
        refused["message"],
        "Character \"mira\" has not been started."
    );
    assert_eq!(
        wire(
            &daemon
                .deliver(line("conv_missing", "Hello?", "missing"))
                .await
        ),
        json!({
            "status": "refused",
            "reason": "unknown_conversation",
            "message": "Conversation \"conv_missing\" does not exist.",
        })
    );

    daemon.reconcile().await;

    let completed = daemon.deliver(after).await;

    assert_eq!(said(&completed), ["After the restart.", "Hello."]);
    assert_eq!(wire(&completed)["conversationId"], conversation);
    daemon.stop().await;
    write(
        &world.path(&format!("conversations/{conversation}/conversation.json")),
        "not json",
    );

    let unreadable = wire(
        &world
            .daemon(Vec::new())
            .await
            .deliver(line(&conversation, "Hello?", "damaged"))
            .await,
    );

    assert_eq!(unreadable["reason"], "conversation_unreadable");
    assert!(
        unreadable["message"]
            .as_str()
            .unwrap()
            .contains(&conversation),
        "{unreadable}"
    );
}

/// One turn per submission: a repeat while the turn runs and one after it
/// get its outcome, the model asked once; the same id with another line is
/// refused, and a new id runs a new turn.
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
        wire(
            &daemon
                .deliver(line(&conversation, "Something else", "hello"))
                .await
        ),
        json!({
            "status": "refused",
            "reason": "invalid_message",
            "message": "clientMessageId \"hello\" was already used for a different message on \
                        this conversation; give each message its own.",
        })
    );
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

/// A segment rotation that fails behind a completed turn leaves the turn
/// completed and her ready, and is told on the stream and in her summary,
/// which a stop and a start clear.
#[tokio::test(start_paused = true)]
async fn a_rotation_that_fails_is_maintenance_a_stop_and_a_start_clear() {
    let world = World::new();

    world.settings(json!({"project02": {"contextWindowTokens": 80}}));

    let daemon = world.daemon(Vec::new()).await;

    daemon.reconcile().await;

    let conversation = open(&daemon).await;
    let say = |n: u32| {
        world.model.script([Round::says(&[&format!("Reply {n}.")])]);
        daemon.deliver(line(
            &conversation,
            &format!("Line {n}."),
            &format!("line-{n}"),
        ))
    };

    say(1).await;
    say(2).await;

    let data = world.path("character-data/mira");
    let catalog = data.join("sessions.jsonl");
    let mut ear = Ear::on(&daemon);
    // A rename replaces a read-only file on Unix, where the folder that
    // holds the catalog decides; Windows refuses to replace one.
    let catalog_writable = make_read_only(&catalog);
    let data_writable = make_read_only(&data);
    let third = say(3).await;

    restore(&data, data_writable);
    restore(&catalog, catalog_writable);

    let failure = ear
        .until(|event| matches!(event, Event::MaintenanceFailed { .. }))
        .await;
    let summary = &wire(&daemon.health().await)["characters"][0];

    let failure = wire(&failure);

    assert_eq!(said(&third), ["Line 3.", "Reply 3."]);
    assert_eq!(summary["state"], "ready");
    assert_eq!(
        summary["maintenance"],
        json!({"at": failure["at"], "message": failure["message"]})
    );
    assert!(
        failure["message"]
            .as_str()
            .unwrap()
            .contains("could not write"),
        "{failure}"
    );
    assert_eq!(ear.states("mira"), []);

    world.settings(json!({"project02": {"enabled": false, "contextWindowTokens": 80}}));
    daemon.settings_changed();
    daemon.reconcile().await;
    world.settings(json!({"project02": {"contextWindowTokens": 80}}));
    daemon.settings_changed();
    daemon.reconcile().await;

    let summary = &wire(&daemon.health().await)["characters"][0];

    assert_eq!(summary["state"], "ready");
    assert_eq!(summary.get("maintenance"), None);
}
