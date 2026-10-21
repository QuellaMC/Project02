//! A turn the runtime itself fails, on a write the disk refuses, and the
//! thread a restarted character opens after it.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use p02_contracts::{BeforeRoleModelCallOutput, CharacterStorage};
use p02_runtime::{Delivery, Progress};
use p02_store::{RecordBody, RecordKind, RuntimeRejection, TurnRejection};
use serde_json::json;

use crate::support::{Chat, Round, Toy, id, make_read_only, reply, restore};

/// stream.draft-never-a-message: a reply whose write fails was only ever a draft: it is withdrawn and never announced as a message, the turn fails, and the log holds the person's line alone, in a turn still open
#[tokio::test]
async fn a_reply_whose_write_fails_was_only_a_draft() {
    let mut chat = Chat::new(&[]);
    let log = chat.log(1);
    let writable = Mutex::new(None);

    chat.model
        .script([Round::says(reply(&["noted"])).drafting(0, &["no", "ted"])]);

    // The log refuses writes from the reply's first piece on, so its round's
    // record, the first write the reply waits on, is the one that fails.
    let delivery = chat
        .say_hearing("hello there", "hello", |progress| {
            if let Progress::ReplyDelta { .. } = progress {
                writable
                    .lock()
                    .unwrap()
                    .get_or_insert_with(|| make_read_only(&log));
            }
        })
        .await;

    restore(&log, writable.into_inner().unwrap().unwrap());

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

/// storage.append-failure-recovery: when a reply's write fails after the reply before it was shown, the turn fails and its rejection anchors the shown reply, and the thread a restarted character opens reads back valid, its next line completes, and what a plugin wrote to its store before the failure is still there
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
    let log = chat.log(1);
    let writable = Mutex::new(None);

    chat.model.script([
        Round::says(reply(&["Let me look.", "Found it."])).drafting(1, &["Found", " it."]),
        Round::says(reply(&["Again."])),
    ]);

    // The log refuses writes from the first reply's announcement until the
    // second's draft is withdrawn, so the second reply's write fails and the
    // turn's own rejection lands.
    let failed = chat
        .say_hearing("hello there", "hello", |progress| match progress {
            Progress::VisibleReply { .. } => {
                *writable.lock().unwrap() = Some(make_read_only(&log));
            }
            Progress::ReplyWithdrawn { .. } => {
                restore(&log, writable.lock().unwrap().take().unwrap());
            }
            _ => {}
        })
        .await;

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
    let message = |n: u32| format!("{thread}.1:message-{n}");

    assert_eq!(
        chat.kinds(1),
        [
            RecordKind::RuntimeEventReceived,
            RecordKind::VisibleMessageCommitted,
            RecordKind::RoleModelRound,
            RecordKind::VisibleMessageCommitted,
            RecordKind::RuntimeTurnRejected,
            RecordKind::RuntimeEventReceived,
            RecordKind::VisibleMessageCommitted,
            RecordKind::RoleModelRound,
            RecordKind::VisibleMessageCommitted,
            RecordKind::RuntimeTurnCompleted,
        ]
    );

    let records = chat.records(1);
    let RecordBody::TurnRejected(rejected) = records[4].body() else {
        panic!("the failed turn ends rejected");
    };

    assert_eq!(
        rejected.rejection(),
        TurnRejection::Runtime(RuntimeRejection::RuntimeFailure)
    );
    assert_eq!(
        rejected
            .visible_message_ids
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        [message(1), message(2)]
    );
    assert_eq!(
        turn.messages
            .iter()
            .map(|message| message.id.to_string())
            .collect::<Vec<_>>(),
        [message(3), message(4)]
    );
    assert_eq!(mood, Some(json!({"mood": "curious"})));
}
