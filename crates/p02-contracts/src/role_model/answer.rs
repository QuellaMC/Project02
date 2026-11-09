use p02_shared::redact_credentials;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What a provider answered for one model round, before it is judged.
#[derive(Clone, Debug, PartialEq)]
pub enum ProviderAnswer {
    /// What the model wrote, and how its provider ended the answer.
    Answered {
        output: ModelOutput,
        /// The provider's word for how the answer ended, when it has one.
        finish_reason: Option<String>,
        usage: Option<TokenUsage>,
    },
    /// Nothing usable arrived, and the turn ends with `provider_error`.
    Failed(ProviderFailure),
}

/// What the model wrote in one round, as it wrote it: its tool calls in
/// order, and the text beside them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOutput {
    pub tool_calls: Vec<WrittenCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// A tool call as the model wrote it: the tool, by the runtime's name for
/// it, and its arguments, as JSON when they parse and as their text when
/// they do not.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WrittenCall {
    pub name: String,
    pub input: Value,
}

impl ModelOutput {
    /// The output as a record keeps it: every credential-named value in a
    /// call's input redacted.
    #[must_use]
    pub fn redacted(&self) -> Self {
        let mut kept = self.clone();

        for call in &mut kept.tool_calls {
            redact_credentials(&mut call.input);
        }

        kept
    }
}

/// How many tokens a round took, as its provider counted them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// How a provider failed a round.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderFailure {
    /// The kind of failure, such as `request_timeout`.
    pub code: String,
    /// What went wrong, as the person is told it.
    pub message: String,
    /// The HTTP status that answered, when one did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}
