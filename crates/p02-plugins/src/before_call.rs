//! `beforeRoleModelCall` across the enabled plugins. Plugins run one after
//! another, in the host's order. A plugin that fails, times out or answers
//! past the contract degrades, contributing only its records, or rejects
//! the turn, which ends the phase: later plugins never run.

use p02_contracts::{
    AccessLevel, AccessName, BEFORE_ROLE_MODEL_CALL_REJECTION, BeforeRoleModelCallFailure,
    BeforeRoleModelCallOutput, Declaration, Evidence, EvidenceKind, EvidenceNote, EvidenceStatus,
    Hook, PluginContextItem, PluginCuratedSection, PolicyOutcome, RuntimeNote,
};
use p02_shared::Identifier;
use serde::Serialize;

use crate::boundary::{RECORD_LIMIT, described, within_answer_limits};
use crate::host::{PluginHost, Slot};
use crate::invoke::{FailureKind, HookFailure};
use crate::policy::trusted_context;
use crate::turn::Turn;

/// How the phase ended.
#[derive(Clone, Debug, PartialEq)]
pub enum BeforeCallOutcome {
    /// Every plugin answered or degraded; the model call proceeds.
    Prepared(PreparedContext),
    /// A plugin whose failure rejects the turn failed.
    Rejected(TurnRejection),
}

/// What the plugins contribute to the model call, in the host's order:
/// runtime notes for the trusted frame from the plugins cleared for it,
/// every other item for the untrusted blocks, curated sections, and every
/// record the phase made.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PreparedContext {
    pub runtime_notes: Vec<RuntimeNote>,
    pub context_items: Vec<PluginContextItem>,
    pub curated_sections: Vec<PluginCuratedSection>,
    pub evidence: Vec<Evidence>,
}

/// The turn's rejection by a plugin whose `beforeRoleModelCall` failure
/// rejects it, with every record the phase made up to it.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnRejection {
    pub plugin_id: Identifier,
    pub message: String,
    pub evidence: Vec<Evidence>,
}

impl TurnRejection {
    /// The reason the turn records.
    #[must_use]
    pub fn reason(&self) -> &'static str {
        BEFORE_ROLE_MODEL_CALL_REJECTION
    }
}

/// A plugin's failure that rejects the turn.
struct Rejection {
    message: String,
    evidence: Vec<Evidence>,
}

/// An answer that breaks the contract, and the records it made that stand.
struct Breach {
    message: String,
    evidence: Vec<Evidence>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Answer<'a> {
    context_items: &'a [PluginContextItem],
    curated_sections: &'a [PluginCuratedSection],
    evidence: &'a [Evidence],
}

impl PluginHost {
    /// Runs every declared `beforeRoleModelCall`, in the host's order.
    pub async fn before_role_model_call(&self, turn: &Turn) -> BeforeCallOutcome {
        let mut prepared = PreparedContext::default();

        for slot in self.core().declaring(Declaration::BeforeRoleModelCall) {
            match slot.before_call(turn).await {
                Ok(contribution) => {
                    prepared.runtime_notes.extend(contribution.runtime_notes);
                    prepared.context_items.extend(contribution.context_items);
                    prepared
                        .curated_sections
                        .extend(contribution.curated_sections);
                    prepared.evidence.extend(contribution.evidence);
                }
                Err(rejection) => {
                    prepared.evidence.extend(rejection.evidence);

                    return BeforeCallOutcome::Rejected(TurnRejection {
                        plugin_id: slot.manifest.id().clone(),
                        message: rejection.message,
                        evidence: prepared.evidence,
                    });
                }
            }
        }

        BeforeCallOutcome::Prepared(prepared)
    }
}

impl Slot {
    async fn before_call(&self, turn: &Turn) -> Result<PreparedContext, Rejection> {
        let answered = self
            .invoke(
                self.live(),
                Hook::BeforeRoleModelCall,
                turn,
                |plugin, context| async move { plugin.before_role_model_call(&context).await },
            )
            .await;

        match answered.map(|output| self.accept(turn, output)) {
            Ok(Ok(contribution)) => Ok(contribution),
            Ok(Err(breach)) => {
                self.failed(turn, &HookFailure::breach(breach.message), breach.evidence)
            }
            Err(failure) => self.failed(turn, &failure, Vec::new()),
        }
    }

    /// Holds an answer to the contract. A malformed answer stands for
    /// nothing; one that breaks a rule of access or of the trusted frame
    /// keeps the records it made.
    fn accept(
        &self,
        turn: &Turn,
        output: BeforeRoleModelCallOutput,
    ) -> Result<PreparedContext, Breach> {
        let plugin_id = self.manifest.id();
        let access = self.manifest.requested_access();
        let malformed = |message| Breach {
            message,
            evidence: Vec::new(),
        };
        let blocking = output
            .evidence
            .iter()
            .any(EvidenceNote::blocks_before_role_model_call);
        let evidence = self.stamp_all(turn, output.evidence).map_err(malformed)?;

        if output.context_items.len() > RECORD_LIMIT {
            return Err(malformed(format!(
                "contextItems exceed the {RECORD_LIMIT}-record limit."
            )));
        }

        let items = output
            .context_items
            .into_iter()
            .map(|item| PluginContextItem::new(plugin_id.clone(), item))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| malformed(described(&error)))?;
        let curated_sections = output
            .curated_sections
            .into_iter()
            .map(|section| PluginCuratedSection::new(plugin_id.clone(), section))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| malformed(described(&error)))?;

        within_answer_limits(
            &Answer {
                context_items: &items,
                curated_sections: &curated_sections,
                evidence: &evidence,
            },
            Hook::BeforeRoleModelCall,
        )
        .map_err(malformed)?;

        let refused = |message| Breach {
            message,
            evidence: evidence.clone(),
        };

        if blocking {
            return Err(refused(format!(
                "Plugin \"{plugin_id}\" accepted beforeRoleModelCall result included blocking \
                 before-role-model evidence."
            )));
        }

        if !items.is_empty() && !access.grants(AccessName::ModelInput, AccessLevel::Write) {
            return Err(refused(format!(
                "Plugin \"{plugin_id}\" returned beforeRoleModelCall model input contributions \
                 without declaring model_input write access."
            )));
        }

        if !curated_sections.is_empty()
            && !access.grants(AccessName::TrustedContext, AccessLevel::Write)
        {
            return Err(refused(format!(
                "Plugin \"{plugin_id}\" returned curated context sections without granted \
                 trusted_context write access."
            )));
        }

        let (trusted, context_items): (Vec<_>, Vec<_>) = items
            .into_iter()
            .partition(|item| trusted_context::is_trusted_note(access, item.item()));

        if let Some(message) = trusted_context::cap_breach(plugin_id, &trusted, &curated_sections) {
            return Err(refused(message));
        }

        let runtime_notes = trusted
            .iter()
            .map(|item| {
                RuntimeNote::new(item.item().id().clone(), item.item().text())
                    .map(|note| note.with_plugin(plugin_id.clone()))
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| refused(described(&error)))?;

        Ok(PreparedContext {
            runtime_notes,
            context_items,
            curated_sections,
            evidence,
        })
    }

    /// The plugin's failure policy decides: degrade and go on, or reject
    /// the turn.
    fn failed(
        &self,
        turn: &Turn,
        failure: &HookFailure,
        mut evidence: Vec<Evidence>,
    ) -> Result<PreparedContext, Rejection> {
        let rejects = self
            .manifest
            .runtime_policy()
            .failure_behavior()
            .before_role_model_call()
            == BeforeRoleModelCallFailure::RejectTurn;
        let outcome = match (failure.kind, rejects) {
            (FailureKind::Timeout, _) => PolicyOutcome::Timeout,
            (FailureKind::Exception, true) => PolicyOutcome::RequiredRejected,
            (FailureKind::Exception, false) => PolicyOutcome::OptionalDegraded,
        };
        let (status, summary) = if rejects {
            (
                EvidenceStatus::Rejected,
                format!(
                    "Required before-role-model plugin hook rejected the turn: {}",
                    failure.message
                ),
            )
        } else {
            (
                EvidenceStatus::Degraded,
                format!(
                    "Optional before-role-model plugin hook degraded: {}",
                    failure.message
                ),
            )
        };

        evidence.push(self.record(
            turn,
            EvidenceKind::BeforeRoleModelCall,
            status,
            &summary,
            Some(outcome),
        ));

        if rejects {
            Err(Rejection {
                message: failure.message.clone(),
                evidence,
            })
        } else {
            Ok(PreparedContext {
                evidence,
                ..PreparedContext::default()
            })
        }
    }
}
