//! A call that asks the person first: the confirmation it parks, its
//! answer, and its deadline.

use p02_app::{Answer, ConfirmationAnswer, Event};
use p02_core::Timestamp;
use serde_json::json;

use crate::support::{Ear, Round, Toy, World, line, open, said, wire};

/// A tool call that asks first parks a confirmation, stamped with its
/// deadline and the turn that raised it, which every surface hears and the
/// list shows; an approval answers it, settles it before the turn
/// completes, and a second answer finds nothing.
#[tokio::test(start_paused = true)]
async fn an_approved_confirmation_settles_before_its_turn_completes() {
    let world = World::new();
    let daemon = world
        .daemon(vec![Toy::new("notes").asking("notes.save").plugin()])
        .await;

    daemon.reconcile().await;

    let conversation = open(&daemon).await;
    let mut ear = Ear::on(&daemon);

    world.model.script([
        Round::calls("notes.save", &json!({"note": "Tea at five."})),
        Round::says(&["Saved."]),
    ]);

    let turn = tokio::spawn({
        let daemon = daemon.clone();
        let line = line(&conversation, "Remember tea.", "tea");

        async move { daemon.deliver(line).await }
    });
    let requested = ear
        .until(|event| matches!(event, Event::ConfirmationRequested(_)))
        .await;
    let pending = wire(&daemon.pending_confirmations());
    let id = pending[0]["id"].as_str().unwrap().to_owned();
    let deadline = pending[0]["deadlineAt"].as_i64().unwrap() - Timestamp::now().unix_millis();
    let mut announced = wire(&requested);

    announced.as_object_mut().unwrap().remove("kind");
    assert_eq!(pending, json!([announced]));
    assert_eq!(
        pending[0]["request"],
        json!({
            "pluginId": "notes",
            "toolName": "notes.save",
            "summary": "Saves a note the person approves.",
            "preview": {"note": "Tea at five."},
        })
    );
    assert_eq!(
        pending[0]["turn"],
        json!({"conversationId": conversation, "source": "web", "clientMessageId": "tea"})
    );
    assert!((0..=5 * 60 * 1000).contains(&deadline), "{deadline}");
    assert_eq!(
        daemon.answer_confirmation(&id, Answer::Approved),
        ConfirmationAnswer::Answered
    );
    assert_eq!(said(&turn.await.unwrap()), ["Remember tea.", "Saved."]);
    ear.until(|event| matches!(event, Event::TurnCompleted { .. }))
        .await;

    let settled = ear
        .heard
        .iter()
        .position(|event| matches!(event, Event::ConfirmationSettled { .. }))
        .unwrap();

    assert_eq!(
        wire(&ear.heard[settled]),
        json!({"kind": "confirmation_settled", "characterId": "mira", "id": id, "decision": "approved"})
    );
    assert_eq!(
        ear.kinds().last().map(String::as_str),
        Some("turn_completed")
    );
    assert!(daemon.pending_confirmations().is_empty());
    assert_eq!(
        daemon.answer_confirmation(&id, Answer::Approved),
        ConfirmationAnswer::Unknown
    );
}

/// A confirmation nobody answers by its deadline settles cancelled
/// expired, the turn goes on without the call, and a later answer finds
/// nothing.
#[tokio::test(start_paused = true)]
async fn a_confirmation_nobody_answers_expires_and_the_turn_goes_on() {
    let world = World::new();
    let daemon = world
        .daemon(vec![Toy::new("notes").asking("notes.save").plugin()])
        .await;

    daemon.reconcile().await;

    let conversation = open(&daemon).await;
    let mut ear = Ear::on(&daemon);

    world.model.script([
        Round::calls("notes.save", &json!({"note": "Tea at five."})),
        Round::says(&["I could not save it."]),
    ]);

    let outcome = daemon
        .deliver(line(&conversation, "Remember tea.", "tea"))
        .await;
    let settled = wire(
        &ear.until(|event| matches!(event, Event::ConfirmationSettled { .. }))
            .await,
    );

    assert_eq!(said(&outcome), ["Remember tea.", "I could not save it."]);
    assert_eq!(settled["decision"], "cancelled");
    assert_eq!(settled["reason"], "expired");
    assert_eq!(
        daemon.answer_confirmation(settled["id"].as_str().unwrap(), Answer::Approved),
        ConfirmationAnswer::Unknown
    );
}
