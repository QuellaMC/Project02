//! A turn the runtime itself fails, on a write the disk refuses, and the
//! thread a restarted character opens after it.

use std::fs::Permissions;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use p02_contracts::{BeforeRoleModelCallOutput, CharacterStorage};
use p02_runtime::Delivery;
use p02_store::RecordKind;
use serde_json::json;

use crate::support::{Chat, Round, Toy, id, make_read_only, reply, restore};

/// A round that drafts its reply and makes the thread's log read-only just
/// before it answers, so the round's own record is the write that fails,
/// handing back what the log's permissions were.
fn failing_round(log: PathBuf) -> (Round, Arc<Mutex<Option<Permissions>>>) {
    let writable: Arc<Mutex<Option<Permissions>>> = Arc::default();
    let round = {
        let writable = Arc::clone(&writable);

        Round::says(reply(&["noted"]))
            .drafting(&["no", "ted"])
            .first(move || *writable.lock().unwrap() = Some(make_read_only(&log)))
    };

    (round, writable)
}

/// stream.draft-never-a-message: a reply whose write fails was only ever a draft: it is withdrawn and never announced as a message, the turn fails, and the log holds the person's line alone, in a turn still open
#[tokio::test]
async fn a_reply_whose_write_fails_was_only_a_draft() {
    let mut chat = Chat::new(&[]);
    let (round, writable) = failing_round(chat.log(1));

    chat.model.script([round]);

    let delivery = chat.say("hello there", "hello").await;

    restore(&chat.log(1), writable.lock().unwrap().take().unwrap());

    assert!(matches!(delivery, Delivery::Failed { .. }), "{delivery:?}");
    assert_eq!(
        chat.heard.take(),
        [
            "user_message hello there",
            "reply_delta 1.0 no",
            "reply_delta 1.0 ted",
            "reply_withdrawn 1.0",
        ]
    );
    assert_eq!(
        chat.kinds(1),
        [
            RecordKind::RuntimeEventReceived,
            RecordKind::VisibleMessageCommitted
        ]
    );
}

/// storage.append-failure-recovery: after a turn failed on a write, the thread a restarted character opens once the disk takes writes again reads back valid, its next line completes, and what a plugin wrote to its store before the failure is still there
#[tokio::test]
async fn a_thread_reopened_after_a_failed_write_reads_back_and_goes_on() {
    let keeper = Toy::new("keeper")
        .access(json!({"character_file_store": "write"}))
        .before(|context| {
            context
                .character_file_store()
                .unwrap()
                .with_lease(|store| store.write_json("mood.json", &json!({"mood": "curious"})))?;
            Ok(BeforeRoleModelCallOutput::default())
        });
    let mut chat = Chat::new(&[Arc::new(keeper)]);
    let thread = chat.id();
    let (round, writable) = failing_round(chat.log(1));

    chat.model.script([round, Round::says(reply(&["Again."]))]);

    let failed = chat.say("hello there", "hello").await;

    restore(&chat.log(1), writable.lock().unwrap().take().unwrap());
    assert!(matches!(failed, Delivery::Failed { .. }), "{failed:?}");
    assert_eq!(chat.reopen().await, None);

    let Delivery::Completed { turn, .. } = chat.say("hello again", "again").await else {
        panic!("the reopened thread takes the next line");
    };
    let store = chat.world.data().file_store(&id("keeper"));
    let mood = store
        .lease(Instant::now() + Duration::from_secs(2))
        .unwrap()
        .read_json("mood.json")
        .unwrap();

    assert_eq!(
        turn.messages
            .iter()
            .map(|message| message.id.to_string())
            .collect::<Vec<_>>(),
        [
            format!("{thread}.1:message-2"),
            format!("{thread}.1:message-3")
        ]
    );
    assert_eq!(
        chat.kinds(1),
        [
            RecordKind::RuntimeEventReceived,
            RecordKind::VisibleMessageCommitted,
            RecordKind::RuntimeEventReceived,
            RecordKind::VisibleMessageCommitted,
            RecordKind::RoleModelRound,
            RecordKind::VisibleMessageCommitted,
            RecordKind::RuntimeTurnCompleted,
        ]
    );
    assert_eq!(mood, Some(json!({"mood": "curious"})));
}
