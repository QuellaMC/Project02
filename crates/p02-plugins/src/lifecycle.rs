//! The hooks that follow what already happened: `afterTurnCommitted`,
//! `onSessionEnd` and `onShutdown`. Each runs for every plugin that
//! declares it, in the host's order, and a failure is collected and
//! reported, never thrown: it undoes nothing, and the next plugin runs.

use p02_contracts::{
    CommittedTurn, Evidence, EvidenceKind, EvidenceStatus, Hook, HookReport, HookStatus,
    PolicyOutcome,
};

use crate::boundary::within_answer_limits;
use crate::host::{Core, PluginHost, Slot};
use crate::invoke::{FailureKind, HookFailure};
use crate::turn::Turn;

/// How a phase of hooks ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhaseStatus {
    Completed,
    /// At least one plugin failed or said its work did not finish.
    CompletedWithFailures,
}

/// What a phase of hooks recorded.
#[derive(Clone, Debug, PartialEq)]
pub struct HookPhaseReport {
    pub status: PhaseStatus,
    pub evidence: Vec<Evidence>,
}

pub(crate) enum Lifecycle {
    AfterTurnCommitted(CommittedTurn),
    SessionEnd,
    Shutdown,
}

impl Lifecycle {
    fn hook(&self) -> Hook {
        match self {
            Self::AfterTurnCommitted(_) => Hook::AfterTurnCommitted,
            Self::SessionEnd => Hook::OnSessionEnd,
            Self::Shutdown => Hook::OnShutdown,
        }
    }

    fn evidence_kind(&self) -> EvidenceKind {
        match self {
            Self::AfterTurnCommitted(_) => EvidenceKind::AfterTurnCommitted,
            Self::SessionEnd => EvidenceKind::SessionEnd,
            Self::Shutdown => EvidenceKind::Shutdown,
        }
    }

    /// The rule a failure of this phase is recorded under, when one is.
    fn failure_outcome(&self, kind: FailureKind) -> Option<PolicyOutcome> {
        match (self, kind) {
            (_, FailureKind::Timeout) => Some(PolicyOutcome::Timeout),
            (Self::AfterTurnCommitted(_), FailureKind::Exception) => {
                Some(PolicyOutcome::AfterCommitFailed)
            }
            (Self::SessionEnd | Self::Shutdown, FailureKind::Exception) => None,
        }
    }
}

impl PluginHost {
    /// Runs every declared `afterTurnCommitted` for a turn that is already
    /// durable. Its messages reach only the plugins granted
    /// `turn_context: read`.
    pub async fn after_turn_committed(
        &self,
        turn: &Turn,
        committed: &CommittedTurn,
    ) -> HookPhaseReport {
        self.core()
            .run_lifecycle(&Lifecycle::AfterTurnCommitted(committed.clone()), turn)
            .await
    }

    /// Runs every declared `onSessionEnd` for a session that ended.
    pub async fn session_end(&self, turn: &Turn) -> HookPhaseReport {
        self.core()
            .run_lifecycle(&Lifecycle::SessionEnd, turn)
            .await
    }
}

impl Core {
    pub(crate) async fn run_lifecycle(
        &self,
        lifecycle: &Lifecycle,
        turn: &Turn,
    ) -> HookPhaseReport {
        let hook = lifecycle.hook();
        let kind = lifecycle.evidence_kind();
        let mut status = PhaseStatus::Completed;
        let mut evidence = Vec::new();

        for slot in self.declaring(hook.declaration()) {
            let failure = |failure_kind, summary: &str| {
                slot.record(
                    turn,
                    kind,
                    EvidenceStatus::Failed,
                    summary,
                    lifecycle.failure_outcome(failure_kind),
                )
            };

            match slot.lifecycle_hook(lifecycle, turn).await {
                Err(failed) => {
                    status = PhaseStatus::CompletedWithFailures;
                    evidence.push(failure(
                        failed.kind,
                        &format!("{} plugin hook failed: {}", hook.name(), failed.message),
                    ));
                }
                Ok((HookStatus::Completed, records)) => evidence.extend(records),
                Ok((HookStatus::Failed, records)) => {
                    let recorded = records.iter().any(|record| {
                        record.kind() == kind && record.status() == EvidenceStatus::Failed
                    });

                    status = PhaseStatus::CompletedWithFailures;
                    evidence.extend(records);

                    if !recorded {
                        evidence.push(failure(
                            FailureKind::Exception,
                            &format!("{} plugin hook reported failure.", hook.name()),
                        ));
                    }
                }
            }
        }

        HookPhaseReport { status, evidence }
    }
}

impl Slot {
    async fn lifecycle_hook(
        &self,
        lifecycle: &Lifecycle,
        turn: &Turn,
    ) -> Result<(HookStatus, Vec<Evidence>), HookFailure> {
        let hook = lifecycle.hook();
        let plugin = self.live();
        let report = match lifecycle {
            Lifecycle::AfterTurnCommitted(committed) => {
                let committed = if self.capabilities.turn_text {
                    committed.clone()
                } else {
                    CommittedTurn::new(committed.committed_at().clone())
                };

                self.invoke(plugin, hook, turn, |plugin, context| async move {
                    plugin.after_turn_committed(&committed, &context).await
                })
                .await
            }
            Lifecycle::SessionEnd => {
                self.invoke(plugin, hook, turn, |plugin, context| async move {
                    plugin.on_session_end(&context).await
                })
                .await
            }
            Lifecycle::Shutdown => {
                self.invoke(plugin, hook, turn, |plugin, context| async move {
                    plugin.on_shutdown(&context).await
                })
                .await
            }
        }?;

        self.accept_report(turn, hook, report)
            .map_err(HookFailure::breach)
    }

    fn accept_report(
        &self,
        turn: &Turn,
        hook: Hook,
        report: HookReport,
    ) -> Result<(HookStatus, Vec<Evidence>), String> {
        let records = self.stamp_all(turn, report.evidence)?;

        within_answer_limits(&records, hook)?;
        Ok((report.status, records))
    }
}
