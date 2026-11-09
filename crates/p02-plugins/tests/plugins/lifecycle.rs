//! The hooks that follow what happened, and the plugins' end.

use std::sync::Arc;
use std::time::Duration;

use p02_contracts::{
    CommittedTurn, Evidence, EvidenceKind, EvidenceNote, EvidenceStatus, HookReport, HookStatus,
    PolicyOutcome,
};
use p02_core::Timestamp;
use p02_plugins::PhaseStatus;
use serde_json::json;

use crate::storage::Storage;
use crate::support::{
    Enable, Failing, Hanging, Panicking, Scripted, Spec, Stalling, builder, host_of, note, turn,
};

fn committed() -> CommittedTurn {
    CommittedTurn::new(Timestamp::new("2026-10-18T00:00:01.000Z").unwrap())
}

/// The after-turn hooks' failures, timeouts and panics are collected and
/// reported with the phase, never thrown.
#[tokio::test(start_paused = true)]
async fn after_turn_failures_are_collected_and_reported_never_thrown() {
    let after = |id| Spec {
        declared: json!(["after_turn_committed"]),
        timeout_ms: 50,
        ..Spec::new(id)
    };
    let reporting = Arc::new(Scripted {
        report: Some(HookReport {
            status: HookStatus::Failed,
            evidence: Vec::new(),
        }),
        ..Scripted::default()
    });
    let clean = Arc::new(Scripted {
        report: Some(HookReport {
            status: HookStatus::Completed,
            evidence: vec![note(EvidenceKind::AfterTurnCommitted, "Indexed the turn.")],
        }),
        ..Scripted::default()
    });
    let host = host_of(vec![
        (after("failing"), Arc::new(Failing)),
        (after("hanging"), Arc::new(Hanging::default())),
        (after("panicking"), Arc::new(Panicking)),
        (after("reporting"), Arc::clone(&reporting) as _),
        (after("clean"), Arc::clone(&clean) as _),
    ]);
    let report = host.after_turn_committed(&turn(), &committed()).await;
    let records: Vec<_> = report
        .evidence
        .iter()
        .map(|record| {
            (
                record.plugin_id().as_str(),
                record.status(),
                record.summary(),
                record.policy_outcome(),
            )
        })
        .collect();

    assert_eq!(report.status, PhaseStatus::CompletedWithFailures);
    assert_eq!(
        records,
        [
            (
                "failing",
                EvidenceStatus::Failed,
                "afterTurnCommitted plugin hook failed: backend unreachable",
                Some(PolicyOutcome::AfterCommitFailed)
            ),
            (
                "hanging",
                EvidenceStatus::Failed,
                "afterTurnCommitted plugin hook failed: Plugin \"hanging\" afterTurnCommitted \
                 timed out after 50ms.",
                Some(PolicyOutcome::Timeout)
            ),
            (
                "panicking",
                EvidenceStatus::Failed,
                "afterTurnCommitted plugin hook failed: Plugin hook panicked: index out of bounds",
                Some(PolicyOutcome::AfterCommitFailed)
            ),
            (
                "reporting",
                EvidenceStatus::Failed,
                "afterTurnCommitted plugin hook reported failure.",
                Some(PolicyOutcome::AfterCommitFailed)
            ),
            ("clean", EvidenceStatus::Accepted, "Indexed the turn.", None),
        ]
    );
    assert_eq!(clean.calls(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_report_its_own_record_says_failed_fails_its_phase() {
    let report = host_of(vec![(
        Spec {
            declared: json!(["after_turn_committed"]),
            ..Spec::new("contradicting")
        },
        Arc::new(Scripted {
            report: Some(HookReport {
                status: HookStatus::Completed,
                evidence: vec![EvidenceNote::new(
                    EvidenceKind::AfterTurnCommitted,
                    EvidenceStatus::Failed,
                    "The index was out of reach.",
                )],
            }),
            ..Scripted::default()
        }),
    )])
    .after_turn_committed(&turn(), &committed())
    .await;

    assert_eq!(report.status, PhaseStatus::CompletedWithFailures);
    assert_eq!(
        report
            .evidence
            .iter()
            .map(Evidence::summary)
            .collect::<Vec<_>>(),
        ["The index was out of reach."],
        "the plugin's own record says why, so the host adds none"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shutdown_never_waits_on_a_blocking_job() {
    let (stalling, gate, job_ended) = Stalling::new(Vec::new());
    let host = builder(Storage::new())
        .enable(
            &Spec {
                declared: json!(["after_turn_committed", "on_shutdown"]),
                timeout_ms: 50,
                access: json!({"character_file_store": "write"}),
                ..Spec::new("indexer")
            },
            stalling,
        )
        .activate()
        .unwrap();
    let report = host.after_turn_committed(&turn(), &committed()).await;

    assert_eq!(
        report.evidence[0].policy_outcome(),
        Some(PolicyOutcome::Timeout)
    );

    let started = std::time::Instant::now();
    let ended = tokio::time::timeout(Duration::from_secs(5), host.shutdown())
        .await
        .expect("shutdown does not wait on the job");
    let mut job_ended = job_ended;

    assert_eq!(ended.status, PhaseStatus::Completed);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
    assert!(job_ended.try_recv().is_err(), "the job still runs");

    gate.open();
    tokio::time::timeout(Duration::from_secs(10), job_ended)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
}
