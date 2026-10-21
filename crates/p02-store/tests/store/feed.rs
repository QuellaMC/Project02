//! A character's history as her plugins read it through her storage: the
//! sessions her catalog lists, and each session's committed messages from
//! a cursor, a batch at a time, read past damage the log's own read
//! refuses.

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
    let entry = world.first_segment(world.conversation.id()).unwrap();

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

    written(&world, 1, &script.records);

    let feed = world.data.session_history();

    assert_eq!(
        feed.list_sessions().unwrap(),
        SessionListing {
            sessions: vec![SessionSummary {
                session_id: entry.session_id().clone(),
                created_at: entry.created_at().clone(),
            }],
            damaged_entry_count: 0,
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
        assert_eq!(batch.damaged_record_count, 0);
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
    written(&world, 1, &script.records[earlier..]);

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

/// A session the runtime has left, damaged by a line that is no record and
/// a round that no longer reads: the gate skips each line it refuses, and
/// with the round the reply and the ending that needed it, so the turns
/// around them read as they were.
#[test]
fn a_damaged_older_segment_is_read_past_its_damage_while_its_log_refuses_it() {
    let world = World::new();
    let mut script = Script::new(world.segment(1));

    world.first_segment(world.conversation.id()).unwrap();

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

    lines[second + 3] = r#"{"eventId": "evt_torn"}"#.to_owned();
    lines.insert(second, "not-json".to_owned());
    std::fs::write(
        world.path_of(&world.segment(1)),
        format!("{}\n", lines.join("\n")),
    )
    .unwrap();
    world.next_segment(&world.segment(1)).unwrap();

    let feed = world.data.session_history();
    let older = feed
        .read_messages(&ReadMessages::from_start(world.segment(1)))
        .unwrap();
    let current = feed
        .read_messages(&ReadMessages::from_start(world.segment(2)))
        .unwrap();

    assert_eq!(world.log(1).read().unwrap_err().code(), "malformed_record");
    assert_eq!(feed.list_sessions().unwrap().sessions.len(), 2);
    assert_eq!(
        texts(&older),
        ["Tea?", "Tea, always.", "Coffee?", "Water?", "Fine."]
    );
    assert_eq!((older.damaged_record_count, older.reset), (4, false));
    assert_eq!(
        current,
        MessageBatch {
            messages: Vec::new(),
            next_cursor: HistoryCursor::new("0"),
            damaged_record_count: 0,
            reset: false,
        }
    );
}
