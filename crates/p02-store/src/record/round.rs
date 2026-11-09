use std::num::NonZeroU32;

use p02_contracts::{DecisionResult, ModelOutput, ProviderAnswer, ProviderFailure, TokenUsage};
use serde::{Deserialize, Serialize};

/// One model round, recorded before anything it decided happens: what the
/// model wrote and how its provider ended the answer, or how the provider
/// failed, and the verdict on it. Its prompt is not kept.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundRecord {
    round: NonZeroU32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    output: Option<ModelOutput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    finish_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    usage: Option<TokenUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    failure: Option<ProviderFailure>,
    #[serde(rename = "parsedRoleModelDecisionSnapshot")]
    verdict: Verdict,
}

/// Where every round, old or new, keeps its verdict.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Verdict {
    result: DecisionResult,
}

impl RoundRecord {
    /// Round `round` as its provider answered it and as `result` judged it,
    /// every credential-named value the model wrote redacted.
    #[must_use]
    pub fn new(round: NonZeroU32, answer: &ProviderAnswer, result: &DecisionResult) -> Self {
        let (output, finish_reason, usage, failure) = match answer {
            ProviderAnswer::Answered {
                output,
                finish_reason,
                usage,
            } => (Some(output.redacted()), finish_reason.clone(), *usage, None),
            ProviderAnswer::Failed(failure) => (None, None, None, Some(failure.clone())),
        };

        Self {
            round,
            output,
            finish_reason,
            usage,
            failure,
            verdict: Verdict {
                result: result.redacted(),
            },
        }
    }

    #[must_use]
    pub fn round(&self) -> NonZeroU32 {
        self.round
    }

    #[must_use]
    pub fn result(&self) -> &DecisionResult {
        &self.verdict.result
    }
}
