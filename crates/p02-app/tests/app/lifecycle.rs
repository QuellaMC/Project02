//! A character's life: her start, what the settings make of her, her
//! reload, her stop, and what overtakes what.

use std::sync::{Arc, Mutex};

use p02_app::CharacterState::{Failed, Ready, Reloading, Starting, Stopped, Stopping};
use p02_app::{Event, OpenOutcome, StartOutcome, TurnOutcome};
use p02_config::connectors;
use p02_shared::{PathEntry, describe_entry};
use serde_json::json;

use crate::support::{
    Ear, Round, Toy, World, a_while, begun, id, line, make_read_only, open, restore, said, settle,
    wire,
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

    world.settings(json!({"project02": {"roleModelProvider": "nvidia"}}));
    daemon.settings_changed().await;
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

    assert_eq!(daemon.reconcile().await.starting, []);
    assert_eq!(
        wire(&daemon.health().await)["characters"][0],
        json!({"id": "mira", "displayName": "Mira", "enabled": false, "state": "not_started"})
    );
    assert!(matches!(
        describe_entry(&world.path("character-data")),
        PathEntry::Absent
    ));

    world.settings(json!({}));
    daemon.settings_changed().await;
    assert_eq!(daemon.reconcile().await.starting, [id("mira")]);

    let conversation = open(&daemon).await;
    let mut ear = Ear::on(&daemon);

    world
        .model
        .script([Round::calls("notes.save", &json!({"note": "Tea at five."}))]);

    let turn = tokio::spawn({
        let daemon = daemon.clone();

        async move {
            daemon
                .deliver(line(&conversation, "Remember tea.", "tea"))
                .await
        }
    });

    ear.until(|event| matches!(event, Event::ConfirmationRequested(_)))
        .await;
    world.settings(json!({"project02": {"enabled": false}}));
    daemon.settings_changed().await;

    let plan = daemon.reconcile().await;
    let settled = ear
        .until(|event| matches!(event, Event::ConfirmationSettled { .. }))
        .await;

    assert_eq!(plan.stopping, [id("mira")]);
    assert_eq!(wire(&settled)["decision"], "cancelled");
    assert_eq!(wire(&settled)["reason"], "stopped");
    assert!(daemon.pending_confirmations().is_empty());
    assert!(matches!(turn.await.unwrap(), TurnOutcome::Completed { .. }));
    assert_eq!(
        wire(&daemon.health().await)["characters"][0]["state"],
        "stopped"
    );
}

/// config.change-during-boot: A change that switches a character off while her boot is in flight ends with her stopped.
#[tokio::test(start_paused = true)]
async fn a_change_switching_her_off_during_her_boot_ends_with_her_stopped() {
    let world = World::new();
    let daemon = world.daemon(Vec::new()).await;
    let mut ear = Ear::on(&daemon);

    world.assembly.shut();

    let boot = tokio::spawn({
        let daemon = daemon.clone();

        async move { daemon.reconcile().await }
    });

    world.assembly.reached().await;
    world.settings(json!({"project02": {"enabled": false}}));
    daemon.settings_changed().await;
    world.assembly.open();
    boot.await.unwrap();
    daemon.reconcile().await;
    ear.reached("mira", Stopped).await;
    assert_eq!(ear.states("mira"), [Starting, Ready, Stopping, Stopped]);
    assert_eq!(
        wire(&daemon.health().await)["characters"][0]["state"],
        "stopped"
    );
}

/// A stop that comes while she boots overtakes the boot: she ends stopped
/// without ever being ready, and no start follows the stop.
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

        assert_eq!(character.state, Some(Ready));
    }

    ear.reached("mira", Ready).await;
    a_while().await;
    assert_eq!(ear.states("mira"), [Starting, Ready]);
}

/// A change to a plugin's settings makes the next reconcile reload her
/// between turns, and a line sent meanwhile lands on her thread after it;
/// a change that leaves what she runs on as it was reloads nothing.
#[tokio::test]
async fn a_changed_setting_reloads_her_and_a_line_sent_meanwhile_lands_after() {
    let world = World::new();
    let daemon = world
        .daemon(vec![Toy::new("tone").setting("tone").plugin()])
        .await;

    daemon.reconcile().await;

    let conversation = open(&daemon).await;
    let mut ear = Ear::on(&daemon);

    world.settings(json!({"connectors": {"telegram": {"config": {"mirror": false}}}}));
    daemon.settings_changed().await;
    assert_eq!(daemon.reconcile().await.reloading, []);

    world.assembly.shut();
    world.settings(json!({"plugins": {"tone": {"config": {"tone": "warm"}}}}));
    daemon.settings_changed().await;

    let pass = tokio::spawn({
        let daemon = daemon.clone();

        async move { daemon.reconcile().await }
    });

    world.assembly.reached().await;

    let turn = tokio::spawn({
        let daemon = daemon.clone();
        let line = line(&conversation, "Still there?", "still");

        async move { daemon.deliver(line).await }
    });

    a_while().await;
    assert!(!turn.is_finished());
    world.assembly.open();
    assert_eq!(pass.await.unwrap().reloading, [id("mira")]);

    let delivered = turn.await.unwrap();

    ear.reached("mira", Ready).await;
    assert_eq!(said(&delivered), ["Still there?", "Hello."]);
    assert_eq!(wire(&delivered)["conversationId"], conversation);
    assert_eq!(ear.states("mira"), [Reloading, Ready]);
}

/// lifecycle.stop-during-reload: A stop issued during a character's reload wins (reloading, stopping, stopped).
#[tokio::test(start_paused = true)]
async fn a_stop_during_her_reload_wins() {
    let world = World::new();
    let daemon = world
        .daemon(vec![Toy::new("tone").setting("tone").plugin()])
        .await;

    daemon.reconcile().await;

    let mut ear = Ear::on(&daemon);

    world.assembly.shut();
    world.settings(json!({"plugins": {"tone": {"config": {"tone": "warm"}}}}));
    daemon.settings_changed().await;
    world.assembly.reached().await;

    let stop = begun(daemon.stop()).await;

    world.assembly.open();
    stop.await;
    ear.reached("mira", Stopped).await;
    assert_eq!(ear.states("mira"), [Reloading, Stopping, Stopped]);
}

/// lifecycle.stop-overtakes-recovery: A stop during the automatic recovery after a fatal turn wins: no ready state is published after the stop began and the character ends stopped.
#[tokio::test(start_paused = true)]
async fn a_stop_during_her_recovery_wins() {
    let world = World::new();
    let daemon = world.daemon(Vec::new()).await;

    daemon.reconcile().await;

    let conversation = open(&daemon).await;
    let log = world.log(&conversation, 1);
    let writable = Arc::new(Mutex::new(None));
    let mut ear = Ear::on(&daemon);

    world.model.script([Round::says(&["Hi."]).then({
        let (log, writable) = (log.clone(), Arc::clone(&writable));

        move || *writable.lock().unwrap() = Some(make_read_only(&log))
    })]);
    world.assembly.shut();

    let failed = daemon
        .deliver(line(&conversation, "Hello there", "hello"))
        .await;

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
    world.assembly.reached().await;

    let stop = begun(daemon.stop()).await;

    world.assembly.open();
    stop.await;
    ear.reached("mira", Stopped).await;
    assert_eq!(ear.states("mira"), [Failed, Starting, Stopping, Stopped]);
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

    let plan = daemon.reconcile().await;
    let OpenOutcome::Refused { reason, message } = daemon.open_conversation("nova").await else {
        panic!("she is no character to reach");
    };

    assert_eq!(plan.stopping, [id("nova")]);
    assert_eq!(wire(&reason), "unknown_character");
    assert_eq!(
        message,
        "Character \"nova\" is not installed. Installed characters: mira."
    );
}

#[expect(
    clippy::disallowed_methods,
    reason = "a test takes a package out of the home as a person would"
)]
fn remove(path: &std::path::Path) {
    std::fs::remove_dir_all(path).unwrap();
}

/// A connector counts as present from its first stream until its last
/// ends, and health changes only when the count crosses zero.
#[tokio::test(start_paused = true)]
async fn a_connector_is_present_while_any_of_its_streams_is() {
    let world = World::new();
    let daemon = world.daemon(Vec::new()).await;
    let telegram = &connectors()[0];
    let mut ear = Ear::on(&daemon);
    let connected = |event: &Event| match event {
        Event::HealthChanged { health } => Some(health.connectors[0].connected),
        _ => None,
    };

    let first = daemon.connector_present(telegram).await;
    let second = daemon.connector_present(telegram).await;

    drop(first);
    settle().await;
    drop(second);
    ear.until(|event| connected(event) == Some(false)).await;
    settle().await;

    let heard: Vec<bool> = ear.heard.iter().filter_map(connected).collect();

    assert_eq!(heard, [true, false]);
    assert_eq!(
        wire(&daemon.health().await)["connectors"],
        json!([{"id": "telegram", "connected": false}])
    );
}
