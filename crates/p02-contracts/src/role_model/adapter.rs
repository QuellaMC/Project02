use std::fmt;
use std::num::NonZeroUsize;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::role_model::answer::ProviderAnswer;
use crate::role_model::chat::{ChatCompletionTool, ChatMessage};
use crate::role_model::history::ConversationTurn;

/// A model provider. The runtime chooses one by its settings when it
/// starts, so it is held as `dyn RoleModelAdapter`; the trait's methods are
/// boxed futures for that reason.
#[async_trait]
pub trait RoleModelAdapter: Send + Sync + fmt::Debug {
    /// Asks the model for one round. A provider failure is an answer too,
    /// [`ProviderAnswer::Failed`], never a panic.
    async fn invoke(&self, invocation: &Invocation<'_>) -> ProviderAnswer;

    /// A plain completion on the same model, without persona or tools, which
    /// the runtime condenses earlier conversation with.
    async fn complete_text(&self, request: &TextCompletionRequest) -> TextCompletion {
        let _ = request;

        TextCompletion::Unsupported
    }
}

/// What one round is rendered into.
#[derive(Clone, Copy, Debug)]
pub struct Invocation<'a> {
    messages: &'a [ChatMessage],
    tools: &'a [ChatCompletionTool],
    history: &'a [ConversationTurn],
}

impl<'a> Invocation<'a> {
    /// The wire a round sends. The earlier turns it replays are in its
    /// messages as the round rendered them, so a provider replays nothing
    /// else.
    #[must_use]
    pub fn new(messages: &'a [ChatMessage], tools: &'a [ChatCompletionTool]) -> Self {
        Self {
            messages,
            tools,
            history: &[],
        }
    }

    /// The earlier turns the messages replay, as turns: what a provider
    /// with no model reads the conversation from.
    #[must_use]
    pub fn with_history(mut self, history: &'a [ConversationTurn]) -> Self {
        self.history = history;
        self
    }

    #[must_use]
    pub fn messages(&self) -> &'a [ChatMessage] {
        self.messages
    }

    #[must_use]
    pub fn tools(&self) -> &'a [ChatCompletionTool] {
        self.tools
    }

    #[must_use]
    pub fn history(&self) -> &'a [ConversationTurn] {
        self.history
    }
}

/// A provider a model call can go to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderName {
    Openai,
    Anthropic,
    Nvidia,
}

/// A plain completion request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextCompletionRequest {
    pub instructions: String,
    pub input: String,
    pub max_output_chars: NonZeroUsize,
}

/// How a plain completion ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TextCompletion {
    Completed {
        text: String,
        provider: ProviderName,
        model: Option<String>,
    },
    /// The provider failed, and says why.
    Failed { reason: String },
    /// The provider has no model to ask.
    Unsupported,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::role_model::answer::ModelOutput;

    #[derive(Debug)]
    struct Silent;

    #[async_trait]
    impl RoleModelAdapter for Silent {
        async fn invoke(&self, _invocation: &Invocation<'_>) -> ProviderAnswer {
            ProviderAnswer::Answered {
                output: ModelOutput::default(),
                finish_reason: None,
                usage: None,
            }
        }
    }

    #[tokio::test]
    async fn a_provider_without_a_completion_model_says_so() {
        let request = TextCompletionRequest {
            instructions: "Condense.".to_owned(),
            input: "Earlier turns.".to_owned(),
            max_output_chars: NonZeroUsize::MIN,
        };
        let adapter: &dyn RoleModelAdapter = &Silent;

        assert_eq!(
            adapter.complete_text(&request).await,
            TextCompletion::Unsupported
        );
    }
}
