//! A character's history as her plugins read it through her storage: the
//! sessions her catalog lists, and each session's committed messages from
//! a cursor, a batch at a time, what the reads skip counted as damage.

use std::num::NonZeroUsize;

use p02_contracts::{
    CharacterStorage, HistoryCursor, HistoryMessage, MessageBatch, ReadMessages, SessionListing,
    SessionSummary,
};
use p02_store::{LogRecord, RecordBody};

use crate::history::written;
use crate::support::{Script, World, answer};

/// The messages `records` commit, as the history hands them out.
fn committed(records: &[LogRecord]) -> Vec<HistoryMessage> {
    records
        .iter()
        .filter_map(|record| match record.body() {
            RecordBody::MessageCommitted(commit) => Some(HistoryMessage {
                message: commit.message().clone(),
                committed_at: record.identity().created_at().clone(),
            }),
            _ => None,
        })
        .collect()
}

fn texts(batch: &MessageBatch) -> Vec<&str> {
    batch
        .messages
        .iter()
        .map(|message| message.message.text.as_str())
        .collect()
}

#[test]
fn history_is_read_a_batch_at_a_time_from_cursors_that_hold_across_a_reopen() {
    let world = World::new();
    let mut script = Script::new(world.segment(1));
    let writer = world.first_segment(&world.conversation).unwrap();
    let entry = world.data.session(writer.session_id()).unwrap();

    for (line, reply) in [
        ("Tea?", "Tea, always."),
        ("Coffee?", "Never."),
        ("Water?", "Fine."),
    ] {
        script
            .turn(line)
            .user(&line.to_lowercase().replace('?', ""))
            .round(Some(answer(&[reply], &[], None)))
            .replies()
            .completed();
    }

    written(writer, &script.records);

    let feed = world.data.session_history();

    assert_eq!(
        feed.list_sessions().unwrap(),
        SessionListing {
            sessions: vec![SessionSummary {
                session_id: entry.session_id().clone(),
                created_at: entry.created_at().clone(),
            }],
        }
    );

    let mut read = Vec::new();
    let mut cursor = None;
    let mut batches = 0;

    loop {
        let request = ReadMessages::from_start(world.segment(1)).within(NonZeroUsize::MIN);
        let request = match cursor.clone() {
            Some(cursor) => request.after(cursor),
            None => request,
        };
        let batch = feed.read_messages(&request).unwrap();

        batches += 1;
        assert!(!batch.reset);
        read.extend(batch.messages);

        if cursor.as_ref() == Some(&batch.next_cursor) {
            break;
        }

        cursor = Some(batch.next_cursor);
    }

    assert_eq!(read, committed(&script.records));
    assert_eq!(
        batches,
        script.records.len() + 1,
        "a line a batch, then none"
    );

    let earlier = script.records.len();

    script
        .turn("Juice?")
        .user("juice")
        .round(Some(answer(&["Maybe."], &[], None)))
        .replies()
        .completed();
    written(world.log(1).writer().unwrap(), &script.records[earlier..]);

    let reopened = world.data.session_history();
    let caught_up = |cursor: HistoryCursor| {
        reopened
            .read_messages(&ReadMessages::from_start(world.segment(1)).after(cursor))
            .unwrap()
    };
    let rest = caught_up(cursor.unwrap());

    let again = caught_up(rest.next_cursor.clone());

    assert_eq!(texts(&rest), ["Juice?", "Maybe."]);
    assert_eq!(again.messages, Vec::new());
    assert_eq!(again.next_cursor, rest.next_cursor);

    for stale in ["1", "99999999", "not-a-cursor"] {
        let batch = caught_up(HistoryCursor::new(stale));

        assert!(batch.reset, "{stale}");
        assert_eq!(batch.messages, committed(&script.records), "{stale}");
    }
}

/// A session damaged by a line that is no record and a round torn in two:
/// each is skipped, and every message around them is read; a catalog row
/// that is no session row is passed over.
#[test]
fn damage_is_read_past() {
    let world = World::new();
    let mut script = Script::new(world.segment(1));

    world.first_segment(&world.conversation).unwrap().release();

    for (line, reply) in [
        ("Tea?", "Tea, always."),
        ("Coffee?", "Never."),
        ("Water?", "Fine."),
    ] {
        script
            .turn(line)
            .user(&line.to_lowercase().replace('?', ""))
            .round(Some(answer(&[reply], &[], None)))
            .replies()
            .completed();
    }

    let mut lines: Vec<String> = script.records.iter().map(LogRecord::to_line).collect();
    let second = lines.len() / 3;

    lines[second + 2] = r#"{"eventId": "evt_torn"}"#.to_owned();
    lines.insert(second, "not-json".to_owned());
    std::fs::write(
        world.path_of(&world.segment(1)),
        format!("{}\n", lines.join("\n")),
    )
    .unwrap();
    world
        .next_segment(&world.conversation, 1)
        .unwrap()
        .release();

    let catalog = world.data.root().join("sessions.jsonl");
    let rows = std::fs::read_to_string(&catalog).unwrap();

    std::fs::write(&catalog, format!("{rows}{{\"sessionId\": 7}}\n")).unwrap();

    let feed = world.data.session_history();
    let older = feed
        .read_messages(&ReadMessages::from_start(world.segment(1)))
        .unwrap();
    let current = feed
        .read_messages(&ReadMessages::from_start(world.segment(2)))
        .unwrap();
    let listing = feed.list_sessions().unwrap();

    assert_eq!(listing.sessions.len(), 2);
    assert_eq!(
        texts(&older),
        [
            "Tea?",
            "Tea, always.",
            "Coffee?",
            "Never.",
            "Water?",
            "Fine."
        ]
    );
    assert!(!older.reset);
    assert_eq!(
        current,
        MessageBatch {
            messages: Vec::new(),
            next_cursor: HistoryCursor::new("0"),
            reset: false,
        }
    );
}
