//! The test provider: fixed replies with no model and no network behind
//! them, which a test harness reaches through its switch and nothing else
//! can.

use async_trait::async_trait;
use p02_contracts::{
    ConversationTurn, InputEnvelope, Invocation, RawOutput, ReplyDelta, RoleModelAdapter,
    VISIBLE_REPLY, scrub_reasoning_blocks,
};
use p02_core::VisibleMessageRole;
use serde_json::json;

use crate::prompt::{is_blank, json_text};

/// Answers the first line it hears with the same sentence, and every later
/// one by quoting the line before it.
#[derive(Debug, Default)]
pub(crate) struct DeterministicAdapter;

#[async_trait]
impl RoleModelAdapter for DeterministicAdapter {
    async fn invoke(&self, _envelope: &InputEnvelope, invocation: &Invocation<'_>) -> RawOutput {
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
        // model's does, after the scrub the parser gives the whole, so a
        // draft never shows what the commit will not.
        if let Ok(shown) = scrub_reasoning_blocks(&reply) {
            for piece in word_pieces(&shown) {
                invocation.hear(ReplyDelta {
                    reply: 0,
                    text: piece.to_owned(),
                });
            }
        }

        RawOutput::text(json_text(
            &json!({"toolCalls": [{"name": VISIBLE_REPLY, "input": {"text": reply}}]}),
        ))
    }
}

/// `text` cut after each blank character.
fn word_pieces(text: &str) -> impl Iterator<Item = &str> {
    text.split_inclusive(is_blank)
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
