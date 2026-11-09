//! A character's life: her start, what the settings make of her, her
//! being built again, her stop, and what overtakes what.

use std::sync::Arc;

use p02_shared::{PathEntry, describe_entry};
use p02_wire::CharacterState::{Failed, Ready, Starting, Stopped, Stopping};
use p02_wire::{Event, OpenOutcome, RosterState, StartOutcome};
use serde_json::json;

use crate::support::{
    Ear, Gate, Round, Toy, World, a_while, begun, change, home, line, open, settle, told, wire,
};

const NO_PROVIDER: &str = "No model provider is chosen. Choose one on the settings page.";

/// Until a model provider is chosen every enabled character fails saying
/// so, and her thread is refused with that sentence; once a change chooses
/// one, the next reconcile starts her.
#[tokio::test(start_paused = true)]
async fn without_a_provider_every_character_fails_until_one_is_chosen() {
    let world = World::new();

    world.package("nova", "Nova");

    let daemon = world.daemon_answering(None, Vec::new()).await;

    daemon.reconcile().await;

    let health = wire(&daemon.health().await);

    assert_eq!(
        health["characters"],
        json!([
            {"id": "mira", "displayName": "Mira", "enabled": true, "state": "failed", "diagnostic": NO_PROVIDER},
            {"id": "nova", "displayName": "Nova", "enabled": true, "state": "failed", "diagnostic": NO_PROVIDER},
        ])
    );

    let OpenOutcome::Refused { reason, message } = daemon.open_conversation("mira").await else {
        panic!("her thread is refused");
    };

    assert_eq!(wire(&reason), "character_unavailable");
    assert!(message.contains(NO_PROVIDER), "{message}");

    change(
        &daemon,
        home(),
        json!({"kind": "set", "path": "project02.roleModelProvider", "value": "nvidia"}),
    )
    .await;
    daemon.reconcile().await;

    let states: Vec<_> = wire(&daemon.health().await)["characters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|character| character["state"].clone())
        .collect();

    assert_eq!(states, [json!("ready"), json!("ready")]);
}

/// A character switched off is not started and has nothing written for
/// her, and switched on, the next reconcile starts her; switched off while
/// she runs, she stops, her parked confirmation settled at once.
#[tokio::test(start_paused = true)]
async fn the_switch_decides_who_runs_and_switching_her_off_stops_her() {
    let world = World::new();

    world.settings(json!({"project02": {"enabled": false}}));

    let daemon = world
        .daemon(vec![Toy::new("notes").asking("notes.save").plugin()])
        .await;

    daemon.reconcile().await;
    assert_eq!(
        wire(&daemon.health().await)["characters"][0],
        json!({"id": "mira", "displayName": "Mira", "enabled": false, "state": "not_started"})
    );
    assert!(matches!(
        describe_entry(&world.path("character-data")),
        PathEntry::Absent
    ));

    change(
        &daemon,
        home(),
        json!({"kind": "unset", "path": "project02.enabled"}),
    )
    .await;
    daemon.reconcile().await;
    assert_eq!(
        wire(&daemon.health().await)["characters"][0]["state"],
        "ready"
    );

    let conversation = open(&daemon).await;
    let mut ear = Ear::on(&daemon);

    world
        .model
        .script([Round::calls("notes.save", &json!({"note": "Tea at five."}))]);

    let turn = tokio::spawn({
        let daemon = daemon.clone();

        async move { told(&daemon, line(&conversation, "Remember tea.", "tea")).await }
    });

    ear.until(|event| matches!(event, Event::ConfirmationRequested(_)))
        .await;
    change(
        &daemon,
        home(),
        json!({"kind": "set", "path": "project02.enabled", "value": false}),
    )
    .await;

    daemon.reconcile().await;

    let settled = ear
        .until(|event| matches!(event, Event::ConfirmationSettled { .. }))
        .await;

    assert_eq!(wire(&settled)["decision"], "cancelled");
    assert_eq!(wire(&settled)["reason"], "stopped");
    assert!(daemon.pending_confirmations().is_empty());
    assert_eq!(turn.await.unwrap().ended["status"], "completed");
    assert_eq!(
        wire(&daemon.health().await)["characters"][0]["state"],
        "stopped"
    );
}

/// A pass judges the characters running when it was asked for: a client's
/// start of a character switched off, while the pass runs, is the
/// client's, and fails her saying she is switched off.
#[tokio::test]
async fn a_pass_judges_only_the_characters_running_when_it_was_asked_for() {
    let world = World::new();

    world.settings(json!({"project02": {"enabled": false}}));

    let daemon = world.daemon(Vec::new()).await;
    let pass = daemon.reconcile();
    let StartOutcome::Settled { character } = daemon.start_character("mira").await else {
        panic!("her start runs");
    };

    pass.await;
    assert_eq!(character.state, RosterState::Failed);
    assert!(
        character
            .diagnostic
            .as_deref()
            .is_some_and(|diagnostic| diagnostic.contains("is disabled")),
        "{character:?}"
    );
    assert_eq!(
        wire(&daemon.health().await)["characters"][0]["state"],
        "failed"
    );
}

/// lifecycle.stop-during-boot: A stop that comes while a character boots overtakes the boot: she ends stopped without ever being ready, and every start after it is refused `gateway_stopped`.
#[tokio::test(start_paused = true)]
async fn a_stop_during_her_boot_wins_and_no_start_follows() {
    let world = World::new();
    let daemon = world.daemon(Vec::new()).await;
    let mut ear = Ear::on(&daemon);

    world.assembly.shut();

    let boot = tokio::spawn({
        let daemon = daemon.clone();

        async move { daemon.reconcile().await }
    });

    world.assembly.reached().await;

    let stop = begun(daemon.stop()).await;

    world.assembly.open();
    stop.await;
    boot.await.unwrap();
    ear.reached("mira", Stopped).await;
    assert_eq!(ear.states("mira"), [Starting, Stopping, Stopped]);
    assert_eq!(
        wire(&daemon.start_character("mira").await),
        json!({"status": "refused", "reason": "gateway_stopped", "message": "The daemon is stopped."})
    );
}

/// lifecycle.start-joins-in-flight: A start sent while the same character is starting joins that start and answers only when the character is ready.
#[tokio::test]
async fn a_start_during_her_start_joins_it_and_answers_once_she_is_ready() {
    let world = World::new();
    let daemon = world.daemon(Vec::new()).await;
    let mut ear = Ear::on(&daemon);
    let start = || {
        let daemon = daemon.clone();

        tokio::spawn(async move { daemon.start_character("mira").await })
    };

    world.assembly.shut();

    let first = start();

    world.assembly.reached().await;

    let second = start();

    a_while().await;
    assert!(!second.is_finished());
    world.assembly.open();

    for started in [first.await.unwrap(), second.await.unwrap()] {
        let StartOutcome::Settled { character } = started else {
            panic!("{started:?}");
        };

        assert_eq!(character.state, RosterState::Ready);
    }

    ear.reached("mira", Ready).await;
    a_while().await;
    assert_eq!(ear.states("mira"), [Starting, Ready]);
}

/// A start whose boot fails starts her once: it answers with her failure,
/// and nothing starts her again behind it.
#[tokio::test(start_paused = true)]
async fn a_start_whose_boot_fails_starts_her_once() {
    let world = World::new();
    let daemon = world.daemon_answering(None, Vec::new()).await;
    let mut ear = Ear::on(&daemon);
    let StartOutcome::Settled { character } = daemon.start_character("mira").await else {
        panic!("her start runs");
    };

    settle().await;
    ear.drain();
    assert_eq!(character.state, RosterState::Failed);
    assert_eq!(ear.states("mira"), [Starting, Failed]);
}

/// A change of her settings while her turn runs builds her again before
/// the turn's next request, held here at her assembly: the turn goes on
/// with what it did so far, and a line sent meanwhile waits and lands on
/// her thread after it. Built again, she says she is ready.
#[tokio::test]
async fn a_rebuild_between_her_requests_keeps_her_turn_and_a_line_sent_meanwhile_lands_after() {
    let world = World::new();
    let daemon = world
        .daemon(vec![Toy::new("tone").setting("tone").plugin()])
        .await;

    daemon.reconcile().await;

    let conversation = open(&daemon).await;
    let gate = Arc::new(Gate::default());
    let deliver = |text: &str, id: &str| {
        let daemon = daemon.clone();
        let line = line(&conversation, text, id);

        tokio::spawn(async move { told(&daemon, line).await })
    };

    gate.shut();
    world.model.script([
        Round::calls("runtime.plugin.list", &json!({})).held(&gate),
        Round::says(&["First."]),
    ]);

    let mut ear = Ear::on(&daemon);
    let first = deliver("First?", "first");

    gate.reached().await;
    change(&daemon, home(), warm()).await;
    world.assembly.shut();
    gate.open();
    world.assembly.reached().await;

    let second = deliver("Second?", "second");

    a_while().await;
    assert!(!first.is_finished() && !second.is_finished());
    world.assembly.open();
    assert_eq!(first.await.unwrap().said, ["First?", "First."]);

    let delivered = second.await.unwrap();

    assert_eq!(delivered.said, ["Second?", "Hello."]);
    assert_eq!(delivered.ended["conversationId"], conversation);
    ear.until(|event| {
        matches!(event, Event::TurnCompleted { client_message_id, .. } if client_message_id.as_str() == "second")
    })
    .await;
    assert_eq!(ear.states("mira"), [Ready]);
}

/// A stop answers only once everything it ended is announced: the turn in
/// flight, finished, and her last state are on the events by then, so a
/// surface that reads them after the stop misses nothing.
#[tokio::test(start_paused = true)]
async fn a_stop_answers_after_what_it_ended_was_announced() {
    let world = World::new();
    let daemon = world.daemon(Vec::new()).await;

    daemon.reconcile().await;

    let conversation = open(&daemon).await;
    let gate = Arc::new(Gate::default());
    let mut ear = Ear::on(&daemon);

    gate.shut();
    world
        .model
        .script([Round::says(&["Still here."]).held(&gate)]);

    let turn = tokio::spawn({
        let daemon = daemon.clone();
        let line = line(&conversation, "Still there?", "in-flight");

        async move { told(&daemon, line).await }
    });

    gate.reached().await;

    let stop = begun(daemon.stop()).await;

    gate.open();
    stop.await;
    ear.drain();

    assert_eq!(turn.await.unwrap().said, ["Still there?", "Still here."]);
    assert!(
        ear.kinds().iter().any(|kind| kind == "turn_completed"),
        "{:?}",
        ear.kinds()
    );
    assert_eq!(ear.states("mira"), [Stopping, Stopped]);
}

/// A character whose package leaves the home while she runs is stopped by
/// the next reconcile, and is then no character to reach.
#[tokio::test(start_paused = true)]
async fn a_package_removed_while_she_runs_stops_her() {
    let world = World::new();

    world.package("nova", "Nova");

    let daemon = world.daemon(Vec::new()).await;

    daemon.reconcile().await;
    remove(&world.path("characters/nova"));

    daemon.reconcile().await;

    let OpenOutcome::Refused { reason, message } = daemon.open_conversation("nova").await else {
        panic!("she is no character to reach");
    };

    assert_eq!(wire(&reason), "character_unavailable");
    assert_eq!(
        message,
        "Character \"nova\" is not ready (state \"stopped\")."
    );
}

/// The toy plugin's tone set warm, at the home.
fn warm() -> serde_json::Value {
    json!({
        "kind": "section_field_set",
        "namespace": "plugins",
        "id": "tone",
        "field": "tone",
        "value": "warm",
    })
}

#[expect(
    clippy::disallowed_methods,
    reason = "a test takes a package out of the home as a person would"
)]
fn remove(path: &std::path::Path) {
    std::fs::remove_dir_all(path).unwrap();
}
