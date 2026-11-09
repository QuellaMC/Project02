//! What the model reads of the index: every text cut to a cap sized so a
//! full answer stays inside the JSON limits, and the hit of each session
//! flagged, with a snippet centered on where the query matched.

use serde_json::{Map, Value};

use super::index::{Hits, IndexedMessage, SessionView, Window, fold, fold_character};
use crate::text::{ELLIPSIS, excerpt};

const SEARCH_TEXT_CHARS: usize = 200;
const READ_TEXT_CHARS: usize = 400;
const SPEAKER_NAME_CHARS: usize = 80;
const SNIPPET_CHARS: usize = 160;

pub(super) fn search(hits: &Hits, query: &str) -> Value {
    let sessions = hits.views.iter().map(|view| session(view, query)).collect();

    Value::Object(Map::from_iter([
        ("sessions".to_owned(), Value::Array(sessions)),
        (
            "totalSessionsWithHits".to_owned(),
            Value::from(hits.sessions_with_hits),
        ),
    ]))
}

pub(super) fn read(session_id: &str, window: &Window) -> Value {
    let messages = window
        .messages
        .iter()
        .map(|message| Value::Object(message_fields(message, READ_TEXT_CHARS)))
        .collect();

    Value::Object(Map::from_iter([
        ("sessionId".to_owned(), Value::from(session_id)),
        ("messages".to_owned(), Value::Array(messages)),
        ("hasBefore".to_owned(), Value::from(window.has_before)),
        ("hasAfter".to_owned(), Value::from(window.has_after)),
    ]))
}

fn session(view: &SessionView, query: &str) -> Value {
    let listed = |messages: &[IndexedMessage]| {
        Value::Array(
            messages
                .iter()
                .map(|message| Value::Object(message_fields(message, SEARCH_TEXT_CHARS)))
                .collect(),
        )
    };
    let around = view
        .around
        .iter()
        .map(|message| {
            let mut fields = message_fields(message, SEARCH_TEXT_CHARS);

            if message.message_id == view.hit {
                fields.insert("matched".to_owned(), Value::Bool(true));
                fields.insert(
                    "snippet".to_owned(),
                    Value::from(snippet(&message.text, query)),
                );
            }

            Value::Object(fields)
        })
        .collect();

    Value::Object(Map::from_iter([
        (
            "sessionId".to_owned(),
            Value::from(view.session_id.as_str()),
        ),
        ("conversationStart".to_owned(), listed(&view.start)),
        ("aroundMatch".to_owned(), Value::Array(around)),
        ("conversationEnd".to_owned(), listed(&view.end)),
    ]))
}

fn message_fields(message: &IndexedMessage, text_chars: usize) -> Map<String, Value> {
    Map::from_iter([
        (
            "messageId".to_owned(),
            Value::from(message.message_id.as_str()),
        ),
        ("role".to_owned(), Value::from(message.role.as_str())),
        (
            "speakerName".to_owned(),
            Value::from(excerpt(&message.speaker_name, SPEAKER_NAME_CHARS)),
        ),
        (
            "committedAt".to_owned(),
            Value::from(message.committed_at.as_str()),
        ),
        (
            "text".to_owned(),
            Value::from(excerpt(&message.text, text_chars)),
        ),
    ])
}

/// The text around the first place the query matches, ellipses marking
/// what was left out; the head of the text when it matches at the start or
/// nowhere a plain search can see.
fn snippet(text: &str, query: &str) -> String {
    let length = text.chars().count();

    if length <= SNIPPET_CHARS {
        return text.to_owned();
    }

    let Some(at) = match_start(text, query).filter(|&at| at > 0) else {
        return excerpt(text, SNIPPET_CHARS).into_owned();
    };
    let core = SNIPPET_CHARS - 2 * ELLIPSIS.len();
    let start = at.saturating_sub(core / 2).min(length - core);
    let end = start + core;

    format!(
        "{}{}{}",
        if start > 0 { ELLIPSIS } else { "" },
        text.chars().skip(start).take(core).collect::<String>(),
        if end < length { ELLIPSIS } else { "" }
    )
}

/// The character where the folded query first occurs in the folded text,
/// counted in the text as written.
fn match_start(text: &str, query: &str) -> Option<usize> {
    let needle = fold(query);
    let mut folded = String::with_capacity(text.len());
    let mut origins = Vec::with_capacity(text.len());

    for (at, character) in text.chars().enumerate() {
        for folded_character in fold_character(character) {
            folded.push(folded_character);
            origins.push(at);
        }
    }

    let found = folded.find(&needle)?;

    origins.get(folded[..found].chars().count()).copied()
}
