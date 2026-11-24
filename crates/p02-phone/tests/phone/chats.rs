//! The apps she and the person write to each other in, as her phone shows
//! them to her, in New York: what went through each, and under her newest
//! message whether the person read it.

use p02_core::{AppNames, MessageId, SpeakerName, Timestamp, VisibleMessageRole, VisibleText};
use p02_phone::{Phone, Read};
use p02_shared::Identifier;
use p02_wire::HistoryMessage;
use serde_json::{Value, json};

use crate::support::{Files, Talk, now};

/// When a message `minutes` after 23:30 on Thursday, March 5, 2026 in New
/// York was sent.
fn sent(minutes: i64) -> Timestamp {
    Timestamp::from_unix_millis(
        Timestamp::new("2026-03-06T04:30:00.000Z")
            .unwrap()
            .unix_millis()
            + minutes * 60_000,
    )
    .unwrap()
}

/// Message `number` of the conversation, `text`, sent `minutes` after
/// 23:30 in Telegram: the person's when `number` is even, hers when odd.
fn said(number: u64, text: &str, minutes: i64) -> HistoryMessage {
    let hers = number % 2 == 1;

    HistoryMessage {
        message_id: MessageId::parse(&format!("conv_a.1:message-{}", number + 1)).unwrap(),
        role: if hers {
            VisibleMessageRole::Character
        } else {
            VisibleMessageRole::User
        },
        speaker_id: Identifier::new(if hers { "mira" } else { "local-user" }).unwrap(),
        speaker_name: SpeakerName::new(if hers { "Mira" } else { "Sam" }).unwrap(),
        text: VisibleText::normalize(text).unwrap(),
        sent_at: sent(minutes),
        read_at: None,
        app: "telegram".to_owned(),
        source: None,
        client_message_id: None,
    }
}

/// The screen `app`'s conversation shows her, her phone's store `files`.
fn shown(files: &Files, talk: &Talk, app: &str) -> Value {
    let phone = Phone::bundled().unwrap();

    serde_json::to_value(
        phone
            .look(files, talk, app, "conversation", &now())
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn an_app_messages_come_in_shows_her_its_newest_twenty_with_the_day_and_time_where_time_passed() {
    // Twenty-two messages went through Telegram: twenty minutes pass before
    // the seventh, the ninth comes nine minutes after the eighth but on
    // another day, the tenth fifteen minutes after the ninth, and the last
    // is long.
    let minutes = [0, 1, 2, 3, 4, 5, 25, 26, 35, 50]
        .into_iter()
        .chain(51..=62)
        .collect::<Vec<i64>>();
    let long = "a".repeat(3_000);
    let messages = (0..22_u64)
        .zip(&minutes)
        .map(|(number, &minute)| {
            let text = if number == 21 {
                long.clone()
            } else {
                format!("Line {number}.")
            };

            said(number, &text, minute)
        })
        .collect();
    let talk = Talk {
        apps: AppNames::new([("telegram", "Telegram")]),
        messages,
    };
    let note = |text: &str| json!({"kind": "note", "text": text});
    let bubble = |number: u64| {
        json!({
            "kind": "bubble",
            "from": if number % 2 == 1 { "her" } else { "them" },
            "text": if number == 21 {
                format!("{}…", "a".repeat(2_045))
            } else {
                format!("Line {number}.")
            },
        })
    };
    let mut items = Vec::new();

    for number in 2..22 {
        match number {
            2 => items.push(note("Thursday, March 5, 23:32")),
            6 => items.push(note("Thursday, March 5, 23:55")),
            8 => items.push(note("Friday, March 6, 00:05")),
            _ => {}
        }

        items.push(bubble(number));
    }

    // Telegram tells nobody whether a message was read.
    items.push(note("Delivered"));

    assert_eq!(
        shown(&Files::default(), &talk, "telegram"),
        json!({"items": items})
    );
    assert_eq!(
        shown(&Files::default(), &talk, "messages"),
        json!({"items": [{"kind": "text", "text": "No Messages"}]})
    );
}

/// What she sees under her newest message in Messages once the person read
/// it or a later message, in any app, on a day that is not today: the day,
/// as her screen writes it; and under one newer than any they read, that
/// it was delivered.
#[test]
fn messages_says_her_newest_was_read_on_the_day_the_person_read_it_or_a_later_one() {
    let in_messages = |number: u64, text: &str| HistoryMessage {
        app: "messages".to_owned(),
        ..said(number, text, 0)
    };
    let talk = Talk {
        apps: AppNames::new([("telegram", "Telegram")]),
        messages: vec![
            in_messages(1, "Morning."),
            in_messages(2, "Morning to you."),
            in_messages(3, "Tea?"),
            said(5, "From Telegram.", 1),
        ],
    };
    let screen = |under: &str| {
        json!({"items": [
            {"kind": "note", "text": "Thursday, March 5, 23:30"},
            {"kind": "bubble", "from": "her", "text": "Morning."},
            {"kind": "bubble", "from": "them", "text": "Morning to you."},
            {"kind": "bubble", "from": "her", "text": "Tea?"},
            {"kind": "note", "text": under},
        ]})
    };
    // Friday noon in New York, the day before the moment the tests call now.
    let friday = Timestamp::new("2026-03-06T17:00:00.000Z").unwrap();
    let read = |number: u64| Read {
        message: MessageId::parse(&format!("conv_a.1:message-{}", number + 1)).unwrap(),
        at: friday.clone(),
    };
    let mut files = Files::default();

    read(1).keep(&mut files).unwrap();
    assert_eq!(shown(&files, &talk, "messages"), screen("Delivered"));

    read(5).keep(&mut files).unwrap();
    assert_eq!(
        shown(&files, &talk, "messages"),
        screen("Read Friday, March 6")
    );
}
