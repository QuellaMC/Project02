//! The one model call a captured turn costs, as mem0ai 3.1.6 makes it:
//! mem0's system prompt, its user message, and its tolerant reading of the
//! answer.

use serde::Serialize;
use serde_json::Value;

use crate::record::{Message, ObservedOn};

/// `ADDITIVE_EXTRACTION_PROMPT` of mem0ai 3.1.6, verbatim and frozen.
///
/// Copyright 2023 Taranjeet Singh, as mem0's license states it; from
/// <https://github.com/mem0ai/mem0>, unmodified, under the Apache License,
/// Version 2.0, whose text is `third_party/mem0/LICENSE` in this crate.
pub(crate) const SYSTEM_PROMPT: &str =
    include_str!("../third_party/mem0/additive_extraction_prompt.txt");

/// How much of each earlier message the model is shown.
const HISTORY_LINE_CHARS: usize = 300;

/// A captured message names its speaker; this keeps the model from
/// reverting to role labels, which name nobody in roleplay.
const INSTRUCTIONS: &str = "Refer to people by the names used in the conversation; never call \
     anyone \"user\" or \"assistant\".";

/// What the model ends some answers with, or wraps them in.
const SPECIAL_TOKENS: [&str; 5] = [
    "<|end_of_text|>",
    "<|eot_id|>",
    "<|im_end|>",
    "<|im_start|>",
    "<|endoftext|>",
];

/// What one extraction shows the model besides the system prompt.
pub(crate) struct Extraction<'a> {
    /// The session's earlier messages, oldest first.
    pub(crate) history: &'a [Message],
    /// The memories nearest to the turn, which the model links to and does
    /// not extract again.
    pub(crate) existing: &'a [String],
    /// The turn, a `role: content` line per message.
    pub(crate) new_messages: &'a str,
    pub(crate) observed_on: &'a ObservedOn,
}

#[derive(Serialize)]
struct Existing<'a> {
    id: String,
    text: &'a str,
}

/// Why an answer yields no memories: it holds no `memory` list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("the extraction model's answer held no memory list")]
pub(crate) struct UnreadableExtractionError;

impl Extraction<'_> {
    /// mem0's user message: its sections in its order, the summary and the
    /// memories extracted earlier in the session always empty, existing
    /// memories numbered from "0", both dates the turn's own day, and the
    /// instruction to name people as the conversation does.
    pub(crate) fn user_message(&self) -> String {
        let mut history = String::new();

        for message in self.history {
            history.push_str(message.role.as_str());
            history.push_str(": ");
            history.push_str(&cut(&message.content, HISTORY_LINE_CHARS));
            history.push('\n');
        }

        let existing: Vec<Existing<'_>> = self
            .existing
            .iter()
            .enumerate()
            .map(|(at, text)| Existing {
                id: at.to_string(),
                text,
            })
            .collect();
        let existing =
            serde_json::to_string(&existing).expect("a list of string pairs always serializes");
        let date = self.observed_on.as_str();

        [
            "## Summary\n".to_owned(),
            format!("## Last k Messages\n{history}"),
            "## Recently Extracted Memories\n[]".to_owned(),
            format!("## Existing Memories\n{existing}"),
            format!("## New Messages\n{}", self.new_messages),
            format!("## Observation Date\n{date}"),
            format!("## Current Date\n{date}"),
            format!("## Custom Instructions\n{INSTRUCTIONS}"),
            "# Output:".to_owned(),
        ]
        .join("\n\n")
    }
}

/// The memories an answer lists, each text once, in the answer's order.
/// The JSON is found where mem0 finds it: past special tokens, code fences
/// and `<think>` blocks, as the first balanced object that parses. An item
/// without text is passed over; an answer with no `memory` list at all is
/// unreadable, never an extraction of nothing.
pub(crate) fn extracted_memories(answer: &str) -> Result<Vec<String>, UnreadableExtractionError> {
    let value: Value =
        serde_json::from_str(&json_text(answer)).map_err(|_| UnreadableExtractionError)?;
    let items = value
        .get("memory")
        .and_then(Value::as_array)
        .ok_or(UnreadableExtractionError)?;
    let mut texts: Vec<String> = Vec::new();

    for item in items {
        if let Some(text) = item.get("text").and_then(Value::as_str)
            && !text.trim().is_empty()
            && !texts.iter().any(|kept| kept == text)
        {
            texts.push(text.to_owned());
        }
    }

    Ok(texts)
}

/// mem0's `extractJson`: the first balanced object that parses, else the
/// span from the first `{` to the last `}`, then the same for arrays, else
/// the cleaned answer as it stands.
fn json_text(answer: &str) -> String {
    let mut cleaned = answer.to_owned();

    for token in SPECIAL_TOKENS {
        cleaned = cleaned.replace(token, "");
    }

    let cleaned = without_think_blocks(without_code_fences(&cleaned).trim());
    let trimmed = cleaned.trim();

    [(b'{', b'}'), (b'[', b']')]
        .into_iter()
        .find_map(|(open, close)| {
            balanced(trimmed, open, close).or_else(|| spanning(trimmed, open, close))
        })
        .unwrap_or(trimmed)
        .to_owned()
}

/// Each fenced block replaced by its content: a fence, an optional word
/// naming the language, an optional line break, then everything up to the
/// next fence or the end of the text.
fn without_code_fences(text: &str) -> String {
    const FENCE: &str = "```";

    let mut kept = String::with_capacity(text.len());
    let mut rest = text;

    while let Some(at) = rest.find(FENCE) {
        kept.push_str(&rest[..at]);

        let after = &rest[at + FENCE.len()..];
        let after = after.trim_start_matches(|character: char| {
            character.is_ascii_alphanumeric() || character == '_'
        });
        let after = after.strip_prefix('\n').unwrap_or(after);
        let (content, next) = after.find(FENCE).map_or((after, ""), |end| {
            (&after[..end], &after[end + FENCE.len()..])
        });

        kept.push_str(content);
        rest = next;
    }

    kept.push_str(rest);
    kept
}

/// Every closed `<think>` block removed; an unclosed one stays.
fn without_think_blocks(text: &str) -> String {
    const OPEN: &str = "<think>";
    const CLOSE: &str = "</think>";

    let mut kept = String::with_capacity(text.len());
    let mut rest = text;

    while let Some(start) = rest.find(OPEN) {
        let Some(end) = rest[start..].find(CLOSE) else {
            break;
        };

        kept.push_str(&rest[..start]);
        rest = &rest[start + end + CLOSE.len()..];
    }

    kept.push_str(rest);
    kept
}

/// The first span from an `open` to its balancing `close` that parses as
/// JSON, skipping what sits inside strings; a span that balances and does
/// not parse ends the try from that `open`.
fn balanced(text: &str, open: u8, close: u8) -> Option<&str> {
    let bytes = text.as_bytes();

    (0..bytes.len())
        .filter(|&start| bytes[start] == open)
        .find_map(|start| {
            let (mut depth, mut in_string, mut escaped) = (0_usize, false, false);

            for (at, &byte) in bytes.iter().enumerate().skip(start) {
                if escaped {
                    escaped = false;
                    continue;
                }

                match byte {
                    b'\\' => escaped = true,
                    b'"' => in_string = !in_string,
                    _ if in_string => {}
                    _ if byte == open => depth += 1,
                    _ if byte == close => {
                        depth -= 1;

                        if depth == 0 {
                            let candidate = &text[start..=at];

                            return parses(candidate).then_some(candidate);
                        }
                    }
                    _ => {}
                }
            }

            None
        })
}

/// The span from the first `open` to the last `close`, if it parses.
fn spanning(text: &str, open: u8, close: u8) -> Option<&str> {
    let first = text.bytes().position(|byte| byte == open)?;
    let last = text.bytes().rposition(|byte| byte == close)?;
    let candidate = text.get(first..=last).filter(|_| last > first)?;

    parses(candidate).then_some(candidate)
}

fn parses(candidate: &str) -> bool {
    serde_json::from_str::<Value>(candidate).is_ok()
}

/// `text` whole when it has at most `max_chars` characters, otherwise its
/// first `max_chars` and an ellipsis.
fn cut(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((end, _)) => format!("{}...", &text[..end]),
        None => text.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use sha2::{Digest, Sha256};

    use super::*;
    use crate::record::Role;

    fn message(role: Role, content: &str) -> Message {
        Message {
            role,
            content: content.to_owned(),
        }
    }

    #[test]
    fn the_system_prompt_is_mem0s_own_byte_for_byte() {
        let mut digest = String::new();

        for byte in Sha256::digest(SYSTEM_PROMPT.as_bytes()) {
            write!(digest, "{byte:02x}").unwrap();
        }

        assert_eq!(SYSTEM_PROMPT.chars().count(), 33_655);
        assert_eq!(
            digest,
            "f7601d55bea65c561206224f3237689c63c06a5aafee54f415e764b0de6bff7e"
        );
    }

    /// The second captured turn of the study's run, which mem0ai sent as
    /// written here, with an earlier line long enough to be cut.
    #[test]
    fn the_user_message_is_mem0s_template() {
        let long = format!("Mike: {}", "tea ".repeat(80));
        let history = [
            message(
                Role::User,
                "Mike: I love green tea, especially sencha first thing in the morning.",
            ),
            message(
                Role::Assistant,
                "Mira: Sencha in the morning it is. I'll remember that.",
            ),
            message(Role::User, &long),
        ];
        let existing =
            ["Mike loves green tea, especially sencha first thing in the morning".to_owned()];
        let extraction = Extraction {
            history: &history,
            existing: &existing,
            new_messages: "user: Mike: My cat Biscuit knocked my telescope over last night.\n\
                           assistant: Mira: Oh no! Is Biscuit okay? And the telescope?",
            observed_on: &ObservedOn::parse("2026-10-18").unwrap(),
        };
        let cut_line = format!("user: {}...", &long[..300]);

        assert_eq!(
            extraction.user_message(),
            format!(
                "## Summary\n\n\n## Last k Messages\n\
                 user: Mike: I love green tea, especially sencha first thing in the morning.\n\
                 assistant: Mira: Sencha in the morning it is. I'll remember that.\n\
                 {cut_line}\n\n\n\
                 ## Recently Extracted Memories\n[]\n\n\
                 ## Existing Memories\n\
                 [{{\"id\":\"0\",\"text\":\"Mike loves green tea, especially sencha first thing \
                 in the morning\"}}]\n\n\
                 ## New Messages\n\
                 user: Mike: My cat Biscuit knocked my telescope over last night.\n\
                 assistant: Mira: Oh no! Is Biscuit okay? And the telescope?\n\n\
                 ## Observation Date\n2026-10-18\n\n\
                 ## Current Date\n2026-10-18\n\n\
                 ## Custom Instructions\n\
                 Refer to people by the names used in the conversation; never call anyone \
                 \"user\" or \"assistant\".\n\n\
                 # Output:"
            )
        );
    }

    #[test]
    fn the_memories_are_found_wherever_the_model_put_its_json() {
        let listed = r#"{"memory": [{"id": "0", "text": "Sam likes tea."}]}"#;

        for answer in [
            listed.to_owned(),
            format!("```json\n{listed}\n```"),
            format!("<think>The user {{likes}} tea.</think>\n{listed}"),
            format!("{listed}<|eot_id|>"),
            format!("Here you go: {listed} Anything else?"),
            format!("{{broken {listed}"),
        ] {
            assert_eq!(
                extracted_memories(&answer),
                Ok(vec!["Sam likes tea.".to_owned()]),
                "{answer}"
            );
        }

        assert_eq!(
            extracted_memories(
                r#"{"memory": [{"id": "0", "text": "A"}, {"id": "1"}, {"text": " "},
                    {"id": "2", "text": "A"}, {"id": "3", "text": "B", "attributed_to": "user"}]}"#
            ),
            Ok(vec!["A".to_owned(), "B".to_owned()])
        );
        assert_eq!(extracted_memories(r#"{"memory": []}"#), Ok(Vec::new()));
    }

    #[test]
    fn an_answer_without_a_memory_list_is_unreadable() {
        for answer in [
            "",
            "I cannot help with that.",
            r#"{"memories": [{"text": "Sam likes tea."}]}"#,
            r#"[{"id": "0", "text": "Sam likes tea."}]"#,
            r#"{"memory": "Sam likes tea."}"#,
            "<think>Nothing here.",
        ] {
            assert_eq!(
                extracted_memories(answer),
                Err(UnreadableExtractionError),
                "{answer}"
            );
        }
    }
}

/// The prompt against a live OpenAI-wire model, which no automatic run
/// reaches: `P02_LIVE_BASE_URL` names the endpoint, `P02_LIVE_MODEL` the
/// model, and `P02_LIVE_API_KEY` its key when it takes one.
#[cfg(test)]
mod live_check {
    use std::env;
    use std::time::Instant;

    use p02_shared::BaseUrl;

    use super::*;
    use crate::wire::{Client, Endpoint};

    #[tokio::test]
    #[ignore = "it calls the model the environment names"]
    async fn a_live_model_extracts_memories_with_mem0s_prompt() {
        let base_url = env::var("P02_LIVE_BASE_URL").expect("P02_LIVE_BASE_URL names the endpoint");
        let model = env::var("P02_LIVE_MODEL").expect("P02_LIVE_MODEL names the model");
        let key = env::var("P02_LIVE_API_KEY").ok();
        let endpoint =
            Endpoint::new(BaseUrl::parse(&base_url).unwrap(), key.as_deref(), &model).unwrap();
        let user_message = Extraction {
            history: &[],
            existing: &[],
            new_messages: "user: Sam: I just moved to Lisbon with my cat Biscuit, and I start \
                           at the observatory on Monday.\n\
                           assistant: Mira: Lisbon and an observatory! Biscuit will love the \
                           light.",
            observed_on: &ObservedOn::parse("2026-10-20").unwrap(),
        }
        .user_message();
        let started = Instant::now();
        let answer = Client::new()
            .unwrap()
            .complete_json(&endpoint, SYSTEM_PROMPT, &user_message)
            .await
            .unwrap();

        println!(
            "model: {model}\nseconds: {:.1}\nanswer: {answer}",
            started.elapsed().as_secs_f64()
        );

        let memories = extracted_memories(&answer).expect("the answer holds a memory list");

        for memory in &memories {
            println!("memory: {memory}");
        }

        assert!(
            !memories.is_empty(),
            "the model extracted nothing from a turn full of facts"
        );
    }
}
