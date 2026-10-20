//! `handleToolCall`: a model's call routed to the plugin that provides its
//! tool, its input held to the tool's contract, and what the plugin answers
//! held to the output boundary. An approval-gated call is prepared first,
//! which changes nothing, and its effect is applied only on the person's
//! yes. A call never fails the turn: every failure is a rejected result the
//! model reads, and the plugin's `handleToolCall` policy decides only how
//! that is recorded.

use futures_util::future::join_all;
use p02_contracts::{
    Evidence, EvidenceKind, EvidenceNote, EvidenceStatus, HandleToolCallFailure, Hook,
    PolicyOutcome, PreparedEffect, ProvidedTool, ToolCall, ToolCallOutcome, ToolCallResult,
    ToolConcurrency, ToolPreparation,
};
use p02_shared::{Credentials, JsonLimits, bound_json, bound_json_object};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::boundary::{described, quoted, within_answer_limits};
use crate::confirmation::{ConfirmationDecision, ConfirmationRequest};
use crate::host::{Core, PluginHost, Slot};
use crate::invoke::{FailureKind, HookFailure, Invocation};
use crate::turn::Turn;

/// What one tool call came to: what the model reads, and the records the
/// call made.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolCallReport {
    pub result: ToolCallResult,
    pub evidence: Vec<Evidence>,
}

#[derive(Serialize)]
struct Answer<'a> {
    result: &'a ToolCallResult,
    evidence: &'a [Evidence],
}

#[derive(Serialize)]
struct PreparedAnswer<'a> {
    preview: &'a Map<String, Value>,
    evidence: &'a [Evidence],
}

/// A prepared call the output boundary let through: what the person is
/// shown, the effect their yes applies, and the preparation's records.
struct Prepared {
    preview: Map<String, Value>,
    effect: Box<dyn PreparedEffect>,
    evidence: Vec<Evidence>,
}

impl PluginHost {
    /// Runs one model round's tool calls. Admission follows the model's
    /// order: consecutive shared calls overlap, an exclusive call runs
    /// alone, and no call overtakes an earlier one, so an exclusive call is
    /// never starved. The reports come back in call order.
    pub async fn handle_tool_calls(
        &self,
        calls: Vec<ToolCall>,
        turn: &Turn,
    ) -> Vec<ToolCallReport> {
        let core = self.core();
        let mut reports = Vec::with_capacity(calls.len());
        let mut shared = Vec::new();

        for call in calls {
            if core.concurrency(&call) == ToolConcurrency::Shared {
                shared.push(call);
            } else {
                reports.extend(
                    join_all(shared.drain(..).map(|call| core.tool_call(call, turn))).await,
                );
                reports.push(core.tool_call(call, turn).await);
            }
        }

        reports.extend(join_all(shared.into_iter().map(|call| core.tool_call(call, turn))).await);
        reports
    }
}

impl Core {
    /// A call the host cannot route runs alone.
    fn concurrency(&self, call: &ToolCall) -> ToolConcurrency {
        self.route(call.tool_name().as_str())
            .map_or(ToolConcurrency::Exclusive, |(_, tool)| tool.concurrency())
    }

    async fn tool_call(&self, call: ToolCall, turn: &Turn) -> ToolCallReport {
        let Some((slot, tool)) = self.route(call.tool_name().as_str()) else {
            return ToolCallReport {
                result: ToolCallResult::Rejected {
                    reason: "tool_not_declared".to_owned(),
                    message: format!(
                        "Tool \"{}\" is not declared for this turn.",
                        call.tool_name()
                    ),
                },
                evidence: Vec::new(),
            };
        };

        if let Err(rejection) = tool.input_contract().validate(tool.name(), call.input()) {
            let (status, outcome) = slot.failure_record(FailureKind::Exception);

            return slot.refusal(
                turn,
                "invalid_input",
                &rejection.sentence(),
                status,
                outcome,
            );
        }

        if tool.is_approval_gated() {
            return self.approval_gated_call(slot, tool, call, turn).await;
        }

        let plugin = slot.live();
        let answered = slot
            .invoke(Hook::HandleToolCall, turn, move |context| async move {
                plugin.handle_tool_call(&call, &context).await
            })
            .await;

        slot.tool_answer(turn, tool, answered)
    }

    /// Prepares an approval-gated call, shows the person what it would do,
    /// and applies its effect, under a budget of its own, only on their
    /// yes; a tool nobody can be asked about is never prepared. The
    /// preparation and the effect each answer through the output boundary
    /// on their own, and the host's records come on top: the call records
    /// the preparation, then the person's answer, then the effect.
    async fn approval_gated_call(
        &self,
        slot: &Slot,
        tool: &ProvidedTool,
        call: ToolCall,
        turn: &Turn,
    ) -> ToolCallReport {
        let plugin_id = slot.manifest.id();
        let Some(confirmer) = &self.confirmer else {
            return slot.refusal(
                turn,
                "tool_not_routable",
                &format!(
                    "Plugin \"{plugin_id}\" tool \"{}\" requires an unavailable confirmation \
                     handler.",
                    tool.name()
                ),
                EvidenceStatus::Rejected,
                PolicyOutcome::DisallowedToolCall,
            );
        };
        let call_id = call.call_id().clone();
        let Prepared {
            preview,
            effect,
            mut evidence,
        } = match slot.prepare(tool, call, turn).await {
            Ok(prepared) => prepared,
            Err(unasked) => return unasked,
        };
        let request = ConfirmationRequest {
            turn: turn.identity().clone(),
            plugin_id: plugin_id.clone(),
            tool_name: tool.name().clone(),
            call_id,
            summary: tool.description().to_owned(),
            preview,
        };
        let decision = tokio::select! {
            decision = confirmer.confirm(request) => decision,
            () = turn.cancellation().cancelled() => ConfirmationDecision::Cancelled,
        };
        let refused = |reason, message: String| {
            slot.refusal(
                turn,
                reason,
                &message,
                EvidenceStatus::Rejected,
                PolicyOutcome::HandlerRejected,
            )
        };
        let decided = match decision {
            ConfirmationDecision::Approved => {
                evidence.push(slot.record(
                    turn,
                    EvidenceKind::Policy,
                    EvidenceStatus::Accepted,
                    &format!(
                        "User approved plugin \"{plugin_id}\" tool \"{}\".",
                        tool.name()
                    ),
                    Some(PolicyOutcome::UserApproved),
                ));

                let applied = slot
                    .invoke(Hook::HandleToolCall, turn, move |context| async move {
                        effect.apply(&context).await
                    })
                    .await;

                slot.tool_answer(turn, tool, applied)
            }
            ConfirmationDecision::Denied => refused(
                "plugin_config_approval_denied",
                format!(
                    "Tool \"{}\" was denied by the user, so it did nothing.",
                    tool.name()
                ),
            ),
            ConfirmationDecision::Cancelled => refused(
                "plugin_config_approval_cancelled",
                format!(
                    "Approval for tool \"{}\" was cancelled, so it did nothing.",
                    tool.name()
                ),
            ),
        };

        evidence.extend(decided.evidence);
        ToolCallReport {
            result: decided.result,
            evidence,
        }
    }
}

impl Slot {
    /// Prepares an approval-gated call only reading, its store read-only and
    /// no database open to it: what the person is to be asked about, or the
    /// report of a call that ends unasked.
    async fn prepare(
        &self,
        tool: &ProvidedTool,
        call: ToolCall,
        turn: &Turn,
    ) -> Result<Prepared, ToolCallReport> {
        let plugin = self.live();
        let prepared = self
            .invoke(Invocation::Preparation, turn, move |context| async move {
                plugin.prepare_tool_call(&call, &context).await
            })
            .await;

        match prepared {
            Ok(preparation) => self.accept_preparation(turn, tool, preparation),
            Err(failure) => Err(self.tool_failure(turn, &failure)),
        }
    }

    /// What a tool's answer comes to once held to the output boundary, and
    /// a failure, or an answer that breaks the contract, refused by the
    /// plugin's policy.
    fn tool_answer(
        &self,
        turn: &Turn,
        tool: &ProvidedTool,
        answered: Result<ToolCallOutcome, HookFailure>,
    ) -> ToolCallReport {
        match answered.map(|outcome| self.accept_tool_answer(turn, tool, outcome)) {
            Ok(Ok(report)) => report,
            Ok(Err(breach)) => self.tool_failure(turn, &HookFailure::breach(breach)),
            Err(failure) => self.tool_failure(turn, &failure),
        }
    }

    /// Holds a tool's answer to the output boundary: its output within the
    /// JSON limits with every credential-named value redacted, a rejection
    /// that says why, and its records within theirs.
    fn accept_tool_answer(
        &self,
        turn: &Turn,
        tool: &ProvidedTool,
        outcome: ToolCallOutcome,
    ) -> Result<ToolCallReport, String> {
        let (result, notes) = match outcome {
            ToolCallOutcome::Accepted { output, evidence } => {
                let output = bound_json(
                    output,
                    "Plugin tool output",
                    JsonLimits::default(),
                    Credentials::Redact,
                )
                .map_err(|error| described(&error))?;

                (ToolCallResult::Accepted { output }, evidence)
            }
            ToolCallOutcome::Rejected {
                reason,
                message,
                evidence,
            } => {
                if reason.trim().is_empty() || message.trim().is_empty() {
                    return Err(
                        "Plugin rejected tool result reason and message must be non-empty."
                            .to_owned(),
                    );
                }

                (ToolCallResult::Rejected { reason, message }, evidence)
            }
        };
        let blocking = notes.iter().any(EvidenceNote::blocks_tool_invocation);
        let explained = notes.iter().any(explains_rejection);
        let mut evidence = self.stamp_all(turn, notes)?;

        within_answer_limits(
            &Answer {
                result: &result,
                evidence: &evidence,
            },
            Hook::HandleToolCall,
        )?;

        let result = match result {
            ToolCallResult::Accepted { .. } if blocking => self.blocked(tool, "accepted result"),
            ToolCallResult::Rejected { ref message, .. } if !explained => {
                let (status, outcome) = self.failure_record(FailureKind::Exception);

                evidence.push(self.record(
                    turn,
                    EvidenceKind::ToolInvocation,
                    status,
                    message,
                    Some(outcome),
                ));
                result
            }
            result => result,
        };

        Ok(ToolCallReport { result, evidence })
    }

    /// Holds a preparation to the output boundary as a tool's answer is
    /// held: its preview within the JSON limits with every credential-named
    /// value redacted, and its records within theirs. A call the tool
    /// refused ends unasked, and so does one whose preparation breaks the
    /// contract or whose own records say it was refused or failed.
    fn accept_preparation(
        &self,
        turn: &Turn,
        tool: &ProvidedTool,
        preparation: ToolPreparation,
    ) -> Result<Prepared, ToolCallReport> {
        let (preview, effect, notes) = match preparation {
            ToolPreparation::Prepared {
                preview,
                effect,
                evidence,
            } => (preview, effect, evidence),
            ToolPreparation::Rejected {
                reason,
                message,
                evidence,
            } => {
                return Err(self.tool_answer(
                    turn,
                    tool,
                    Ok(ToolCallOutcome::Rejected {
                        reason,
                        message,
                        evidence,
                    }),
                ));
            }
        };
        let breach = |message| self.tool_failure(turn, &HookFailure::breach(message));
        let preview = bound_json_object(
            Value::Object(preview),
            "Plugin tool preview",
            JsonLimits::default(),
            Credentials::Redact,
        )
        .map_err(|error| breach(described(&error)))?;
        let blocking = notes.iter().any(EvidenceNote::blocks_tool_invocation);
        let evidence = self.stamp_all(turn, notes).map_err(breach)?;

        within_answer_limits(
            &PreparedAnswer {
                preview: &preview,
                evidence: &evidence,
            },
            Hook::HandleToolCall,
        )
        .map_err(breach)?;

        if blocking {
            return Err(ToolCallReport {
                result: self.blocked(tool, "prepared call"),
                evidence,
            });
        }

        Ok(Prepared {
            preview,
            effect,
            evidence,
        })
    }

    /// The refusal of an answer that stands as accepted while one of its
    /// own records says the call was refused or failed.
    fn blocked(&self, tool: &ProvidedTool, answer: &str) -> ToolCallResult {
        ToolCallResult::Rejected {
            reason: "blocking_tool_invocation_evidence".to_owned(),
            message: format!(
                "Plugin \"{}\" tool \"{}\" {answer} included blocking tool invocation evidence.",
                self.manifest.id(),
                tool.name()
            ),
        }
    }

    fn tool_failure(&self, turn: &Turn, failure: &HookFailure) -> ToolCallReport {
        let reason = match failure.kind {
            FailureKind::Timeout => "handler_timeout",
            FailureKind::Exception => "handler_failed",
        };
        let (status, outcome) = self.failure_record(failure.kind);

        self.refusal(turn, reason, &failure.message, status, outcome)
    }

    /// How the plugin's `handleToolCall` policy records a call that failed.
    fn failure_record(&self, kind: FailureKind) -> (EvidenceStatus, PolicyOutcome) {
        let degrades = self
            .manifest
            .runtime_policy()
            .failure_behavior()
            .handle_tool_call()
            == HandleToolCallFailure::Degrade;

        match (kind, degrades) {
            (FailureKind::Timeout, true) => (EvidenceStatus::Degraded, PolicyOutcome::Timeout),
            (FailureKind::Timeout, false) => (EvidenceStatus::Failed, PolicyOutcome::Timeout),
            (FailureKind::Exception, true) => {
                (EvidenceStatus::Degraded, PolicyOutcome::OptionalDegraded)
            }
            (FailureKind::Exception, false) => {
                (EvidenceStatus::Rejected, PolicyOutcome::HandlerRejected)
            }
        }
    }

    /// A call the host refuses, recorded as the refusal it is; what the
    /// model reads of it is cut like any host record, so a plugin's own
    /// words never put the report past the limits.
    fn refusal(
        &self,
        turn: &Turn,
        reason: &str,
        message: &str,
        status: EvidenceStatus,
        outcome: PolicyOutcome,
    ) -> ToolCallReport {
        let message = quoted(message).into_owned();

        ToolCallReport {
            evidence: vec![self.record(
                turn,
                EvidenceKind::ToolInvocation,
                status,
                &message,
                Some(outcome),
            )],
            result: ToolCallResult::Rejected {
                reason: reason.to_owned(),
                message,
            },
        }
    }
}

/// A note that already says why a call was rejected, so the host adds none.
fn explains_rejection(note: &EvidenceNote) -> bool {
    note.kind() == EvidenceKind::ToolInvocation
        && (matches!(
            note.status(),
            EvidenceStatus::Rejected | EvidenceStatus::Failed | EvidenceStatus::Degraded
        ) || note.policy_outcome() == Some(PolicyOutcome::OptionalDegraded))
}
