//! The test provider: fixed replies with no model and no network behind
//! them, which a test harness reaches through its switch and nothing else
//! can.

use async_trait::async_trait;
use p02_contracts::{
    ConversationTurn, Invocation, ModelOutput, ProviderAnswer, ReplyDelta, RoleModelAdapter,
    scrub_reasoning_blocks,
};
use p02_core::VisibleMessageRole;

/// Answers the first line it hears with the same sentence, and every later
/// one by quoting the line before it.
#[derive(Debug, Default)]
pub(crate) struct DeterministicAdapter;

#[async_trait]
impl RoleModelAdapter for DeterministicAdapter {
    async fn invoke(&self, invocation: &Invocation<'_>) -> ProviderAnswer {
        let previous = invocation
            .history()
            .iter()
            .flat_map(ConversationTurn::visible_messages)
            .filter(|message| message.role == VisibleMessageRole::User)
            .last();
        let reply = match previous {
            None => "I'm here. Tell me what you need.".to_owned(),
            Some(line) => format!(
                "I remember you said \"{}\" Stay with me for a minute.",
                line.text
            ),
        };

        // Spoken in word-sized pieces first, so the reply streams the way a
        // model's does, after the scrub the judge gives the whole, so a
        // draft never shows what the commit will not.
        for piece in word_pieces(&scrub_reasoning_blocks(&reply)) {
            invocation.hear(ReplyDelta {
                reply: 0,
                text: piece.to_owned(),
            });
        }

        ProviderAnswer::Answered {
            output: ModelOutput {
                tool_calls: Vec::new(),
                text: Some(reply),
            },
            finish_reason: None,
            usage: None,
        }
    }
}

/// `text` cut after each blank character.
fn word_pieces(text: &str) -> impl Iterator<Item = &str> {
    text.split_inclusive(char::is_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_is_spoken_in_pieces_that_end_after_each_blank() {
        assert_eq!(
            word_pieces("a  b\tc d\ne ").collect::<Vec<_>>(),
            ["a ", " ", "b\t", "c ", "d\n", "e "]
        );
        assert_eq!(word_pieces("").count(), 0);
    }
}
