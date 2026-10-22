//! The continuation of a session that has outgrown the model's window:
//! which turns are carried whole and which condensed, what the summarizer
//! reads, and the summary when no model writes one. Every length is counted
//! in characters.

use std::num::{NonZeroU32, NonZeroU64, NonZeroUsize};

use p02_contracts::{
    ConversationTurn, RoleModelAdapter, TextCompletion, TextCompletionRequest, ToolCallResult,
};
use p02_core::{SpeakerName, Timestamp, VisibleMessage};
use p02_role_model::{
    Person, Recollection, newest_turns_within, select_history_window, summarizer_instructions,
};
use p02_shared::Identifier;
use p02_store::{MAX_SUMMARY_CHARS, Summarizer, SummaryProvider};

/// The least a summary may hold, however small the window: anything less
/// is too thin to continue from.
const MIN_SUMMARY_CHARS: usize = 1_000;
/// How much of a line the summarizer reads from its start, and from its
/// end, when the line is longer than the two together.
const LINE_HEAD_CHARS: usize = 1_200;
const LINE_TAIL_CHARS: usize = 400;
/// The most the mechanical summary says of the condensed turns.
const MECHANICAL_SUMMARY_CHARS: usize = 2_000;
/// How much of each of the person's last lines the mechanical summary
/// quotes.
const QUOTED_LINE_CHARS: usize = 160;
/// How many of the person's last lines the mechanical summary quotes.
const QUOTED_LINES: usize = 3;
const NO_SUMMARIZER: &str = "The selected provider has no summarizer model.";
const NO_TEXT: &str = "The summarizer returned no text.";

/// The turns a continuation condenses and the turns it carries whole,
/// oldest first each: together, the whole history.
#[derive(Debug)]
pub(crate) struct Selection<'a> {
    pub(crate) summarized: &'a [ConversationTurn],
    pub(crate) summarized_turn_count: NonZeroU32,
    pub(crate) carried: &'a [ConversationTurn],
}

/// The summary a continuation opens with, and who wrote it.
#[derive(Debug)]
pub(crate) struct Summary {
    pub(crate) text: String,
    pub(crate) summarizer: Summarizer,
}

/// The continuation `turns` call for in a window of `window` tokens, if
/// any. A session continues the moment the model's window would drop a
/// whole turn: the newest turns that fit a quarter of the window are
/// carried whole, by the window's own measure, and every turn before them
/// is condensed, a turn too big for the quarter with the rest.
pub(crate) fn select(turns: &[ConversationTurn], window: NonZeroU64) -> Option<Selection<'_>> {
    if select_history_window(turns, window).len() == turns.len() {
        return None;
    }

    let carried = newest_turns_within(turns, window.get() / 4).len();
    let (summarized, carried) = turns.split_at(turns.len() - carried);
    let summarized_turn_count =
        NonZeroU32::new(u32::try_from(summarized.len()).unwrap_or(u32::MAX))?;

    Some(Selection {
        summarized,
        summarized_turn_count,
        carried,
    })
}

/// Condenses `turns`, after the `earlier` summary a continued session
/// opened with, through the provider's plain completion. When the provider
/// has no model for it, fails, or answers nothing, the mechanical summary
/// says what it can, and the summarizer says why. Both speak of the person
/// by `person`, the name the conversation recorded for them, as the
/// transcript they condense names them.
pub(crate) async fn summarize(
    adapter: &dyn RoleModelAdapter,
    turns: &[ConversationTurn],
    earlier: Option<&str>,
    person: &SpeakerName,
    character: &SpeakerName,
    window: NonZeroU64,
) -> Summary {
    let budget = summary_budget(window);
    let recollection = if earlier.is_some() {
        Recollection::Rewrite
    } else {
        Recollection::First
    };
    let request = TextCompletionRequest {
        instructions: summarizer_instructions(
            Person::Named(person),
            character,
            budget,
            recollection,
        ),
        input: summarizer_input(turns, earlier, window),
        max_output_chars: budget,
    };
    let fallback = |reason: &str| Summary {
        text: mechanical_summary(turns, earlier, person, budget.get()),
        summarizer: Summarizer::Fallback {
            reason: reason.to_owned(),
        },
    };

    match adapter.complete_text(&request).await {
        TextCompletion::Completed {
            text,
            provider,
            model,
        } => match capped(&text, budget.get()) {
            Some(text) => Summary {
                text,
                summarizer: Summarizer::Model {
                    provider: SummaryProvider {
                        name: provider,
                        model,
                    },
                },
            },
            None => fallback(NO_TEXT),
        },
        TextCompletion::Failed { reason } => fallback(&reason),
        TextCompletion::Unsupported => fallback(NO_SUMMARIZER),
    }
}

/// The most a summary may hold for a window of `window` tokens: a twentieth
/// of the window at four characters a token, at least
/// [`MIN_SUMMARY_CHARS`] and at most what the record holds.
fn summary_budget(window: NonZeroU64) -> NonZeroUsize {
    let share = usize::try_from(window.get() / 5).unwrap_or(usize::MAX);

    NonZeroUsize::new(share.clamp(MIN_SUMMARY_CHARS, MAX_SUMMARY_CHARS))
        .unwrap_or(NonZeroUsize::MIN)
}

/// The most the summarizer's transcript holds: three fifths of a window of
/// `window` tokens, at four characters a token.
fn transcript_cap(window: NonZeroU64) -> usize {
    usize::try_from(window.get().saturating_mul(12) / 5).unwrap_or(usize::MAX)
}

/// What the summarizer reads: the earlier summary, when there is one, then
/// the turns as a transcript.
fn summarizer_input(
    turns: &[ConversationTurn],
    earlier: Option<&str>,
    window: NonZeroU64,
) -> String {
    let conversation = format!(
        "<conversation>\n{}\n</conversation>",
        transcript(turns, transcript_cap(window))
    );

    match earlier {
        Some(summary) => {
            format!("<existing_summary>\n{summary}\n</existing_summary>\n{conversation}")
        }
        None => conversation,
    }
}

/// `turns` as plain lines, oldest first: the day whenever it changes, each
/// message as its speaker's name and its text on one line, each tool call
/// and its result, a line too long shortened from its middle, and the
/// oldest lines left out while the whole is longer than `cap` characters,
/// a note of how many counted in, though never the newest.
fn transcript(turns: &[ConversationTurn], cap: usize) -> String {
    let lines = transcript_lines(turns);
    let lengths: Vec<usize> = lines.iter().map(|line| line.chars().count()).collect();
    let mut kept = lengths.iter().sum::<usize>() + lines.len().saturating_sub(1);
    let mut dropped = 0;
    let length = |dropped: usize, kept: usize| match dropped {
        0 => kept,
        _ => omitted(dropped).chars().count() + 1 + kept,
    };

    while dropped + 1 < lines.len() && length(dropped, kept) > cap {
        kept -= lengths[dropped] + 1;
        dropped += 1;
    }

    let shown = lines[dropped..].join("\n");

    match dropped {
        0 => shown,
        _ => format!("{}\n{shown}", omitted(dropped)),
    }
}

fn omitted(lines: usize) -> String {
    format!("[… {lines} earlier lines omitted …]")
}

fn transcript_lines(turns: &[ConversationTurn]) -> Vec<String> {
    let mut lines = Vec::new();
    let mut day = None;

    for turn in turns {
        let today = day_of(turn.identity.created_at());

        if day != Some(today) {
            lines.push(format!("[{today}]"));
            day = Some(today);
        }

        lines.push(said(&turn.user_message));

        for round in &turn.tool_rounds {
            lines.extend(round.interim_replies.iter().map(said));

            for call in &round.tool_calls {
                let tool = call.tool_name();

                lines.push(shortened(&format!(
                    "[tool call {tool}] {}",
                    serde_json::to_string(call.input()).unwrap_or_default()
                )));
                lines.push(shortened(&match call.result() {
                    ToolCallResult::Accepted { output } => {
                        format!("[tool result {tool}] {output}")
                    }
                    ToolCallResult::Rejected { message, .. } => {
                        format!("[tool result {tool}] rejected: {message}")
                    }
                }));
            }
        }

        lines.extend(turn.final_replies.iter().map(said));
    }

    lines
}

/// A message as its speaker's name and its text, on one line.
fn said(message: &VisibleMessage) -> String {
    shortened(&format!(
        "{}: {}",
        message.speaker_name,
        message.text.as_str().replace('\n', " ")
    ))
}

/// `line`, or its first and last characters with how many were left out
/// between them, when it is longer than the two together.
fn shortened(line: &str) -> String {
    let length = line.chars().count();

    if length <= LINE_HEAD_CHARS + LINE_TAIL_CHARS {
        return line.to_owned();
    }

    let head: String = line.chars().take(LINE_HEAD_CHARS).collect();
    let tail: String = line.chars().skip(length - LINE_TAIL_CHARS).collect();

    format!(
        "{head} [… {} chars omitted …] {tail}",
        length - LINE_HEAD_CHARS - LINE_TAIL_CHARS
    )
}

/// The date part of `moment`, as recorded.
fn day_of(moment: &Timestamp) -> &str {
    moment
        .as_str()
        .split_once('T')
        .map_or(moment.as_str(), |(day, _)| day)
}

/// A summarizer's answer as a continuation keeps it: trimmed, and when
/// longer than `budget` characters, cut there and back to the last sentence
/// or line that ends past four fifths of it. None for an answer of nothing.
fn capped(text: &str, budget: usize) -> Option<String> {
    let trimmed = text.trim();

    if trimmed.is_empty() {
        return None;
    }

    if trimmed.chars().count() <= budget {
        return Some(trimmed.to_owned());
    }

    let head: Vec<char> = trimmed.chars().take(budget).collect();
    let boundary = (0..head.len()).rev().find(|&at| {
        matches!(head[at], '\n' | '。') || (head[at] == '.' && head.get(at + 1) == Some(&' '))
    });
    let end = match boundary {
        Some(at) if at * 5 > budget * 4 => at + 1,
        _ => head.len(),
    };

    Some(head[..end].iter().collect::<String>().trim().to_owned())
}

/// What the record says of `turns` when no model condenses them: how many
/// went by and when, the last things the person said there, the tools used,
/// within 2,000 characters or `budget`, whichever is less; the `earlier`
/// summary is kept in front, cut to the room left, when any is.
fn mechanical_summary(
    turns: &[ConversationTurn],
    earlier: Option<&str>,
    person: &SpeakerName,
    budget: usize,
) -> String {
    let first = turns
        .first()
        .map_or("?", |turn| day_of(turn.identity.created_at()));
    let last = turns
        .last()
        .map_or("?", |turn| day_of(turn.identity.created_at()));
    let quoted = turns[turns.len().saturating_sub(QUOTED_LINES)..]
        .iter()
        .map(|turn| {
            format!(
                "“{}”",
                cut(turn.user_message.text.as_str(), QUOTED_LINE_CHARS)
            )
        })
        .collect::<Vec<_>>()
        .join(" · ");
    let mut tools: Vec<&Identifier> = Vec::new();

    for call in turns
        .iter()
        .flat_map(|turn| &turn.tool_rounds)
        .flat_map(|round| &round.tool_calls)
    {
        if !tools.contains(&call.tool_name()) {
            tools.push(call.tool_name());
        }
    }

    let mut sentences = vec![
        format!(
            "Earlier conversation ({} turns, {first} to {last}) is not in context verbatim.",
            turns.len()
        ),
        format!("Most recent things {person} said there: {quoted}."),
    ];

    if !tools.is_empty() {
        let tools: Vec<&str> = tools.iter().map(|tool| tool.as_str()).collect();

        sentences.push(format!("Tools used there: {}.", tools.join(", ")));
    }

    sentences.push("Details from that part are not available in context.".to_owned());

    let section = cut(&sentences.join(" "), MECHANICAL_SUMMARY_CHARS.min(budget));
    let room = budget.saturating_sub(section.chars().count() + 2);

    match earlier {
        Some(earlier) if room > 0 => format!("{}\n\n{section}", cut(earlier, room)),
        _ => section,
    }
}

/// `text` within `most` characters, an ellipsis marking a cut.
fn cut(text: &str, most: usize) -> String {
    if text.chars().count() <= most {
        return text.to_owned();
    }

    text.chars()
        .take(most.saturating_sub(1))
        .chain(['…'])
        .collect()
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU64;

    use p02_contracts::{ConversationToolCall, ToolCallId, ToolRound};
    use p02_core::{
        ConversationId, EventId, EventIdentity, MessageId, SessionId, TraceId, VisibleMessageRole,
        VisibleText,
    };
    use serde_json::json;

    use super::*;

    /// A small generator of its own, so a failing seed is a seed to rerun.
    struct Random(u64);

    impl Random {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);

            let mut mixed = self.0;

            mixed = (mixed ^ (mixed >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            mixed = (mixed ^ (mixed >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            mixed ^ (mixed >> 31)
        }

        fn below(&mut self, bound: usize) -> usize {
            usize::try_from(self.next() % u64::try_from(bound).unwrap()).unwrap()
        }

        /// Text of 1 to `most` characters, wide ones and sentence ends among
        /// them, never blank.
        fn text(&mut self, most: usize) -> String {
            const PIECES: [&str; 10] = [
                "tea",
                " ",
                "rain",
                ". ",
                "\n",
                "\u{3002}",
                "\u{1f331}",
                "na\u{ef}ve",
                "\u{65e5}\u{672c}",
                "\"quoted\"",
            ];
            let length = 1 + self.below(most);
            let mut text = String::from("A");

            while text.chars().count() < length {
                text.push_str(PIECES[self.below(PIECES.len())]);
            }

            text.chars().take(length).collect()
        }

        /// A line of the person's or a reply, now and then far longer than
        /// a summarizer reads whole.
        fn said(&mut self) -> VisibleText {
            let most = if self.below(8) == 0 { 4_000 } else { 200 };

            VisibleText::normalize(&self.text(most)).unwrap()
        }
    }

    /// A history of up to a dozen turns over a few days, with tool rounds
    /// among them.
    fn history(random: &mut Random) -> Vec<ConversationTurn> {
        let session = SessionId::new(ConversationId::new("conv_seed").unwrap(), NonZeroU64::MIN);
        let mut number = 0;
        let mut message = |random: &mut Random, role| {
            number += 1;

            let (speaker_id, speaker_name) = match role {
                VisibleMessageRole::User => ("local-user", "Sam"),
                VisibleMessageRole::Character => ("mira", "Mira"),
            };

            VisibleMessage {
                id: MessageId::new(session.clone(), NonZeroU64::new(number).unwrap()),
                role,
                speaker_id: Identifier::new(speaker_id).unwrap(),
                speaker_name: SpeakerName::new(speaker_name).unwrap(),
                text: random.said(),
            }
        };

        (1..=1 + random.below(12))
            .map(|turn| {
                let identity = EventIdentity::new(
                    EventId::new(&format!("evt_{turn}")).unwrap(),
                    TraceId::new(&format!("trace_{turn}")).unwrap(),
                    Timestamp::new(&format!("2026-10-{:02}T09:00:00.000Z", 10 + turn / 4)).unwrap(),
                )
                .unwrap();
                let user_message = message(random, VisibleMessageRole::User);
                let tool_rounds = (0..random.below(3))
                    .map(|round| ToolRound {
                        round: NonZeroU32::new(u32::try_from(round + 1).unwrap()).unwrap(),
                        text: None,
                        interim_replies: vec![message(random, VisibleMessageRole::Character)],
                        tool_calls: vec![tool_call(random, turn, round)],
                    })
                    .collect();
                let final_replies = (0..=random.below(2))
                    .map(|_| message(random, VisibleMessageRole::Character))
                    .collect();

                ConversationTurn {
                    identity,
                    user_message,
                    tool_rounds,
                    final_replies,
                }
            })
            .collect()
    }

    fn tool_call(random: &mut Random, turn: usize, round: usize) -> ConversationToolCall {
        let result = if random.below(3) == 0 {
            ToolCallResult::Rejected {
                reason: "handler_failed".to_owned(),
                message: random.text(300),
            }
        } else {
            ToolCallResult::Accepted {
                output: json!({"found": random.text(2_000)}),
            }
        };

        ConversationToolCall::new(
            ToolCallId::new(&format!("call-{turn}-{round}")).unwrap(),
            Identifier::new("notes").unwrap(),
            Identifier::new(["notes.add", "notes.find"][random.below(2)]).unwrap(),
            json!({"query": random.text(100)})
                .as_object()
                .unwrap()
                .clone(),
            result,
        )
        .unwrap()
    }

    /// A window of 1 to 65,536 tokens, as many small ones as large.
    fn window(random: &mut Random) -> NonZeroU64 {
        let scale = 1 << (1 + random.below(16));

        NonZeroU64::new(1 + u64::try_from(random.below(scale)).unwrap()).unwrap()
    }

    fn ids(turns: &[ConversationTurn]) -> Vec<&EventId> {
        turns.iter().map(|turn| turn.identity.event_id()).collect()
    }

    #[test]
    fn a_continuation_carries_the_newest_turns_that_fit_a_quarter_and_condenses_the_rest() {
        let mut continued = 0;

        for seed in 0..500 {
            let mut random = Random(seed);
            let turns = history(&mut random);
            let window = window(&mut random);
            let held = select_history_window(&turns, window).len() == turns.len();

            let Some(selection) = select(&turns, window) else {
                assert!(
                    held,
                    "seed {seed}: a window that drops a turn calls for a continuation"
                );
                continue;
            };

            continued += 1;

            let quarter = window.get() / 4;
            let (summarized, carried) = (selection.summarized, selection.carried);

            assert!(
                !held,
                "seed {seed}: a history the window holds stays as it is"
            );
            assert_eq!(
                ids(summarized)
                    .into_iter()
                    .chain(ids(carried))
                    .collect::<Vec<_>>(),
                ids(&turns),
                "seed {seed}"
            );
            assert_eq!(
                selection.summarized_turn_count.get(),
                u32::try_from(summarized.len()).unwrap(),
                "seed {seed}"
            );
            assert_eq!(
                newest_turns_within(carried, quarter).len(),
                carried.len(),
                "seed {seed}"
            );
            assert_eq!(
                newest_turns_within(&turns[summarized.len() - 1..], quarter).len(),
                carried.len(),
                "seed {seed}: the turn before the carried ones does not fit"
            );
        }

        assert!(
            continued >= 50 && 500 - continued >= 50,
            "{continued} of 500 continued"
        );
    }

    #[test]
    fn a_summary_never_exceeds_its_budget() {
        let mut cut = 0;

        for seed in 0..500 {
            let mut random = Random(seed);
            let turns = history(&mut random);
            let budget = summary_budget(window(&mut random)).get();
            let earlier = (random.below(2) == 0).then(|| random.text(MAX_SUMMARY_CHARS));
            let person = SpeakerName::new("Sam").unwrap();
            let mechanical = mechanical_summary(&turns, earlier.as_deref(), &person, budget);
            let answer = format!("  {}  ", random.text(3 * budget));
            let model = capped(&answer, budget).unwrap();

            cut += usize::from(answer.trim().chars().count() > budget);
            assert!(
                (MIN_SUMMARY_CHARS..=MAX_SUMMARY_CHARS).contains(&budget),
                "seed {seed}"
            );
            assert!(mechanical.chars().count() <= budget, "seed {seed}");
            assert!(model.chars().count() <= budget, "seed {seed}");
            assert_eq!(model.trim(), model, "seed {seed}");
            assert!(capped(" \n\t ", budget).is_none());
        }

        assert!(cut > 100, "{cut} of 500 answers cut");
    }

    #[test]
    fn a_transcript_never_exceeds_its_cap_unless_down_to_its_newest_line() {
        let mut shortened = 0;

        for seed in 0..500 {
            let mut random = Random(seed);
            let turns = history(&mut random);
            let cap = transcript_cap(window(&mut random));
            let lines = transcript_lines(&turns);
            let shown = transcript(&turns, cap);
            let newest = lines.last().unwrap();

            assert!(
                shown.chars().count() <= cap
                    || shown == format!("{}\n{newest}", omitted(lines.len() - 1)),
                "seed {seed}"
            );
            assert!(
                lines
                    .iter()
                    .all(|line| line.chars().count() <= LINE_HEAD_CHARS + LINE_TAIL_CHARS + 40),
                "seed {seed}"
            );
            assert!(shown.ends_with(newest.as_str()), "seed {seed}");
            shortened += usize::from(shown.starts_with("[\u{2026}"));
        }

        assert!(shortened > 100, "{shortened} of 500 transcripts shortened");
    }
}
