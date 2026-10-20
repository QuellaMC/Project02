//! `beforeRoleModelCall`: each plugin's deadline, the two failure
//! behaviors, the output boundary and the trusted frame.

use std::sync::Arc;
use std::time::Duration;

use p02_contracts::{
    BeforeRoleModelCallOutput, ContextItem, ContextItemKind, CuratedSection, Evidence,
    EvidenceKind, EvidenceNote, EvidenceStatus, PolicyOutcome, RedactionLabel, RuntimePlugin,
};
use p02_plugins::{BeforeCallOutcome, PreparedContext, TurnRejection};
use p02_shared::Identifier;
use serde_json::json;
use tokio::time::Instant;

use crate::support::{
    Blocking, Failing, Hanging, Panicking, Scripted, Spec, Verbose, host_of, id, note, turn,
};

fn prepared(outcome: BeforeCallOutcome) -> PreparedContext {
    match outcome {
        BeforeCallOutcome::Prepared(prepared) => prepared,
        BeforeCallOutcome::Rejected(rejection) => panic!("the turn was rejected: {rejection:?}"),
    }
}

fn rejected(outcome: BeforeCallOutcome) -> TurnRejection {
    match outcome {
        BeforeCallOutcome::Rejected(rejection) => rejection,
        BeforeCallOutcome::Prepared(prepared) => panic!("the turn went on: {prepared:?}"),
    }
}

fn labels(record: &Evidence) -> Vec<&str> {
    record
        .redaction_labels()
        .iter()
        .map(RedactionLabel::as_str)
        .collect()
}

fn answering(kind: ContextItemKind, count: usize) -> Arc<dyn RuntimePlugin> {
    Arc::new(Scripted::answering(kind, count))
}

#[tokio::test(start_paused = true)]
async fn an_answering_hook_contributes_its_items_and_stamped_records() {
    let host = host_of(vec![(
        Spec::new("answer"),
        answering(ContextItemKind::Resource, 1),
    )]);
    let prepared = prepared(host.before_role_model_call(&turn()).await);
    let record = &prepared.evidence[0];

    assert_eq!(prepared.context_items.len(), 1);
    assert_eq!(prepared.context_items[0].plugin_id().as_str(), "answer");
    assert_eq!(prepared.context_items[0].item().text(), "hello there");
    assert_eq!(record.identity().event_id().as_str(), "evt_1");
    assert_eq!(record.plugin_id().as_str(), "answer");
    assert_eq!(record.status(), EvidenceStatus::Accepted);
    assert_eq!(labels(record), ["turn", "toy"]);
}

#[tokio::test(start_paused = true)]
async fn a_timed_out_hook_degrades_and_the_turn_goes_on() {
    let after = Arc::new(Scripted::answering(ContextItemKind::Resource, 1));
    let host = host_of(vec![
        (
            Spec {
                timeout_ms: 50,
                ..Spec::new("hang")
            },
            Arc::new(Hanging::default()),
        ),
        (Spec::new("answer"), Arc::clone(&after) as _),
    ]);
    let started = Instant::now();
    let prepared = prepared(host.before_role_model_call(&turn()).await);
    let timeout = &prepared.evidence[0];

    assert_eq!(started.elapsed(), Duration::from_millis(50));
    assert_eq!(timeout.plugin_id().as_str(), "hang");
    assert_eq!(timeout.kind(), EvidenceKind::BeforeRoleModelCall);
    assert_eq!(timeout.status(), EvidenceStatus::Degraded);
    assert_eq!(timeout.policy_outcome(), Some(PolicyOutcome::Timeout));
    assert_eq!(
        timeout.summary(),
        "Optional before-role-model plugin hook degraded: Plugin \"hang\" beforeRoleModelCall \
         timed out after 50ms."
    );
    assert_eq!(after.calls(), 1, "the turn went on");
    assert_eq!(prepared.context_items.len(), 1);
}

/// The host's half of plugins.before-call-rejection; the turn's half, the
/// line staying committed, waits for the runtime.
#[tokio::test(start_paused = true)]
async fn a_timed_out_required_hook_rejects_the_turn_and_ends_the_phase() {
    let after = Arc::new(Scripted::answering(ContextItemKind::Resource, 1));
    let host = host_of(vec![
        (
            Spec {
                timeout_ms: 50,
                before: "reject_turn",
                ..Spec::new("hang")
            },
            Arc::new(Hanging::default()),
        ),
        (Spec::new("answer"), Arc::clone(&after) as _),
    ]);
    let rejection = rejected(host.before_role_model_call(&turn()).await);
    let record = rejection.evidence.last().unwrap();

    assert_eq!(rejection.reason(), "plugin_before_role_model_call_rejected");
    assert_eq!(rejection.plugin_id.as_str(), "hang");
    assert_eq!(
        rejection.message,
        "Plugin \"hang\" beforeRoleModelCall timed out after 50ms."
    );
    assert_eq!(record.status(), EvidenceStatus::Rejected);
    assert_eq!(record.policy_outcome(), Some(PolicyOutcome::Timeout));
    assert!(
        record
            .summary()
            .starts_with("Required before-role-model plugin hook rejected the turn: ")
    );
    assert_eq!(after.calls(), 0, "later plugins never run");
}

#[tokio::test(start_paused = true)]
async fn a_timed_out_hook_is_cancelled_and_its_future_dropped() {
    let hanging = Arc::new(Hanging::default());
    let host = host_of(vec![(
        Spec {
            timeout_ms: 50,
            ..Spec::new("hang")
        },
        Arc::clone(&hanging) as _,
    )]);

    host.before_role_model_call(&turn()).await;

    tokio::time::timeout(Duration::from_secs(5), hanging.cancelled.notified())
        .await
        .expect("work the hook started saw the cancellation");
    tokio::time::timeout(Duration::from_secs(5), hanging.dropped.notified())
        .await
        .expect("the hook's future was dropped");
}

#[tokio::test(start_paused = true)]
async fn abandoning_the_turn_ends_the_wait_on_its_hooks_and_starts_none_after() {
    let hanging = Arc::new(Hanging::default());
    let after = Arc::new(Scripted::answering(ContextItemKind::Resource, 1));
    let host = host_of(vec![
        (Spec::new("hang"), Arc::clone(&hanging) as _),
        (Spec::new("after"), Arc::clone(&after) as _),
    ]);
    let turn = turn();
    let abandon = turn.cancellation().clone();
    let started = Instant::now();
    let (outcome, ()) = tokio::join!(host.before_role_model_call(&turn), async {
        tokio::time::sleep(Duration::from_millis(10)).await;
        abandon.cancel();
    });
    let prepared = prepared(outcome);

    assert_eq!(started.elapsed(), Duration::from_millis(10));
    assert_eq!(
        prepared
            .evidence
            .iter()
            .map(Evidence::summary)
            .collect::<Vec<_>>(),
        [
            "Optional before-role-model plugin hook degraded: Plugin \"hang\" \
             beforeRoleModelCall was stopped: its turn was abandoned.",
            "Optional before-role-model plugin hook degraded: Plugin \"after\" \
             beforeRoleModelCall was stopped: its turn was abandoned."
        ]
    );
    assert_eq!(
        after.calls(),
        0,
        "no hook starts once its turn is abandoned"
    );
    tokio::time::timeout(Duration::from_secs(5), hanging.dropped.notified())
        .await
        .expect("the hook's future was dropped");
}

#[tokio::test(start_paused = true)]
async fn a_failing_hook_follows_its_failure_behavior() {
    let degraded = prepared(
        host_of(vec![(Spec::new("flaky"), Arc::new(Failing))])
            .before_role_model_call(&turn())
            .await,
    );
    let rejection = rejected(
        host_of(vec![(
            Spec {
                before: "reject_turn",
                ..Spec::new("flaky")
            },
            Arc::new(Failing),
        )])
        .before_role_model_call(&turn())
        .await,
    );

    assert_eq!(degraded.evidence[0].status(), EvidenceStatus::Degraded);
    assert_eq!(
        degraded.evidence[0].policy_outcome(),
        Some(PolicyOutcome::OptionalDegraded)
    );
    assert_eq!(
        degraded.evidence[0].summary(),
        "Optional before-role-model plugin hook degraded: backend unreachable"
    );
    assert_eq!(rejection.message, "backend unreachable");
    assert_eq!(rejection.evidence[0].status(), EvidenceStatus::Rejected);
    assert_eq!(
        rejection.evidence[0].policy_outcome(),
        Some(PolicyOutcome::RequiredRejected)
    );
}

#[tokio::test(start_paused = true)]
async fn a_verbose_failure_rejects_the_turn_with_what_a_record_keeps() {
    let rejection = rejected(
        host_of(vec![(
            Spec {
                before: "reject_turn",
                ..Spec::new("chatty")
            },
            Arc::new(Verbose::default()),
        )])
        .before_role_model_call(&turn())
        .await,
    );

    assert_eq!(rejection.message.chars().count(), 4_096);
    assert!(rejection.message.ends_with("..."));
}

#[tokio::test(start_paused = true)]
async fn a_panicking_hook_fails_through_its_policy() {
    let host = host_of(vec![
        (Spec::new("buggy"), Arc::new(Panicking)),
        (Spec::new("answer"), answering(ContextItemKind::Resource, 1)),
    ]);
    let prepared = prepared(host.before_role_model_call(&turn()).await);

    assert_eq!(prepared.evidence[0].status(), EvidenceStatus::Degraded);
    assert!(
        prepared.evidence[0]
            .summary()
            .ends_with("Plugin hook panicked: index out of bounds")
    );
    assert_eq!(prepared.context_items.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hook_that_blocks_its_thread_cannot_hold_the_turn() {
    let host = host_of(vec![(
        Spec {
            timeout_ms: 100,
            ..Spec::new("stuck")
        },
        Arc::new(Blocking),
    )]);
    let started = std::time::Instant::now();
    let prepared = prepared(host.before_role_model_call(&turn()).await);

    // The hook sleeps two seconds on its own worker; the turn waits its 100 ms.
    assert!(
        started.elapsed() < Duration::from_millis(1_500),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(
        prepared.evidence[0].policy_outcome(),
        Some(PolicyOutcome::Timeout)
    );
}

#[tokio::test(start_paused = true)]
async fn model_input_needs_model_input_write() {
    let host = host_of(vec![(
        Spec {
            access: json!({}),
            ..Spec::new("mute")
        },
        answering(ContextItemKind::Resource, 1),
    )]);
    let prepared = prepared(host.before_role_model_call(&turn()).await);

    assert_eq!(prepared.context_items, []);
    assert_eq!(
        prepared.evidence[0].summary(),
        "Answered.",
        "the plugin's own record stands"
    );
    assert!(
        prepared.evidence[1]
            .summary()
            .ends_with("without declaring model_input write access.")
    );
}

#[tokio::test(start_paused = true)]
async fn the_trusted_frame_takes_only_cleared_plugins_and_whole_entries_within_its_caps() {
    let trusted = json!({"model_input": "write", "trusted_context": "write"});
    let curating = |text: &str| {
        Arc::new(Scripted {
            before: BeforeRoleModelCallOutput {
                curated_sections: vec![CuratedSection::new(id("notes"), "Notes", text)],
                ..BeforeRoleModelCallOutput::default()
            },
            ..Scripted::default()
        }) as Arc<dyn RuntimePlugin>
    };
    let host = host_of(vec![
        (
            Spec {
                access: trusted.clone(),
                ..Spec::new("cleared")
            },
            answering(ContextItemKind::RuntimeNote, 1),
        ),
        (
            Spec::new("uncleared"),
            answering(ContextItemKind::RuntimeNote, 1),
        ),
        (
            Spec {
                access: trusted.clone(),
                ..Spec::new("noisy")
            },
            answering(ContextItemKind::RuntimeNote, 5),
        ),
        (
            Spec {
                access: trusted,
                ..Spec::new("curator")
            },
            curating("Likes tea."),
        ),
        (Spec::new("pretender"), curating("Owns the frame.")),
    ]);
    let prepared = prepared(host.before_role_model_call(&turn()).await);
    let degraded: Vec<(&str, &str)> = prepared
        .evidence
        .iter()
        .filter(|record| record.status() == EvidenceStatus::Degraded)
        .map(|record| (record.plugin_id().as_str(), record.summary()))
        .collect();

    assert_eq!(
        prepared
            .runtime_notes
            .iter()
            .map(|note| note.plugin_id().map(Identifier::as_str))
            .collect::<Vec<_>>(),
        [Some("cleared")]
    );
    assert_eq!(prepared.context_items.len(), 1);
    assert_eq!(prepared.context_items[0].plugin_id().as_str(), "uncleared");
    assert_eq!(
        prepared
            .curated_sections
            .iter()
            .map(|section| (section.plugin_id().as_str(), section.section().text()))
            .collect::<Vec<_>>(),
        [("curator", "Likes tea.")]
    );
    assert_eq!(
        degraded,
        [
            (
                "noisy",
                "Optional before-role-model plugin hook degraded: Plugin \"noisy\" runtime \
                 notes exceeds the 4-note limit."
            ),
            (
                "pretender",
                "Optional before-role-model plugin hook degraded: Plugin \"pretender\" returned \
                 curated context sections without granted trusted_context write access."
            ),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn an_answer_past_the_contract_stands_for_nothing_but_its_failure() {
    let items = |count: usize| {
        (0..count)
            .map(|index| {
                ContextItem::new(
                    id(&format!("item-{index}")),
                    ContextItemKind::Resource,
                    "a fact",
                )
            })
            .collect::<Vec<_>>()
    };
    let notes = |count: usize, summary: &str| {
        (0..count)
            .map(|_| note(EvidenceKind::BeforeRoleModelCall, summary))
            .collect::<Vec<_>>()
    };
    let answer = |output: BeforeRoleModelCallOutput| async move {
        let host = host_of(vec![(
            Spec::new("answer"),
            Arc::new(Scripted {
                before: output,
                ..Scripted::default()
            }),
        )]);

        prepared(host.before_role_model_call(&turn()).await)
    };
    let refusal = |prepared: &PreparedContext| {
        assert!(prepared.context_items.is_empty(), "{prepared:?}");
        prepared.evidence.last().unwrap().summary().to_owned()
    };

    assert_eq!(
        answer(BeforeRoleModelCallOutput {
            context_items: items(64),
            evidence: notes(64, "Answered."),
            ..BeforeRoleModelCallOutput::default()
        })
        .await
        .context_items
        .len(),
        64
    );

    for (output, kept, summary) in [
        (
            BeforeRoleModelCallOutput {
                context_items: items(65),
                ..BeforeRoleModelCallOutput::default()
            },
            0,
            "contextItems exceed the 64-record limit.",
        ),
        (
            BeforeRoleModelCallOutput {
                evidence: notes(65, "Answered."),
                ..BeforeRoleModelCallOutput::default()
            },
            0,
            "evidence exceeds the 64-record limit.",
        ),
        (
            BeforeRoleModelCallOutput {
                context_items: vec![ContextItem::new(
                    id("blank"),
                    ContextItemKind::Resource,
                    " ",
                )],
                ..BeforeRoleModelCallOutput::default()
            },
            0,
            "a plugin context item's text must not be blank",
        ),
        (
            BeforeRoleModelCallOutput {
                evidence: notes(5, &"x".repeat(14 * 1_024)),
                ..BeforeRoleModelCallOutput::default()
            },
            0,
            "Plugin beforeRoleModelCall result exceeds the aggregate JSON text limit",
        ),
        (
            BeforeRoleModelCallOutput {
                context_items: items(1),
                evidence: vec![EvidenceNote::new(
                    EvidenceKind::BeforeRoleModelCall,
                    EvidenceStatus::Failed,
                    "The backend is down.",
                )],
                ..BeforeRoleModelCallOutput::default()
            },
            1,
            "Plugin \"answer\" accepted beforeRoleModelCall result included blocking \
             before-role-model evidence.",
        ),
    ] {
        let prepared = answer(output).await;

        assert_eq!(
            refusal(&prepared),
            format!("Optional before-role-model plugin hook degraded: {summary}")
        );
        assert_eq!(prepared.evidence.len(), kept + 1, "{summary}");
    }
}
