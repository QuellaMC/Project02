//! A character's life: her start, her stop, and what overtakes what.

use std::sync::Arc;

use p02_wire::CharacterState::{Failed, Ready, Starting, Stopped, Stopping};
use p02_wire::{OpenOutcome, RosterState, StartOutcome};
use serde_json::json;

use crate::support::{Ear, Gate, Round, World, a_while, begun, line, open, settle, told, wire};

/// A pass judges the characters running when it was asked for: a client's
/// start of a character switched off, while the pass runs, is the
/// client's, and fails her saying she is switched off.
#[tokio::test]
async fn a_pass_judges_only_the_characters_running_when_it_was_asked_for() {
    let world = World::new();

    world.her_settings(json!({"project02": {"enabled": false}}));

    let daemon = world.daemon().await;
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
            .is_some_and(|diagnostic| diagnostic.contains("is switched off")),
        "{character:?}"
    );
    assert_eq!(
        wire(&daemon.health().await)["characters"][0]["state"],
        "failed"
    );
}

/// She ends stopped without ever being ready.
#[tokio::test(start_paused = true)]
async fn a_stop_during_her_boot_wins_and_no_start_follows() {
    let world = World::new();
    let daemon = world.daemon().await;
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

#[tokio::test]
async fn a_start_during_her_start_joins_it_and_answers_once_she_is_ready() {
    let world = World::new();
    let daemon = world.daemon().await;
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
    let daemon = world.daemon_answering(None).await;
    let mut ear = Ear::on(&daemon);
    let StartOutcome::Settled { character } = daemon.start_character("mira").await else {
        panic!("her start runs");
    };

    settle().await;
    ear.drain();
    assert_eq!(character.state, RosterState::Failed);
    assert_eq!(ear.states("mira"), [Starting, Failed]);
}

/// A stop answers only once everything it ended is announced: the turn in
/// flight, finished, and her last state are on the events by then, so a
/// surface that reads them after the stop misses nothing.
#[tokio::test(start_paused = true)]
async fn a_stop_answers_after_what_it_ended_was_announced() {
    let world = World::new();
    let daemon = world.daemon().await;

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

    assert_eq!(turn.await.unwrap(), ["Still there?", "Still here."]);
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

    let daemon = world.daemon().await;

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

#[expect(
    clippy::disallowed_methods,
    reason = "a test takes a package out of the home as a person would"
)]
fn remove(path: &std::path::Path) {
    std::fs::remove_dir_all(path).unwrap();
}
