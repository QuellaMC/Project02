use std::num::NonZeroU32;

use p02_contracts::{
    BEFORE_ROLE_MODEL_CALL_REJECTION, DecisionRejectionReason, Evidence, HealthSnapshot, ToolCallId,
};
use p02_core::{MessageId, VisibleText};
use serde::{Deserialize, Serialize};

use super::RecordError;

/// How the work of a turn's plugins ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Completed,
    CompletedWithFailures,
}

/// What the turn's plugins reported about their health.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnEvidence {
    pub health: Vec<HealthSnapshot>,
}

/// A turn completed: what it committed and, when the model ran, the
/// verdict on the round it ended on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "WireCompleted", into = "WireCompleted")]
pub struct TurnCompleted {
    pub status: TurnStatus,
    /// The turn's committed messages, in the order they were said.
    pub visible_message_ids: Vec<MessageId>,
    /// The turn's finished tool calls, in the order they finished.
    pub tool_call_ids: Vec<ToolCallId>,
    pub judgement: Option<Judgement>,
    pub runtime_plugin_evidence: Vec<Evidence>,
    pub runtime_plugin_turn_evidence: Option<TurnEvidence>,
}

/// The verdict on the round a completed turn ended on: accepted, anchoring
/// the last reply it said, if it said one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Judgement {
    pub round: NonZeroU32,
    pub accepted_reply: Option<VisibleText>,
}

/// What the plugins did once a completed turn was durable.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AfterTurnCommitted {
    pub status: TurnStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runtime_plugin_evidence: Vec<Evidence>,
}

/// A turn rejected: why, in a sentence, and what it had committed by then.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "WireRejected", into = "WireRejected")]
pub struct TurnRejected {
    rejection: TurnRejection,
    message: String,
    pub visible_message_ids: Vec<MessageId>,
    pub tool_call_ids: Vec<ToolCallId>,
    pub runtime_plugin_evidence: Vec<Evidence>,
    pub runtime_plugin_turn_evidence: Option<TurnEvidence>,
}

/// Who rejected a turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnRejection {
    /// The runtime, before the model judged anything.
    Runtime(RuntimeRejection),
    /// The verdict on the round the turn ended on.
    Judged {
        round: NonZeroU32,
        reason: DecisionRejectionReason,
    },
}

/// A turn the runtime refused before any round judged it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeRejection {
    /// The person's line was not one.
    InputValidationRejected,
    /// A plugin refused the turn before the model was called.
    PluginBeforeRoleModelCallRejected,
    /// The runtime failed before it had a reply.
    RuntimeFailure,
}

impl RuntimeRejection {
    const ALL: [Self; 3] = [
        Self::InputValidationRejected,
        Self::PluginBeforeRoleModelCallRejected,
        Self::RuntimeFailure,
    ];

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InputValidationRejected => "input_validation_rejected",
            Self::PluginBeforeRoleModelCallRejected => BEFORE_ROLE_MODEL_CALL_REJECTION,
            Self::RuntimeFailure => "runtime_failure",
        }
    }
}

impl TurnRejection {
    /// The reason the record names.
    #[must_use]
    pub fn reason(self) -> &'static str {
        match self {
            Self::Runtime(rejection) => rejection.as_str(),
            Self::Judged { reason, .. } => reason.as_str(),
        }
    }

    /// The round the rejection judged, when it judged one.
    #[must_use]
    pub fn round(self) -> Option<NonZeroU32> {
        match self {
            Self::Runtime(_) => None,
            Self::Judged { round, .. } => Some(round),
        }
    }
}

impl TurnRejected {
    /// A turn rejected as `rejection` says, `message` saying why.
    ///
    /// # Errors
    ///
    /// [`RecordError::BlankMessage`] when `message` is blank.
    pub fn new(rejection: TurnRejection, message: String) -> Result<Self, RecordError> {
        if message.trim().is_empty() {
            return Err(RecordError::BlankMessage);
        }

        Ok(Self {
            rejection,
            message,
            visible_message_ids: Vec::new(),
            tool_call_ids: Vec::new(),
            runtime_plugin_evidence: Vec::new(),
            runtime_plugin_turn_evidence: None,
        })
    }

    #[must_use]
    pub fn rejection(&self) -> TurnRejection {
        self.rejection
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireCompleted {
    status: TurnStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    visible_message_ids: Vec<MessageId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tool_call_ids: Vec<ToolCallId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    round: Option<NonZeroU32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    commit_validation: Option<CommitValidation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    runtime_plugin_evidence: Vec<Evidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runtime_plugin_turn_evidence: Option<TurnEvidence>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CommitValidation {
    result: AcceptedCommit,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcceptedCommit {
    status: Accepted,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    accepted_visible_reply_text: Option<VisibleText>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Accepted {
    Accepted,
}

impl TryFrom<WireCompleted> for TurnCompleted {
    type Error = RecordError;

    fn try_from(wire: WireCompleted) -> Result<Self, Self::Error> {
        let judgement = match (wire.round, wire.commit_validation) {
            (None, None) => None,
            (Some(round), Some(validation)) => Some(Judgement {
                round,
                accepted_reply: validation.result.accepted_visible_reply_text,
            }),
            _ => return Err(RecordError::Judgement),
        };

        Ok(Self {
            status: wire.status,
            visible_message_ids: wire.visible_message_ids,
            tool_call_ids: wire.tool_call_ids,
            judgement,
            runtime_plugin_evidence: wire.runtime_plugin_evidence,
            runtime_plugin_turn_evidence: wire.runtime_plugin_turn_evidence,
        })
    }
}

impl From<TurnCompleted> for WireCompleted {
    fn from(completed: TurnCompleted) -> Self {
        let (round, commit_validation) = match completed.judgement {
            Some(judgement) => (
                Some(judgement.round),
                Some(CommitValidation {
                    result: AcceptedCommit {
                        status: Accepted::Accepted,
                        accepted_visible_reply_text: judgement.accepted_reply,
                    },
                }),
            ),
            None => (None, None),
        };

        Self {
            status: completed.status,
            visible_message_ids: completed.visible_message_ids,
            tool_call_ids: completed.tool_call_ids,
            round,
            commit_validation,
            runtime_plugin_evidence: completed.runtime_plugin_evidence,
            runtime_plugin_turn_evidence: completed.runtime_plugin_turn_evidence,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireRejected {
    reason: String,
    message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    visible_message_ids: Vec<MessageId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tool_call_ids: Vec<ToolCallId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    round: Option<NonZeroU32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    runtime_plugin_evidence: Vec<Evidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runtime_plugin_turn_evidence: Option<TurnEvidence>,
}

impl TryFrom<WireRejected> for TurnRejected {
    type Error = RecordError;

    fn try_from(wire: WireRejected) -> Result<Self, Self::Error> {
        let rejection = match (DecisionRejectionReason::parse(&wire.reason), wire.round) {
            (Some(reason), Some(round)) => TurnRejection::Judged { round, reason },
            (Some(_), None) => return Err(RecordError::RejectionRound),
            (None, round) => {
                let rejection = RuntimeRejection::ALL
                    .into_iter()
                    .find(|rejection| rejection.as_str() == wire.reason)
                    .ok_or_else(|| RecordError::UnknownReason(wire.reason.clone()))?;

                if round.is_some() {
                    return Err(RecordError::RejectionRound);
                }

                TurnRejection::Runtime(rejection)
            }
        };
        let mut rejected = Self::new(rejection, wire.message)?;

        rejected.visible_message_ids = wire.visible_message_ids;
        rejected.tool_call_ids = wire.tool_call_ids;
        rejected.runtime_plugin_evidence = wire.runtime_plugin_evidence;
        rejected.runtime_plugin_turn_evidence = wire.runtime_plugin_turn_evidence;
        Ok(rejected)
    }
}

impl From<TurnRejected> for WireRejected {
    fn from(rejected: TurnRejected) -> Self {
        Self {
            reason: rejected.rejection.reason().to_owned(),
            message: rejected.message,
            visible_message_ids: rejected.visible_message_ids,
            tool_call_ids: rejected.tool_call_ids,
            round: rejected.rejection.round(),
            runtime_plugin_evidence: rejected.runtime_plugin_evidence,
            runtime_plugin_turn_evidence: rejected.runtime_plugin_turn_evidence,
        }
    }
}
