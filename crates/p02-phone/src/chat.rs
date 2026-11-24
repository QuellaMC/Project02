//! The apps she and the person write to each other in: Messages, which
//! every phone comes with, and a connector's app, as Telegram, exactly while
//! it carries her messages, as her phone's caller says. They are the
//! phone's own, written here with no script, since they show what no app is
//! given: the conversation, which her phone's caller reads. Each has one
//! view, the newest messages that went through it, and no action: a message
//! is sent one way only, her `send_message`.

use std::fmt;

use p02_core::{AppNames, VisibleMessageRole};
use p02_wire::{BubbleFrom, HistoryMessage, Screen, ScreenItem};
use serde_json::json;

use crate::app::App;
use crate::error::PhoneError;
use crate::manifest::Manifest;
use crate::time::Now;

/// The one view of each, the conversation as it went through it.
const VIEW: &str = "conversation";
/// How many of the newest messages there her screen shows.
const NEWEST: usize = 20;
/// The most of a message a bubble shows, in bytes of UTF-8, so that a
/// screen of twenty keeps well within the JSON limits every answer of her
/// phone is held to.
const BUBBLE_BYTES: usize = 2 * 1_024;
/// Longer than this after the message before it, a message has the day and
/// the time above it.
const PAUSE_MILLIS: i64 = 15 * 60 * 1_000;

const SUMMARY: &str = "Your messages";
const NONE_YET: &str = "No Messages";
const ELLIPSIS: &str = "…";

/// The conversation between her and the person, as her phone's caller
/// reads it for her phone's own apps.
pub trait Chats: Send + Sync + fmt::Debug {
    /// The apps that carry her messages now, by their ids and names:
    /// Messages, first, then each connector's app that does.
    fn apps(&self) -> AppNames;

    /// The newest messages of the conversation that went through `app`,
    /// `count` at most, oldest first, as the scrollback reads them.
    ///
    /// # Errors
    ///
    /// Why the conversation could not be read, in a few words.
    fn newest(&self, app: &str, count: usize) -> Result<Vec<HistoryMessage>, String>;
}

/// The app of `id` that messages come in, `name` as she and the person read
/// it: drawn by the icon and the tint named as its id, with its one view.
pub(crate) fn app(id: &str, name: &str) -> App {
    let manifest = Manifest::read(json!({
        "format": "project02.app.v1",
        "id": id,
        "name": name,
        "summary": SUMMARY,
        "version": "1.0.0",
        "icon": id,
        "tint": id,
        "wakes": false,
        "views": [{"id": VIEW, "title": name, "icon": id}],
        "opensOn": VIEW,
        "actions": [],
    }))
    .expect("an app messages come in keeps every rule an app's manifest does");

    App::chat(manifest)
}

/// The apps messages come in that are on her phone now, as `chats` says
/// them, Messages first.
pub(crate) fn apps(chats: &dyn Chats) -> Vec<App> {
    let named = chats.apps();

    named.ids().map(|id| app(id, named.name(id))).collect()
}

/// What `app`'s view shows her at `now`: the newest messages that went
/// through it, hers and the person's as bubbles, a long one as much of it
/// as a bubble shows, and a note of the day and the time, where the person
/// is, above the first and above one sent on another day or more than 15
/// minutes after the one before it; while there are none, one line saying
/// so.
pub(crate) fn screen(chats: &dyn Chats, app: &App, now: &Now) -> Result<Screen, PhoneError> {
    let said = chats
        .newest(app.id().as_str(), NEWEST)
        .map_err(|why| PhoneError::Threw {
            app: app.name().to_owned(),
            thrown: format!("the conversation could not be read: {why}"),
        })?;

    if said.is_empty() {
        return Ok(Screen {
            items: vec![ScreenItem::Text {
                text: NONE_YET.to_owned(),
            }],
            page: None,
        });
    }

    let mut items = Vec::new();
    let mut before: Option<&HistoryMessage> = None;

    for message in &said {
        let at = message.sent_at.in_zone(now.zone().clone());
        let passed = before.is_none_or(|before| {
            let then = before.sent_at.in_zone(now.zone().clone());

            then.date() != at.date()
                || message.sent_at.unix_millis() - before.sent_at.unix_millis() > PAUSE_MILLIS
        });

        if passed {
            items.push(ScreenItem::Note {
                text: at.strftime("%A, %B %-d, %H:%M").to_string(),
            });
        }

        items.push(ScreenItem::Bubble {
            from: match message.role {
                VisibleMessageRole::Character => BubbleFrom::Her,
                VisibleMessageRole::User => BubbleFrom::Them,
            },
            text: bubbled(message.text.as_str()),
        });
        before = Some(message);
    }

    Ok(Screen { items, page: None })
}

/// `text` whole while a bubble shows it all, otherwise as much of it as it
/// shows, cut at a character and ended with an ellipsis.
fn bubbled(text: &str) -> String {
    if text.len() <= BUBBLE_BYTES {
        return text.to_owned();
    }

    let end = text
        .char_indices()
        .map(|(start, character)| start + character.len_utf8())
        .take_while(|&end| end <= BUBBLE_BYTES - ELLIPSIS.len())
        .last()
        .unwrap_or(0);

    format!("{}{ELLIPSIS}", &text[..end])
}
