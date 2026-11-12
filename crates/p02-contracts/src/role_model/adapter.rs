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

/// What one round is rendered into, and who hears the reply as it comes.
#[derive(Clone, Copy)]
pub struct Invocation<'a> {
    messages: &'a [ChatMessage],
    tools: &'a [ChatCompletionTool],
    history: &'a [ConversationTurn],
    reply_listener: Option<&'a (dyn Fn(ReplyDraft) + Send + Sync)>,
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
            reply_listener: None,
        }
    }

    /// The earlier turns the messages replay, as turns: what a provider
    /// with no model reads the conversation from.
    #[must_use]
    pub fn with_history(mut self, history: &'a [ConversationTurn]) -> Self {
        self.history = history;
        self
    }

    /// Lets `listener` hear each piece of the reply as the model writes it:
    /// a draft, heard and never awaited. The whole output still arrives at
    /// the end, and it alone is judged.
    #[must_use]
    pub fn with_reply_listener(mut self, listener: &'a (dyn Fn(ReplyDraft) + Send + Sync)) -> Self {
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
    pub fn history(&self) -> &'a [ConversationTurn] {
        self.history
    }

    /// Passes a piece of the reply to whoever listens.
    pub fn hear(&self, delta: ReplyDelta) {
        self.tell(ReplyDraft::Delta(delta));
    }

    /// Tells whoever listens that the replies drafted so far are let go.
    pub fn let_go(&self) {
        self.tell(ReplyDraft::LetGo);
    }

    fn tell(&self, draft: ReplyDraft) {
        if let Some(listener) = self.reply_listener {
            listener(draft);
        }
    }
}

impl fmt::Debug for Invocation<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Invocation")
            .field("messages", &self.messages)
            .field("tools", &self.tools)
            .field("history", &self.history)
            .field("listened", &self.reply_listener.is_some())
            .finish()
    }
}

/// What a model says of its visible replies while it writes them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReplyDraft {
    /// The next piece of one reply.
    Delta(ReplyDelta),
    /// Every reply drafted so far is let go, and the next to begin is
    /// counted from zero again: another model took the answer over.
    LetGo,
}

/// The next piece of one visible reply, as the model writes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplyDelta {
    /// Which of the round's replies, counted from zero.
    pub reply: usize,
    /// What follows what came before.
    pub text: String,
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
    use std::sync::Mutex;

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

    #[test]
    fn an_invocation_passes_drafts_to_its_listener_in_order() {
        let heard = Mutex::new(Vec::new());
        let listener = |draft: ReplyDraft| heard.lock().unwrap().push(draft);
        let invocation = Invocation::new(&[], &[]).with_reply_listener(&listener);
        let piece = |text: &str| ReplyDelta {
            reply: 0,
            text: text.to_owned(),
        };

        invocation.hear(piece("Half a"));
        invocation.let_go();
        invocation.hear(piece("Whole."));
        Invocation::new(&[], &[]).hear(piece("nobody listens"));

        assert_eq!(
            *heard.lock().unwrap(),
            [
                ReplyDraft::Delta(piece("Half a")),
                ReplyDraft::LetGo,
                ReplyDraft::Delta(piece("Whole.")),
            ]
        );
    }
}
