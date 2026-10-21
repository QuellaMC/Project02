use std::num::NonZeroU32;

use p02_characters::CharacterVersion;
use p02_contracts::{
    DecisionRejectionReason, DecisionResult, InputEnvelope, PromptSize, ProviderExchange,
    ProviderMetadata,
};
use p02_shared::{Credentials, Fingerprint};
use serde::{Deserialize, Serialize};

use super::RecordError;

/// One model round, recorded before anything it decided happens: what the
/// model was shown and what it wrote, and the parser's verdict on that.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "WireRound", into = "WireRound")]
pub struct RoundRecord {
    round: NonZeroU32,
    snapshot: RoundSnapshot,
    result: DecisionResult,
}

/// What a round was shown and what it wrote, with who answered.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoundSnapshot {
    pub input_envelope: InputEnvelope,
    /// What the model wrote; none when the provider failed and nothing
    /// usable came.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output_text: Option<String>,
    pub character_ref: CharacterRef,
    pub prompt_size: PromptSize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_metadata: Option<ProviderMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_exchange: Option<ProviderExchange>,
}

/// Which content of the character a round ran: her package's version and
/// the fingerprint of her persona.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CharacterRef {
    pub version: CharacterVersion,
    pub persona_fingerprint: Fingerprint,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireRound {
    round: NonZeroU32,
    #[serde(rename = "roleModelIOSnapshot")]
    snapshot: RoundSnapshot,
    parsed_role_model_decision_snapshot: ParsedDecision,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ParsedDecision {
    result: DecisionResult,
}

impl RoundRecord {
    /// Round `round`, judged `result`. The verdict must be what the
    /// round's output reads as: the decision parser's, credentials
    /// redacted, or, when nothing came, the provider's failure.
    ///
    /// # Errors
    ///
    /// [`RecordError::Verdict`] when it is not.
    pub fn new(
        round: NonZeroU32,
        snapshot: RoundSnapshot,
        result: DecisionResult,
    ) -> Result<Self, RecordError> {
        let agrees = match &snapshot.raw_output_text {
            None => matches!(
                &result,
                DecisionResult::Rejected { rejection }
                    if rejection.reason == DecisionRejectionReason::ProviderError
            ),
            Some(raw) => DecisionResult::parse(raw, Credentials::Redact) == result,
        };

        if agrees {
            Ok(Self {
                round,
                snapshot,
                result,
            })
        } else {
            Err(RecordError::Verdict { round })
        }
    }

    #[must_use]
    pub fn round(&self) -> NonZeroU32 {
        self.round
    }

    #[must_use]
    pub fn snapshot(&self) -> &RoundSnapshot {
        &self.snapshot
    }

    #[must_use]
    pub fn result(&self) -> &DecisionResult {
        &self.result
    }
}

impl TryFrom<WireRound> for RoundRecord {
    type Error = RecordError;

    fn try_from(wire: WireRound) -> Result<Self, Self::Error> {
        Self::new(
            wire.round,
            wire.snapshot,
            wire.parsed_role_model_decision_snapshot.result,
        )
    }
}

impl From<RoundRecord> for WireRound {
    fn from(record: RoundRecord) -> Self {
        Self {
            round: record.round,
            snapshot: record.snapshot,
            parsed_role_model_decision_snapshot: ParsedDecision {
                result: record.result,
            },
        }
    }
}
