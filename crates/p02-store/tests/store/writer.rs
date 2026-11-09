//! A session's writer: one at a time, appending only what follows its log,
//! after whatever a crash or a failed write left after the last line.

use std::num::NonZeroU32;

use p02_store::{Judgement, LogRecord, RecordBody, StorageError, TurnCompleted};
use serde_json::json;

use crate::support::{Script, World, answer, lines_of, written};

#[test]
fn a_session_has_one_writer_at_a_time() {
    let world = World::new();
    let writer = world.first_segment(&world.conversation).unwrap();
    let busy = world.log(1).writer().unwrap_err();

    assert_eq!(busy.code(), "session_busy");
    assert!(busy.to_string().contains("session-writer:"), "{busy}");
    writer.release();
    world.log(1).writer().unwrap().release();
}

#[test]
fn a_record_the_log_does_not_take_is_refused_and_nothing_lands() {
    let world = World::new();
    let mut script = Script::new(world.segment(1));
    let mut writer = world.first_segment(&world.conversation).unwrap();

    script
        .turn("Hello?")
        .user("hello")
        .round(Some(answer(&["Hi."], &[], None)))
        .replies()
        .completed();

    let path = world.path_of(&world.segment(1));
    let stranger = LogRecord::new(
        p02_core::EventIdentity::new(
            p02_core::EventId::new("evt_stranger").unwrap(),
            p02_core::TraceId::new("trace_stranger").unwrap(),
            p02_core::Timestamp::now(),
        )
        .unwrap(),
        RecordBody::TurnCompleted(TurnCompleted {
            visible_message_ids: Vec::new(),
            tool_call_ids: Vec::new(),
            judgement: Judgement {
                round: NonZeroU32::MIN,
                accepted_reply: None,
            },
            runtime_plugin_evidence: Vec::new(),
        }),
    );

    writer.append(script.records[0].clone()).unwrap();

    let before = std::fs::read(&path).unwrap();
    let refused = writer.append(stranger).unwrap_err();

    assert!(matches!(refused, StorageError::Refused(_)), "{refused}");
    assert_eq!(refused.code(), "malformed_record");
    assert_eq!(std::fs::read(&path).unwrap(), before);

    for record in &script.records[1..] {
        writer.append(record.clone()).unwrap();
    }

    writer.release();
    assert_eq!(world.log(1).read().unwrap().records(), script.records);
}

/// A write that failed half way leaves a torn line, as a crash does: the
/// writer reads its log again, cuts it, and goes on.
#[test]
fn a_writer_reads_its_log_again_when_it_changed_beneath_it_and_cuts_a_torn_line() {
    let world = World::new();
    let mut script = Script::new(world.segment(1));
    let mut writer = world.first_segment(&world.conversation).unwrap();

    script
        .turn("Hello?")
        .user("hello")
        .round(Some(answer(&["Hi."], &[], None)))
        .replies()
        .completed();

    let path = world.path_of(&world.segment(1));
    let (head, tail) = script.records.split_at(3);

    for record in head {
        writer.append(record.clone()).unwrap();
    }

    let torn = tail[0].to_line();
    let mut bytes = std::fs::read(&path).unwrap();

    bytes.extend_from_slice(&torn.as_bytes()[..torn.len() / 3]);
    std::fs::write(&path, bytes).unwrap();
    assert_eq!(writer.replay().unwrap().records(), head);

    for record in tail {
        writer.append(record.clone()).unwrap();
    }

    writer.release();
    assert_eq!(
        lines_of(&path),
        script
            .records
            .iter()
            .map(LogRecord::to_line)
            .collect::<Vec<_>>()
    );
}

#[test]
fn a_log_never_holds_a_credential_and_is_made_owner_only() {
    let world = World::new();
    let mut script = Script::new(world.segment(1));
    let mut writer = world.first_segment(&world.conversation).unwrap();

    let credential = "model-written-credential";

    script
        .turn("Patch?")
        .user("patch")
        .round(Some(written(
            [(
                "character_state.patch",
                json!({"mood": "curious", "api_key": credential}),
            )],
            None,
        )))
        .start_calls()
        .finish_calls()
        .round(Some(answer(&["Done."], &[], None)))
        .replies()
        .completed();

    for record in &script.records {
        writer.append(record.clone()).unwrap();
    }

    writer.release();

    let path = world.path_of(&world.segment(1));
    let log = std::fs::read_to_string(&path).unwrap();

    assert!(!log.contains(credential));
    assert!(!log.contains("kept-secret"));
    assert!(log.contains(r#""api_key":"[redacted]""#));
    #[cfg(unix)]
    assert_eq!(
        std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&path).unwrap().permissions())
            & 0o777,
        0o600
    );
}
