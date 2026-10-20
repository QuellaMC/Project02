//! `handleToolCall`: a model's call routed to the plugin that provides its
//! tool, its input held to the tool's contract, an approval-gated tool
//! asked of the person first, and the plugin's answer held to the output
//! boundary. A call never fails the turn: every failure is a rejected
//! result the model reads, and the plugin's `handleToolCall` policy decides
//! only how that is recorded.

use futures_util::future::join_all;
use p02_contracts::{
    Evidence, EvidenceKind, EvidenceNote, EvidenceStatus, HandleToolCallFailure, Hook,
    PolicyOutcome, ProvidedTool, ToolCall, ToolCallOutcome, ToolCallResult, ToolConcurrency,
};
use p02_shared::{Credentials, JsonLimits, bound_json, bound_json_object};
use serde::Serialize;
use serde_json::Value;

use crate::boundary::{described, quoted, within_answer_limits};
use crate::confirmation::{ConfirmationDecision, ConfirmationRequest};
use crate::host::{Core, PluginHost, Slot};
use crate::invoke::{FailureKind, HookFailure};
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

        let approval = if tool.is_approval_gated() {
            match self.ask(slot, tool, &call, turn).await {
                Ok(approval) => Some(approval),
                Err(refusal) => return refusal,
            }
        } else {
            None
        };
        let answered = slot
            .invoke(
                slot.live(),
                Hook::HandleToolCall,
                turn,
                move |plugin, context| async move { plugin.handle_tool_call(&call, &context).await },
            )
            .await;
        let mut report = match answered.map(|outcome| slot.accept_tool_answer(turn, tool, outcome))
        {
            Ok(Ok(report)) => report,
            Ok(Err(breach)) => slot.tool_failure(turn, &HookFailure::breach(breach)),
            Err(failure) => slot.tool_failure(turn, &failure),
        };

        report.evidence.splice(0..0, approval);
        report
    }

    /// Asks the person before an approval-gated tool runs: a yes is the
    /// record that it may, anything else a refusal, and a tool nobody can
    /// be asked about never runs.
    async fn ask(
        &self,
        slot: &Slot,
        tool: &ProvidedTool,
        call: &ToolCall,
        turn: &Turn,
    ) -> Result<Evidence, ToolCallReport> {
        let plugin_id = slot.manifest.id();
        let Some(confirmer) = &self.confirmer else {
            return Err(slot.refusal(
                turn,
                "tool_not_routable",
                &format!(
                    "Plugin \"{plugin_id}\" tool \"{}\" requires an unavailable confirmation \
                     handler.",
                    tool.name()
                ),
                EvidenceStatus::Rejected,
                PolicyOutcome::DisallowedToolCall,
            ));
        };
        let request = ConfirmationRequest {
            turn: turn.identity().clone(),
            plugin_id: plugin_id.clone(),
            tool_name: tool.name().clone(),
            call_id: call.call_id().clone(),
            summary: tool.description().to_owned(),
            input: bound_json_object(
                Value::Object(call.input().clone()),
                "Confirmation input",
                JsonLimits::default(),
                Credentials::Redact,
            )
            .expect("an input its contract admitted is within the JSON limits"),
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

        match decision {
            ConfirmationDecision::Approved => Ok(slot.record(
                turn,
                EvidenceKind::Policy,
                EvidenceStatus::Accepted,
                &format!(
                    "User approved plugin \"{plugin_id}\" tool \"{}\".",
                    tool.name()
                ),
                Some(PolicyOutcome::UserApproved),
            )),
            ConfirmationDecision::Denied => Err(refused(
                "plugin_config_approval_denied",
                format!(
                    "Tool \"{}\" was denied by the user, so it did nothing.",
                    tool.name()
                ),
            )),
            ConfirmationDecision::Cancelled => Err(refused(
                "plugin_config_approval_cancelled",
                format!(
                    "Approval for tool \"{}\" was cancelled, so it did nothing.",
                    tool.name()
                ),
            )),
        }
    }
}

impl Slot {
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
            ToolCallResult::Accepted { .. } if blocking => ToolCallResult::Rejected {
                reason: "blocking_tool_invocation_evidence".to_owned(),
                message: format!(
                    "Plugin \"{}\" tool \"{}\" accepted result included blocking tool \
                     invocation evidence.",
                    self.manifest.id(),
                    tool.name()
                ),
            },
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
