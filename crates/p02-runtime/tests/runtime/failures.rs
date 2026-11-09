//! A turn the runtime itself fails, on a write the disk refuses, and the
//! thread a restarted character opens after it.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use p02_contracts::{BeforeRoleModelCallOutput, CharacterStorage};
use p02_runtime::{Delivery, Progress, RunTurnError};
use p02_store::{RecordBody, RecordKind, RuntimeRejection, TurnRejection};
use serde_json::json;
use tokio::sync::Notify;

use crate::support::{Chat, Round, Toy, id, make_read_only, reply, restore};

/// A reply whose write fails after the reply before it was shown was only
/// ever a draft: it is withdrawn and never announced, the turn's rejection
/// names the shown reply, and what a plugin wrote to its store before the
/// failure stays.
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
        Round::says(reply(&["Let me look.", "Found it."])).drafting(1, &["Fou", "nd it."]),
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

    assert!(matches!(failed, Delivery::Failed(_)), "{failed:?}");
    assert_eq!(
        chat.heard.take(),
        [
            "user_message hello there",
            "reply_delta 1.1 Fou",
            "reply_delta 1.1 nd it.",
            "visible_reply 1.0 Let me look.",
            "reply_withdrawn 1.1",
        ]
    );
    assert_eq!(chat.reopen().await, None);

    let Delivery::Completed(turn) = chat.say("hello again", "again").await else {
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

/// A delivery its caller drops while the model is still answering loses the
/// thread, every later step failing, its close too, and the thread opened
/// again goes on, its next line closing the turn the dropped one left open.
#[tokio::test]
async fn a_thread_whose_delivery_was_dropped_opens_again_and_goes_on() {
    let mut chat = Chat::new(&[]);
    let asking = Notify::new();

    chat.model
        .script([Round::hangs(), Round::says(reply(&["Here."]))]);

    tokio::select! {
        () = asking.notified() => {}
        delivery = chat.say_hearing("Still there?", "first", |progress| {
            if let Progress::UserMessage { .. } = progress {
                asking.notify_one();
            }
        }) => panic!("the model never answers: {delivery:?}"),
    }

    let lost = chat.say("Hello?", "second").await;
    let closed = chat.reopen().await;
    let reopened = chat.say("Hello?", "third").await;

    assert!(
        matches!(lost, Delivery::Failed(RunTurnError::StateLost)),
        "{lost:?}"
    );
    assert_eq!(
        closed.as_deref(),
        Some("the conversation lost its hold on the disk to an earlier failure")
    );
    assert!(matches!(reopened, Delivery::Completed(_)), "{reopened:?}");
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
}
