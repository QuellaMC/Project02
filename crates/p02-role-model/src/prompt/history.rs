//! The conversation a model call replays: each earlier turn as native chat
//! messages, a tool round in one wire whether it is this turn's or an
//! earlier one's, and the window of turns that fits the context.

use std::num::NonZeroU64;

use jiff::tz::TimeZone;
use p02_contracts::{
    ChatFunctionCall, ChatMessage, ChatToolCall, ConversationToolCall, ConversationTurn,
    ToolCallResult, ToolRound,
};
use serde::Serialize;
use serde_json::json;

use crate::prompt::past_moment;

/// An earlier turn as the model replays it: the person's line, or the note
/// of a moment of the character's own, telling when it was in `zone` and
/// what rang when her phone's ringing began it; each tool round as the
/// assistant's calls and their results; then the character's replies as
/// plain assistant text. `visible_reply` itself is never replayed.
pub(crate) fn turn_messages(turn: &ConversationTurn, zone: &TimeZone) -> Vec<ChatMessage> {
    let opening = match &turn.user_message {
        Some(line) => line.text.to_string(),
        None => past_moment(
            &turn.identity.created_at().in_zone(zone.clone()),
            &turn.rang,
        ),
    };

    std::iter::once(ChatMessage::User { content: opening })
        .chain(turn.tool_rounds.iter().flat_map(round_messages))
        .chain(
            turn.final_replies
                .iter()
                .map(|reply| ChatMessage::Assistant {
                    content: Some(reply.text.to_string()),
                    tool_calls: Vec::new(),
                }),
        )
        .collect()
}

/// A tool round on the wire: the model's note and what it said aloud as the
/// assistant's content, its calls under the runtime's ids, then one result
/// for each call.
pub(crate) fn round_messages(round: &ToolRound) -> Vec<ChatMessage> {
    let content = round
        .text
        .iter()
        .map(String::as_str)
        .chain(
            round
                .interim_replies
                .iter()
                .map(|reply| reply.text.as_str()),
        )
        .collect::<Vec<_>>()
        .join("\n\n");
    let calls = round
        .tool_calls
        .iter()
        .map(|call| {
            ChatToolCall::new(
                call.tool_call_id().clone(),
                ChatFunctionCall {
                    name: call.tool_name().to_string(),
                    arguments: json_text(call.input()),
                },
            )
        })
        .collect();

    std::iter::once(ChatMessage::Assistant {
        content: (!content.is_empty()).then_some(content),
        tool_calls: calls,
    })
    .chain(round.tool_calls.iter().map(|call| ChatMessage::Tool {
        content: result_text(call),
        tool_call_id: call.tool_call_id().clone(),
    }))
    .collect()
}

fn result_text(call: &ConversationToolCall) -> String {
    let result = match call.result() {
        ToolCallResult::Accepted { output } => json!({
            "status": "accepted",
            "pluginId": call.plugin_id(),
            "toolName": call.tool_name(),
            "output": output,
        }),
        ToolCallResult::Rejected { reason, message } => json!({
            "status": "rejected",
            "pluginId": call.plugin_id(),
            "toolName": call.tool_name(),
            "reason": reason,
            "message": message,
        }),
    };

    result.to_string()
}

/// `value` as compact JSON text.
pub(crate) fn json_text<T: Serialize + ?Sized>(value: &T) -> String {
    serde_json::to_string(value).expect("plain data always serializes")
}

/// How many characters `value` puts on the wire as JSON.
fn wire_chars<T: Serialize + ?Sized>(value: &T) -> u64 {
    json_text(value).chars().count() as u64
}

/// The runtime's one token estimate: four characters a token, rounded up,
/// so a message, whose wire text is never empty, costs at least one.
/// Coarse on purpose: every window the runtime picks shares it.
fn estimated_tokens(chars: u64) -> u64 {
    chars.div_ceil(4)
}

/// What `turn` costs replayed, a moment's note counted in UTC, which its
/// length hardly feels.
fn turn_tokens(turn: &ConversationTurn) -> u64 {
    turn_messages(turn, &TimeZone::UTC)
        .iter()
        .map(|message| estimated_tokens(wire_chars(message)))
        .sum()
}

/// The newest whole turns that fit half the context window, oldest first;
/// the other half is for the prompt around them and the reply.
#[must_use]
pub fn select_history_window(
    turns: &[ConversationTurn],
    context_window_tokens: NonZeroU64,
) -> &[ConversationTurn] {
    newest_turns_within(turns, context_window_tokens.get() / 2)
}

/// The newest whole turns that cost at most `budget` tokens by the
/// runtime's one estimate, oldest first. A turn is never split, and the
/// first that does not fit ends the run, so what is chosen is always recent
/// and unbroken.
#[must_use]
pub fn newest_turns_within(turns: &[ConversationTurn], budget: u64) -> &[ConversationTurn] {
    let mut used = 0;
    let mut start = turns.len();

    for turn in turns.iter().rev() {
        used += turn_tokens(turn);

        if used > budget {
            break;
        }

        start -= 1;
    }

    &turns[start..]
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn turn(index: u64, reply: &str) -> ConversationTurn {
        serde_json::from_value(json!({
            "eventId": format!("evt_{index}"),
            "traceId": format!("trace_{index}"),
            "createdAt": "2026-06-15T00:00:00.000Z",
            "userMessage": {
                "id": format!("chat.1:message-{}", index * 2 - 1),
                "role": "user",
                "speakerId": "local-user",
                "speakerName": "You",
                "text": format!("question {index}"),
            },
            "toolRounds": [],
            "finalReplies": [{
                "id": format!("chat.1:message-{}", index * 2),
                "role": "character",
                "speakerId": "mira",
                "speakerName": "Mira",
                "text": reply,
            }],
        }))
        .unwrap()
    }

    fn ids(turns: &[ConversationTurn]) -> Vec<&str> {
        turns
            .iter()
            .map(|turn| turn.identity.event_id().as_str())
            .collect()
    }

    fn window(tokens: u64) -> NonZeroU64 {
        NonZeroU64::new(tokens).unwrap()
    }

    #[test]
    fn the_window_is_the_newest_whole_turns_that_fit_half_the_context() {
        let turns = [turn(1, "one"), turn(2, "two"), turn(3, "three")];
        let two_turns = turn_tokens(&turns[1]) + turn_tokens(&turns[2]);

        assert_eq!(
            ids(select_history_window(&turns, window(two_turns * 2 + 1))),
            ["evt_2", "evt_3"]
        );

        let split = [
            turn(1, "short"),
            turn(2, &"x".repeat(2_000)),
            turn(3, "short"),
        ];
        let short = turn_tokens(&split[2]);

        assert_eq!(
            ids(select_history_window(&split, window(short * 2 + 1))),
            ["evt_3"]
        );
        assert_eq!(ids(select_history_window(&split[..2], window(64))), [""; 0]);
    }

    #[test]
    fn the_estimate_counts_characters_not_their_encoding() {
        let emoji = turn(1, &"\u{1f331}".repeat(8));
        let letters = turn(1, &"a".repeat(8));

        assert_eq!(turn_tokens(&emoji), turn_tokens(&letters));
    }

    /// A moment of hers replays its note where a line would be, telling
    /// when it was where the person is, and nothing of what the moment was
    /// hers for or how long since the person wrote, which no record keeps;
    /// then what she said in it.
    #[test]
    fn a_moment_replays_its_note_telling_when_it_was_then_what_she_said() {
        let moment: ConversationTurn = serde_json::from_value(json!({
            "eventId": "evt_2",
            "traceId": "trace_2",
            "createdAt": "2026-11-07T04:40:00.000Z",
            "toolRounds": [],
            "finalReplies": [{
                "id": "chat.1:message-3",
                "role": "character",
                "speakerId": "mira",
                "speakerName": "Mira",
                "text": "Found your keys yet?",
            }],
        }))
        .unwrap();
        let zone = TimeZone::fixed(jiff::tz::offset(-5));

        assert_eq!(
            serde_json::to_value(turn_messages(&moment, &zone)).unwrap(),
            json!([
                {
                    "role": "user",
                    "content": "<moment_of_your_own>\n\
                                A moment of your own, on Friday, November 6, 2026, at 23:40 — \
                                nobody had written to you.\n\
                                </moment_of_your_own>",
                },
                {"role": "assistant", "content": "Found your keys yet?"},
            ])
        );
    }

    /// A moment her phone's ringing began replays its note where a line
    /// would be, telling that it rang, when, and what rang, a line each;
    /// then what she said in it.
    #[test]
    fn a_ringing_moment_replays_its_note_telling_what_rang_then_what_she_said() {
        let moment: ConversationTurn = serde_json::from_value(json!({
            "eventId": "evt_2",
            "traceId": "trace_2",
            "createdAt": "2026-11-07T04:40:00.000Z",
            "rang": [
                {"app": "Clock", "title": "Timer", "at": "2026-11-06T03:00:00.000Z"},
                {
                    "app": "Clock",
                    "title": "Alarm",
                    "body": "Wake Sam",
                    "at": "2026-11-07T04:30:00.000Z",
                },
            ],
            "toolRounds": [],
            "finalReplies": [{
                "id": "chat.1:message-3",
                "role": "character",
                "speakerId": "mira",
                "speakerName": "Mira",
                "text": "Up you get.",
            }],
        }))
        .unwrap();
        let zone = TimeZone::fixed(jiff::tz::offset(-5));

        assert_eq!(
            serde_json::to_value(turn_messages(&moment, &zone)).unwrap(),
            json!([
                {
                    "role": "user",
                    "content": "<moment_of_your_own>\n\
                                Your phone rang on Friday, November 6, 2026, at 23:40 — nobody \
                                had written to you.\n\
                                Clock, Timer (set for Thursday, November 5, at 22:00).\n\
                                Clock, Alarm: Wake Sam (set for 23:30).\n\
                                </moment_of_your_own>",
                },
                {"role": "assistant", "content": "Up you get."},
            ])
        );
    }

    #[test]
    fn a_tool_round_replays_as_its_note_and_replies_its_calls_and_their_results() {
        let mut replayed = turn(1, "done");

        replayed.tool_rounds = vec![
            serde_json::from_value(json!({
                "round": 1,
                "text": "let me look",
                "interimReplies": [{
                    "id": "chat.1:message-3",
                    "role": "character",
                    "speakerId": "mira",
                    "speakerName": "Mira",
                    "text": "checking",
                }],
                "toolCalls": [{
                    "toolCallId": "call-1",
                    "pluginId": "runtime.plugin",
                    "toolName": "runtime.plugin.list",
                    "input": {},
                    "result": {"status": "accepted", "output": {"plugins": []}},
                }],
            }))
            .unwrap(),
        ];

        assert_eq!(
            serde_json::to_value(turn_messages(&replayed, &TimeZone::UTC)).unwrap(),
            json!([
                {"role": "user", "content": "question 1"},
                {
                    "role": "assistant",
                    "content": "let me look\n\nchecking",
                    "tool_calls": [{
                        "id": "call-1",
                        "type": "function",
                        "function": {"name": "runtime.plugin.list", "arguments": "{}"},
                    }],
                },
                {
                    "role": "tool",
                    "content": "{\"status\":\"accepted\",\"pluginId\":\"runtime.plugin\",\"toolName\":\"runtime.plugin.list\",\"output\":{\"plugins\":[]}}",
                    "tool_call_id": "call-1",
                },
                {"role": "assistant", "content": "done"},
            ])
        );
        assert!(
            !serde_json::to_string(&turn_messages(&replayed, &TimeZone::UTC))
                .unwrap()
                .contains("visible_reply")
        );
        assert_eq!(
            serde_json::to_value(round_messages(&ToolRound {
                interim_replies: Vec::new(),
                text: None,
                ..replayed.tool_rounds[0].clone()
            }))
            .unwrap()[0]["content"],
            Value::Null
        );
    }
}
