use std::fmt;
use std::num::NonZeroUsize;

use async_trait::async_trait;

use crate::role_model::chat::{ChatCompletionTool, ChatMessage};
use crate::role_model::decision::InputEnvelope;
use crate::role_model::exchange::{ProviderExchange, ProviderMetadata, ProviderName};
use crate::role_model::history::ConversationTurn;

/// A model provider. The runtime chooses one by its settings when it
/// starts, so it is held as `dyn RoleModelAdapter`; the trait's methods are
/// boxed futures for that reason.
#[async_trait]
pub trait RoleModelAdapter: Send + Sync + fmt::Debug {
    /// Asks the model for one round. A provider failure is an answer too,
    /// [`ProviderAnswer::Failed`], never a panic.
    async fn invoke(&self, envelope: &InputEnvelope, invocation: &Invocation<'_>) -> RawOutput;

    /// A plain completion on the same model, without persona or tools, which
    /// the runtime condenses earlier conversation with.
    async fn complete_text(&self, request: &TextCompletionRequest) -> TextCompletion {
        let _ = request;

        TextCompletion::Unsupported
    }
}

/// What one round is rendered into, and who hears the reply as it comes.
#[derive(Clone, Copy)]
pub struct Invocation<'a> {
    messages: &'a [ChatMessage],
    tools: &'a [ChatCompletionTool],
    conversation_history: &'a [ConversationTurn],
    reply_listener: Option<&'a (dyn Fn(ReplyDelta) + Send + Sync)>,
}

impl<'a> Invocation<'a> {
    /// The wire a round sends, and the earlier turns it replays.
    #[must_use]
    pub fn new(
        messages: &'a [ChatMessage],
        tools: &'a [ChatCompletionTool],
        conversation_history: &'a [ConversationTurn],
    ) -> Self {
        Self {
            messages,
            tools,
            conversation_history,
            reply_listener: None,
        }
    }

    /// Lets `listener` hear each piece of the reply as the model writes it:
    /// a draft, heard and never awaited. The whole output still arrives at
    /// the end, and it alone is judged.
    #[must_use]
    pub fn with_reply_listener(mut self, listener: &'a (dyn Fn(ReplyDelta) + Send + Sync)) -> Self {
        self.reply_listener = Some(listener);
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
    pub fn conversation_history(&self) -> &'a [ConversationTurn] {
        self.conversation_history
    }

    /// Passes a piece of the reply to whoever listens.
    pub fn hear(&self, delta: ReplyDelta) {
        if let Some(listener) = self.reply_listener {
            listener(delta);
        }
    }
}

impl fmt::Debug for Invocation<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Invocation")
            .field("messages", &self.messages)
            .field("tools", &self.tools)
            .field("conversation_history", &self.conversation_history)
            .field("listened", &self.reply_listener.is_some())
            .finish()
    }
}

/// The next piece of one visible reply, as the model writes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplyDelta {
    /// Which of the round's replies, counted from zero.
    pub reply: usize,
    /// What follows what came before.
    pub text: String,
}

/// What a provider answered, before it is judged.
#[derive(Clone, Debug, PartialEq)]
pub struct RawOutput {
    pub answer: ProviderAnswer,
    pub provider_metadata: Option<ProviderMetadata>,
    pub provider_exchange: Option<ProviderExchange>,
}

/// What came back from the model, if anything usable did. An adapter says
/// no more than this: every verdict on what the model wrote is the decision
/// parser's, so a recorded round replays to the result it was given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderAnswer {
    /// What the model wrote.
    Text(String),
    /// Nothing usable arrived: the provider failed, as `details` says, and
    /// the turn ends with `provider_error`.
    Failed { details: String },
}

impl RawOutput {
    /// Output the model wrote, with nothing else to say about it.
    #[must_use]
    pub fn text(raw_output_text: impl Into<String>) -> Self {
        Self {
            answer: ProviderAnswer::Text(raw_output_text.into()),
            provider_metadata: None,
            provider_exchange: None,
        }
    }
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
    use std::sync::Mutex;

    use super::*;

    #[derive(Debug)]
    struct Silent;

    #[async_trait]
    impl RoleModelAdapter for Silent {
        async fn invoke(
            &self,
            _envelope: &InputEnvelope,
            _invocation: &Invocation<'_>,
        ) -> RawOutput {
            RawOutput::text("")
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

    #[test]
    fn an_invocation_passes_drafts_to_its_listener_in_order() {
        let heard = Mutex::new(String::new());
        let listener = |delta: ReplyDelta| heard.lock().unwrap().push_str(&delta.text);
        let invocation = Invocation::new(&[], &[], &[]).with_reply_listener(&listener);

        invocation.hear(ReplyDelta {
            reply: 0,
            text: "Hel".to_owned(),
        });
        invocation.hear(ReplyDelta {
            reply: 0,
            text: "lo.".to_owned(),
        });
        Invocation::new(&[], &[], &[]).hear(ReplyDelta {
            reply: 0,
            text: "nobody listens".to_owned(),
        });

        assert_eq!(*heard.lock().unwrap(), "Hello.");
    }
}
