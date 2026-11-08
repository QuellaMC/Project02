use std::num::NonZeroU32;

use p02_characters::CharacterRef;
use p02_contracts::{
    DecisionResult, InputEnvelope, PromptSize, ProviderExchange, ProviderMetadata,
};
use p02_shared::redact_credentials;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One model round, recorded before anything it decided happens: what the
/// model was shown and what it wrote, and the parser's verdict on that.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(from = "WireRound", into = "WireRound")]
pub struct RoundRecord {
    round: NonZeroU32,
    snapshot: RoundSnapshot,
    result: DecisionResult,
}

/// What a round was shown and what it wrote, with who answered.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRound {
    round: NonZeroU32,
    #[serde(rename = "roleModelIOSnapshot")]
    snapshot: RoundSnapshot,
    parsed_role_model_decision_snapshot: ParsedDecision,
}

#[derive(Clone, Serialize, Deserialize)]
struct ParsedDecision {
    result: DecisionResult,
}

impl RoundRecord {
    /// Round `round`, judged `result`, what it wrote kept as the rest of the
    /// record keeps a value: every credential-named one in it redacted.
    #[must_use]
    pub fn new(round: NonZeroU32, mut snapshot: RoundSnapshot, result: DecisionResult) -> Self {
        snapshot.raw_output_text = snapshot.raw_output_text.map(kept_output);

        Self {
            round,
            snapshot,
            result,
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

impl From<WireRound> for RoundRecord {
    fn from(wire: WireRound) -> Self {
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

/// What a round wrote, as its session keeps it: the value of every
/// credential-named key in it redacted, and the rest as written. Output
/// that holds no such value, or is no JSON, is kept as it came.
fn kept_output(raw: String) -> String {
    let Ok(written) = serde_json::from_str::<Value>(&raw) else {
        return raw;
    };
    let mut kept = written.clone();

    redact_credentials(&mut kept);

    if kept == written {
        raw
    } else {
        kept.to_string()
    }
}
