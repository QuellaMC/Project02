//! The plugins' hooks around the turn, as the person sees what they do to
//! it: a refusal before the model is asked, a health gate after a reply was
//! shown, and work after the commit that fails.

use std::fs::Permissions;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use p02_contracts::{
    BEFORE_ROLE_MODEL_CALL_REJECTION, BeforeRoleModelCallOutput, DecisionRejectionReason,
    EvidenceKind, EvidenceStatus, HEALTH_REJECTION, HealthReport, HealthStatus, PluginError,
};
use p02_runtime::{Delivery, RejectedTurn};
use p02_store::{LogRecord, RecordBody, RecordKind, TurnRejection, TurnStatus};
use serde_json::json;

use crate::support::{Chat, Round, Toy, make_read_only, reply, restore};

fn rejected(delivery: Delivery) -> RejectedTurn {
    match delivery {
        Delivery::Rejected { turn } => turn,
        other => panic!("{other:?}"),
    }
}

/// plugins.before-call-rejection: when a plugin's before-call hook rejects the turn, the person's line stays committed, the turn is rejected `plugin_before_role_model_call_rejected` with nothing asked of the model, and the next turn completes
#[tokio::test]
async fn a_before_call_rejection_keeps_the_line_and_the_next_turn_completes() {
    let calls = AtomicUsize::new(0);
    let gate = Toy::new("gate")
        .access(json!({"model_input": "write"}))
        .rejecting_turns()
        .before(move |_| match calls.fetch_add(1, Ordering::SeqCst) {
            0 => Err(PluginError::new("The gate is closed.")),
            _ => Ok(BeforeRoleModelCallOutput::default()),
        });
    let mut chat = Chat::new(&[Arc::new(gate)]);
    let id = chat.id();

    chat.model.script([Round::says(reply(&["Come in."]))]);

    let turn = rejected(chat.say("Let me in?", "knock").await);
    let records = chat.records(1);
    let Some(RecordBody::TurnRejected(rejected)) = records.last().map(LogRecord::body) else {
        panic!("the turn ends rejected");
    };

    assert_eq!(turn.reason, BEFORE_ROLE_MODEL_CALL_REJECTION);
    assert_eq!(turn.message, "The gate is closed.");
    assert_eq!(rejected.message(), turn.message);
    assert_eq!(
        rejected
            .visible_message_ids
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        [format!("{id}.1:message-1")]
    );
    assert_eq!(chat.model.asked.lock().unwrap().len(), 0);
    assert!(matches!(
        chat.say("Now?", "again").await,
        Delivery::Completed { .. }
    ));
    assert_eq!(
        chat.heard.take(),
        [
            "user_message Let me in?",
            "user_message Now?",
            "visible_reply 1.0 Come in."
        ]
    );
}

/// plugins.health-gate: a plugin whose health rejects the turn after its reply was shown rejects it `plugin_health_rejected` with the plugin's reason, the shown reply kept in the log anchored by the one rejection, a refused commit of the round it judged
#[tokio::test]
async fn a_health_gate_rejecting_after_the_reply_keeps_the_reply_anchored() {
    let vitals = Toy::new("vitals").rejecting_turns().health(HealthReport {
        status: HealthStatus::Unavailable,
        summary: "Vitals offline.".to_owned(),
    });
    let mut chat = Chat::new(&[Arc::new(vitals)]);
    let id = chat.id();

    chat.model.script([Round::says(reply(&["Here I am."]))]);

    let delivery = chat.say("Are you there?", "there").await;
    let records = chat.records(1);
    let rejections: Vec<_> = records
        .iter()
        .filter_map(|record| match record.body() {
            RecordBody::TurnRejected(rejected) => Some(rejected),
            _ => None,
        })
        .collect();
    let message = "Plugin health unavailable: Vitals offline.";

    assert_eq!(
        rejected(delivery),
        RejectedTurn {
            reason: HEALTH_REJECTION,
            message: message.to_owned(),
        }
    );
    assert_eq!(
        chat.heard.take(),
        [
            "user_message Are you there?",
            "visible_reply 1.0 Here I am."
        ]
    );
    assert_eq!(rejections.len(), 1);
    assert_eq!(
        rejections[0].rejection(),
        TurnRejection::Judged {
            round: NonZeroU32::MIN,
            reason: DecisionRejectionReason::CommitValidationFailure,
        }
    );
    assert_eq!(rejections[0].message(), message);
    assert_eq!(
        rejections[0]
            .visible_message_ids
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        [format!("{id}.1:message-1"), format!("{id}.1:message-2")]
    );
    assert_eq!(
        rejections[0]
            .runtime_plugin_turn_evidence
            .as_ref()
            .map(|evidence| evidence.health[0].status()),
        Some(HealthStatus::Unavailable)
    );
    assert_eq!(
        records.last().unwrap().kind(),
        RecordKind::RuntimeTurnRejected
    );
}

/// plugins.after-turn-hooks: an after-turn hook failure is recorded as a follow-up record `completed_with_failures` while the turn stays completed, and when that record cannot be appended the failure is reported on the completed turn, which stays completed
#[tokio::test]
async fn an_after_turn_failure_is_recorded_or_reported_and_the_turn_stays_completed() {
    let log: Arc<Mutex<Option<PathBuf>>> = Arc::default();
    let writable: Arc<Mutex<Option<Permissions>>> = Arc::default();
    let calls = AtomicUsize::new(0);
    let memory = {
        let (log, writable) = (Arc::clone(&log), Arc::clone(&writable));

        Toy::new("memory").after(move |_| {
            if calls.fetch_add(1, Ordering::SeqCst) == 1 {
                let log = log.lock().unwrap().clone().unwrap();

                *writable.lock().unwrap() = Some(make_read_only(&log));
            }

            Err(PluginError::new("The memory is full."))
        })
    };
    let mut chat = Chat::new(&[Arc::new(memory)]);
    let failure = "afterTurnCommitted plugin hook failed: The memory is full.";

    *log.lock().unwrap() = Some(chat.log(1));
    chat.model.script([
        Round::says(reply(&["Remembered."])),
        Round::says(reply(&["Remembered too."])),
    ]);

    let Delivery::Completed { turn: first, .. } = chat.say("Remember tea.", "tea").await else {
        panic!("the turn stays completed");
    };
    let records = chat.records(1);
    let Some(RecordBody::AfterTurnCommitted(after)) = records.last().map(LogRecord::body) else {
        panic!("the failure lands after the completed turn");
    };

    assert_eq!(first.post_commit_failures, [failure]);
    assert_eq!(after.status, TurnStatus::CompletedWithFailures);
    assert!(after.runtime_plugin_evidence.iter().any(|evidence| {
        evidence.kind() == EvidenceKind::AfterTurnCommitted
            && evidence.status() == EvidenceStatus::Failed
            && evidence.summary() == failure
    }));

    let delivery = chat.say("Remember cake.", "cake").await;

    restore(&chat.log(1), writable.lock().unwrap().take().unwrap());

    let Delivery::Completed { turn: second, .. } = delivery else {
        panic!("the turn stays completed when its follow-up cannot land");
    };
    let kinds = chat.kinds(1);

    assert_eq!(second.post_commit_failures.len(), 2);
    assert_eq!(second.post_commit_failures[0], failure);
    assert!(
        second.post_commit_failures[1].contains("could not write"),
        "{}",
        second.post_commit_failures[1]
    );
    assert_eq!(kinds.last(), Some(&RecordKind::RuntimeTurnCompleted));
    assert_eq!(
        kinds
            .iter()
            .filter(|&&kind| kind == RecordKind::AfterTurnCommitted)
            .count(),
        1
    );
}
