//! The thread across runs: what a reopened thread resumes, a line a run
//! before this one took, and what closing a thread lets go.

use std::num::NonZeroU64;

use p02_core::{MessageId, SessionId};
use p02_runtime::{Conversation, Delivery};

use crate::support::{Chat, Round, mira, reply, stamp};

fn session(text: &str) -> SessionId {
    SessionId::parse(text).unwrap()
}

/// A reopened thread resumes its latest segment with the history it holds,
/// and an empty segment an interrupted rotation left behind is discarded
/// and the one before it resumed.
#[tokio::test]
async fn a_reopened_thread_resumes_its_latest_whole_segment() {
    let mut chat = Chat::new(&[]);
    let id = chat.id();

    chat.model.script([
        Round::says(reply(&["Tea, always."])),
        Round::says(reply(&["Never."])),
    ]);
    chat.say("Tea?", "tea").await;

    let closed = chat.conversation.take().unwrap().close().await;
    let holder = chat
        .world
        .home
        .conversation_writer(chat.world.home.conversation(&id).unwrap())
        .unwrap();

    chat.world
        .data()
        .continue_session(&holder, &session(&format!("{id}.1")))
        .unwrap()
        .release();
    holder.release();
    chat.conversation = Some(chat.world.open());

    let Delivery::Completed { turn, .. } = chat.say("Coffee?", "coffee").await else {
        panic!("the resumed segment takes the next line");
    };
    let asked = chat.model.asked.lock().unwrap();
    let replayed: Vec<&str> = asked[1]
        .history
        .iter()
        .map(|turn| turn.user_message.text.as_str())
        .collect();
    let segments: Vec<String> = chat
        .world
        .data()
        .sessions()
        .unwrap()
        .sessions
        .iter()
        .map(|entry| entry.session_id().to_string())
        .collect();

    assert_eq!(closed, None);
    assert_eq!(replayed, ["Tea?"]);
    assert_eq!(turn.messages[0].id.to_string(), format!("{id}.1:message-3"));
    assert_eq!(segments, [format!("{id}.1")]);
}

fn assert_duplicate(delivery: &Delivery, client_message_id: &str, message_id: &MessageId) {
    assert!(
        matches!(
            delivery,
            Delivery::Duplicate { client_message_id: found, message_id: taken }
                if found == &stamp(client_message_id) && taken == message_id
        ),
        "{delivery:?}"
    );
}

/// A line submitted again under the id a run before this one took it under
/// is answered with the message it was committed as, and nothing is
/// written: in the current segment, in a closed one through the thread's
/// record of its lines, and in a closed one once that record is gone,
/// rebuilt from the segments.
#[tokio::test]
async fn a_line_taken_before_is_a_duplicate_wherever_it_was_taken() {
    let mut chat = Chat::new(&[]);
    let id = chat.id();
    let tea = MessageId::parse(&format!("{id}.1:message-1")).unwrap();
    let coffee = MessageId::parse(&format!("{id}.1:message-3")).unwrap();

    chat.model.script([
        Round::says(reply(&["Tea, always."])),
        Round::says(reply(&["Never."])),
    ]);
    chat.say("Tea?", "tea").await;
    assert_duplicate(&chat.say("Tea?", "tea").await, "tea", &tea);
    assert_eq!(chat.kinds(1).len(), 5);

    chat.window = NonZeroU64::MIN;
    assert!(matches!(
        chat.say("Coffee?", "coffee").await,
        Delivery::Completed {
            rotation: Some(_),
            ..
        }
    ));

    let closed_log = chat.log(1);
    let whole = std::fs::read_to_string(&closed_log).unwrap();

    chat.conversation.take().unwrap().close().await;
    std::fs::write(
        &closed_log,
        format!("{whole}{{\"eventId\": \"evt_torn\"}}\n"),
    )
    .unwrap();
    chat.conversation = Some(chat.world.open());
    assert_duplicate(&chat.say("Coffee?", "coffee").await, "coffee", &coffee);

    chat.conversation.take().unwrap().close().await;
    std::fs::write(&closed_log, &whole).unwrap();
    std::fs::remove_file(
        chat.world
            .data()
            .root()
            .join("taken-lines")
            .join(format!("{id}.json")),
    )
    .unwrap();
    chat.conversation = Some(chat.world.open());
    assert_duplicate(&chat.say("Tea?", "tea").await, "tea", &tea);

    assert_eq!(chat.kinds(2).len(), 1);
    assert_eq!(chat.model.asked.lock().unwrap().len(), 2);
    assert_eq!(
        chat.heard.take(),
        [
            "user_message Tea?",
            "visible_reply 1.0 Tea, always.",
            "user_message Coffee?",
            "visible_reply 1.0 Never.",
        ]
    );
}

/// Closing a thread lets both its leases go, so the thread opens again.
#[tokio::test]
async fn closing_a_thread_lets_it_open_again() {
    let mut chat = Chat::new(&[]);
    let refused = Conversation::open(&chat.world.home, mira()).unwrap_err();

    assert_eq!(refused.code(), "storage_busy");
    assert_eq!(chat.reopen().await, None);
}
