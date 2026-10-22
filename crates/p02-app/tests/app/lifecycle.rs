//! A character's life: her start, what the settings make of her, her
//! reload, her stop, and what overtakes what.

use std::sync::{Arc, Mutex};

use p02_app::CharacterState::{Failed, Ready, Reloading, Starting, Stopped, Stopping};
use p02_app::{
    Answer, ConfirmationAnswer, Event, OpenOutcome, ReconcilePlan, RosterState, StartOutcome,
    TurnOutcome,
};
use p02_config::{ConfigTarget, connectors};
use p02_shared::{PathEntry, describe_entry};
use serde_json::json;

use crate::support::{
    Ear, Gate, Round, Toy, World, a_while, begun, change, home, id, line, make_read_only, open,
    restore, said, settle, wire,
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

    assert_eq!(daemon.reconcile().await.starting, []);
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
    change(
        &daemon,
        home(),
        json!({"kind": "set", "path": "project02.enabled", "value": false}),
    )
    .await;

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

    assert_eq!(pass.await, ReconcilePlan::default());
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
    change(
        &daemon,
        home(),
        json!({"kind": "set", "path": "project02.enabled", "value": false}),
    )
    .await;
    world.assembly.open();
    boot.await.unwrap();
    daemon.reconcile().await;
    ear.reached("mira", Stopped).await;

    // Her boot ends ready, or her stop overtakes it: either way the stop
    // has the last word.
    let states = ear.states("mira");

    assert_eq!(states.first(), Some(&Starting));
    assert!(states.ends_with(&[Stopping, Stopped]), "{states:?}");
    assert_eq!(
        wire(&daemon.health().await)["characters"][0]["state"],
        "stopped"
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

    change(
        &daemon,
        home(),
        json!({
            "kind": "section_field_set",
            "namespace": "connectors",
            "id": "telegram",
            "field": "mirror",
            "value": false,
        }),
    )
    .await;
    assert_eq!(daemon.reconcile().await.reloading, []);

    world.assembly.shut();
    change(&daemon, home(), warm()).await;

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

/// A change that would build her from something else while her turn runs
/// says she is reloading at once; the turn finishes first, then the reload,
/// and a line sent meanwhile lands on her thread after it.
#[tokio::test(start_paused = true)]
async fn a_reload_decided_during_her_turn_is_said_at_once_and_follows_the_turn() {
    let world = World::new();
    let daemon = world
        .daemon(vec![Toy::new("tone").setting("tone").plugin()])
        .await;

    daemon.reconcile().await;

    let conversation = open(&daemon).await;
    let gate = Arc::new(Gate::default());

    gate.shut();
    world.model.script([Round::says(&["First."]).held(&gate)]);

    let mut ear = Ear::on(&daemon);
    let first = tokio::spawn({
        let daemon = daemon.clone();
        let line = line(&conversation, "First?", "first");

        async move { daemon.deliver(line).await }
    });

    gate.reached().await;
    change(&daemon, home(), warm()).await;
    ear.reached("mira", Reloading).await;

    let second = tokio::spawn({
        let daemon = daemon.clone();
        let line = line(&conversation, "Second?", "second");

        async move { daemon.deliver(line).await }
    });

    settle().await;
    assert!(!first.is_finished());
    gate.open();
    assert_eq!(said(&first.await.unwrap()), ["First?", "First."]);
    assert_eq!(daemon.reconcile().await.reloading, [id("mira")]);
    assert_eq!(said(&second.await.unwrap()), ["Second?", "Hello."]);
    ear.until(|event| {
        matches!(event, Event::TurnCompleted { client_message_id, .. } if client_message_id.as_str() == "second")
    })
    .await;

    let order: Vec<String> = ear
        .heard
        .iter()
        .filter_map(|event| match event {
            Event::StateChanged { state, .. } => Some(wire(state).as_str()?.to_owned()),
            Event::TurnCompleted {
                client_message_id, ..
            } => Some(client_message_id.to_string()),
            _ => None,
        })
        .collect();

    assert_eq!(order, ["reloading", "first", "ready", "second"]);
}

/// A change her own plugin makes is the daemon's one change of settings:
/// health goes out before the call's answer, and the plugin it changes,
/// rebuilt live, already runs what her settings now say, so nothing
/// reloads her.
#[tokio::test(start_paused = true)]
async fn a_change_her_own_plugin_makes_is_announced_and_reloads_nothing_it_applied_live() {
    let world = World::new();

    world.settings(json!({"plugins": {"demo-config": {"enabled": true}}}));

    let daemon = world.daemon(Vec::new()).await;

    daemon.reconcile().await;

    let conversation = open(&daemon).await;
    let view = daemon
        .config_view(ConfigTarget::Character {
            character_id: "mira".to_owned(),
        })
        .await;
    let mut ear = Ear::on(&daemon);

    world.model.script([
        Round::calls(
            "runtime.plugin.config.update",
            &json!({
                "pluginId": "demo-config",
                "fieldName": "tone",
                "operation": "set",
                "value": "warm",
                "expectedFingerprint": wire(&view)["fingerprint"],
            }),
        ),
        Round::says(&["Warmer now."]),
    ]);

    let turn = tokio::spawn({
        let daemon = daemon.clone();
        let line = line(&conversation, "Be warmer.", "warmer");

        async move { daemon.deliver(line).await }
    });
    let requested = ear
        .until(|event| matches!(event, Event::ConfirmationRequested(_)))
        .await;
    let answered =
        daemon.answer_confirmation(wire(&requested)["id"].as_str().unwrap(), Answer::Approved);

    assert_eq!(answered, ConfirmationAnswer::Answered);
    ear.until(|event| matches!(event, Event::HealthChanged { .. }))
        .await;
    assert_eq!(said(&turn.await.unwrap()), ["Be warmer.", "Warmer now."]);
    ear.drain();
    assert_eq!(ear.states("mira"), []);
    assert_eq!(daemon.reconcile().await.reloading, []);
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

        async move { daemon.deliver(line).await }
    });

    gate.reached().await;

    let stop = begun(daemon.stop()).await;

    gate.open();
    stop.await;
    ear.drain();

    assert_eq!(said(&turn.await.unwrap()), ["Still there?", "Still here."]);
    assert!(
        ear.kinds().iter().any(|kind| kind == "turn_completed"),
        "{:?}",
        ear.kinds()
    );
    assert_eq!(ear.states("mira"), [Stopping, Stopped]);
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
    change(&daemon, home(), warm()).await;
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

/// A package changed under her, her name and nothing else, makes the next
/// reconcile build her again from it, so her thread, made after, is in her
/// new name.
#[tokio::test(start_paused = true)]
async fn a_package_changed_under_her_rebuilds_her_from_it() {
    let world = World::new();

    world.package("nova", "Nova");

    let daemon = world.daemon(Vec::new()).await;

    daemon.reconcile().await;
    world.package("nova", "Nova Prime");
    assert_eq!(daemon.reconcile().await.reloading, [id("nova")]);

    let OpenOutcome::Opened {
        conversation_id, ..
    } = daemon.open_conversation("nova").await
    else {
        panic!("her thread opens");
    };
    let outcome = daemon
        .deliver(line(conversation_id.as_str(), "Hello?", "hello"))
        .await;

    assert_eq!(wire(&outcome)["messages"][1]["speakerName"], "Nova Prime");
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

    let first = daemon.connector_present(telegram);
    let second = daemon.connector_present(telegram);

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
