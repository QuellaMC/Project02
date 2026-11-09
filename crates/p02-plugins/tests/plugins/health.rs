//! The health gate, before a turn commits.

use std::sync::Arc;

use p02_contracts::{EvidenceStatus, HealthReport, HealthStatus, PolicyOutcome, RuntimePlugin};
use p02_plugins::HealthRejection;
use serde_json::json;

use crate::support::{Failing, Hanging, Scripted, Spec, host_of, turn};

fn checking(id: &'static str, policy: &'static str) -> Spec {
    Spec {
        declared: json!(["health"]),
        timeout_ms: 50,
        health: policy,
        ..Spec::new(id)
    }
}

fn reporting(status: HealthStatus, summary: &str) -> Arc<dyn RuntimePlugin> {
    Arc::new(Scripted {
        health: Some(HealthReport {
            status,
            summary: summary.to_owned(),
        }),
        ..Scripted::default()
    })
}

/// A plugin whose health is unavailable under `reject_turn` rejects the turn
/// with its reason; every other report, a failed or a timed-out check among
/// them, is recorded by its policy and rejects nothing.
#[tokio::test(start_paused = true)]
async fn a_plugin_whose_health_rejects_the_turn_rejects_it_with_its_reason() {
    let host = host_of(vec![
        (
            checking("index", "degrade"),
            reporting(HealthStatus::Degraded, "Rebuilding the index."),
        ),
        (
            checking("vault", "reject_turn"),
            reporting(HealthStatus::Unavailable, "The vault is locked."),
        ),
        (checking("flaky", "reject_turn"), Arc::new(Failing)),
        (checking("slow", "degrade"), Arc::new(Hanging::default())),
        (
            checking("fine", "reject_turn"),
            Arc::new(Scripted::default()),
        ),
    ]);
    let check = host.health(&turn()).await;
    let records: Vec<_> = check
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

    assert_eq!(
        check.rejection,
        Some(HealthRejection {
            plugin_id: crate::support::id("vault"),
            message: "Plugin health unavailable: The vault is locked.".to_owned(),
        })
    );
    assert_eq!(
        check.rejection.as_ref().map(HealthRejection::reason),
        Some("plugin_health_rejected")
    );
    assert_eq!(
        check
            .snapshots
            .iter()
            .map(|snapshot| (snapshot.plugin_id().as_str(), snapshot.status()))
            .collect::<Vec<_>>(),
        [
            ("index", HealthStatus::Degraded),
            ("vault", HealthStatus::Unavailable),
            ("flaky", HealthStatus::Unavailable),
            ("slow", HealthStatus::Unavailable),
            ("fine", HealthStatus::Ok),
        ]
    );
    assert_eq!(
        records,
        [
            (
                "index",
                EvidenceStatus::Degraded,
                "Plugin health degraded: Rebuilding the index.",
                Some(PolicyOutcome::HealthDegraded)
            ),
            (
                "vault",
                EvidenceStatus::Failed,
                "Plugin health unavailable: The vault is locked.",
                Some(PolicyOutcome::HealthDegraded)
            ),
            (
                "flaky",
                EvidenceStatus::Failed,
                "Plugin health hook failed: backend unreachable",
                Some(PolicyOutcome::HealthDegraded)
            ),
            (
                "slow",
                EvidenceStatus::Degraded,
                "Plugin health hook failed: Plugin \"slow\" health timed out after 50ms.",
                Some(PolicyOutcome::Timeout)
            ),
        ]
    );

    let degraded_only = host_of(vec![(
        checking("index", "degrade"),
        reporting(HealthStatus::Unavailable, "Rebuilding the index."),
    )]);

    assert_eq!(degraded_only.health(&turn()).await.rejection, None);
}
