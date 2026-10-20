//! The health gate: before a turn commits, every plugin that declares a
//! health check says whether it can serve it. A plugin that is not ok
//! degrades the turn, and rejects it when its health failure behavior is
//! `reject_turn`.

use p02_contracts::{
    Declaration, Evidence, EvidenceKind, EvidenceStatus, HEALTH_REJECTION, HealthFailure,
    HealthReport, HealthSnapshot, HealthStatus, Hook, PolicyOutcome,
};
use p02_shared::Identifier;

use crate::boundary::described;
use crate::host::{PluginHost, Slot};
use crate::invoke::{FailureKind, HookFailure};
use crate::text::excerpt;
use crate::turn::Turn;

/// How much of a failure an unavailable plugin's snapshot repeats.
const SUMMARY_CHARS: usize = 1_024;

/// What the health gate found.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HealthCheck {
    pub snapshots: Vec<HealthSnapshot>,
    pub evidence: Vec<Evidence>,
    /// The first plugin whose health rejects the turn, if one does.
    pub rejection: Option<HealthRejection>,
}

/// A turn rejected by a plugin's health, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HealthRejection {
    pub plugin_id: Identifier,
    pub message: String,
}

impl HealthRejection {
    /// The reason the turn records.
    #[must_use]
    pub fn reason(&self) -> &'static str {
        HEALTH_REJECTION
    }
}

impl PluginHost {
    /// Asks every plugin that declares a health check, in the host's order.
    pub async fn health(&self, turn: &Turn) -> HealthCheck {
        let mut check = HealthCheck::default();

        for slot in self.core().declaring(Declaration::Health) {
            let (snapshot, record) = slot.check_health(turn).await;

            if let Some(record) = record {
                if check.rejection.is_none() && slot.health_rejects() {
                    check.rejection = Some(HealthRejection {
                        plugin_id: slot.manifest.id().clone(),
                        message: record.summary().to_owned(),
                    });
                }

                check.evidence.push(record);
            }

            check.snapshots.push(snapshot);
        }

        check
    }
}

impl Slot {
    fn health_rejects(&self) -> bool {
        self.manifest.runtime_policy().failure_behavior().health() == HealthFailure::RejectTurn
    }

    /// The plugin's snapshot, and the record of a plugin that is not ok.
    async fn check_health(&self, turn: &Turn) -> (HealthSnapshot, Option<Evidence>) {
        let checked = self
            .invoke(
                self.live(),
                Hook::Health,
                turn,
                |plugin, context| async move { plugin.health(&context).await },
            )
            .await
            .and_then(|report| {
                HealthSnapshot::new(
                    self.manifest.id().clone(),
                    turn.identity().event.created_at().clone(),
                    report,
                    self.labels(turn),
                )
                .map_err(|error| HookFailure::breach(described(&error)))
            });

        match checked {
            Ok(snapshot) if snapshot.status() == HealthStatus::Ok => (snapshot, None),
            Ok(snapshot) => {
                let status =
                    if snapshot.status() == HealthStatus::Unavailable && self.health_rejects() {
                        EvidenceStatus::Failed
                    } else {
                        EvidenceStatus::Degraded
                    };
                let record = self.record(
                    turn,
                    EvidenceKind::Health,
                    status,
                    &format!(
                        "Plugin health {}: {}",
                        snapshot.status(),
                        snapshot.summary()
                    ),
                    Some(PolicyOutcome::HealthDegraded),
                );

                (snapshot, Some(record))
            }
            Err(failure) => {
                let snapshot = HealthSnapshot::new(
                    self.manifest.id().clone(),
                    turn.identity().event.created_at().clone(),
                    HealthReport {
                        status: HealthStatus::Unavailable,
                        summary: excerpt(&failure.message, SUMMARY_CHARS).into_owned(),
                    },
                    self.labels(turn),
                )
                .expect(
                    "a failure says something, within the limits once it is cut and its labels \
                     were held where they entered",
                );
                let record = self.record(
                    turn,
                    EvidenceKind::Health,
                    if self.health_rejects() {
                        EvidenceStatus::Failed
                    } else {
                        EvidenceStatus::Degraded
                    },
                    &format!("Plugin health hook failed: {}", failure.message),
                    Some(match failure.kind {
                        FailureKind::Timeout => PolicyOutcome::Timeout,
                        FailureKind::Exception => PolicyOutcome::HealthDegraded,
                    }),
                );

                (snapshot, Some(record))
            }
        }
    }
}
