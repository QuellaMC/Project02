//! A session that outgrows the model's window, continued in a new segment,
//! and the thread when the rotation fails.

use std::num::{NonZeroU32, NonZeroU64};

use p02_contracts::{ConversationTurn, ProviderName, TextCompletion};
use p02_core::{MessageId, SessionId};
use p02_runtime::{CompletedTurn, Delivery};
use p02_store::{RecordBody, SessionContinuation, Summarizer, SummaryProvider, TakenLines};

use crate::support::{Chat, Round, make_read_only, reply, restore, stamp};

/// A window that holds two of the turns these tests say, never three, and
/// whose quarter holds one.
const SMALL: NonZeroU64 = NonZeroU64::new(80).unwrap();

fn session(text: &str) -> SessionId {
    SessionId::parse(text).unwrap()
}

/// Sam says line `n`, which Mira answers with reply `n`.
async fn line(chat: &mut Chat, n: u32) -> CompletedTurn {
    chat.model
        .script([Round::says(reply(&[&format!("Reply {n}.")]))]);

    match chat.say(&format!("Line {n}."), &format!("line-{n}")).await {
        Delivery::Completed(turn) => turn,
        other => panic!("{other:?}"),
    }
}

/// The segments of the thread her sessions catalog names.
fn segments(chat: &Chat) -> Vec<String> {
    chat.world
        .data()
        .sessions()
        .unwrap()
        .sessions
        .iter()
        .map(|entry| entry.session_id().to_string())
        .collect()
}

fn continuation(chat: &Chat, segment: u64) -> SessionContinuation {
    match chat.records(segment)[0].body() {
        RecordBody::SessionContinued(continued) => continued.session_continuation.clone(),
        other => panic!("{other:?}"),
    }
}

/// A thread whose history outgrows the model's window continues in a new
/// segment after the turn that outgrew it: the newest turn that fits a
/// quarter of the window carried whole and the rest condensed, by the
/// model when it can and mechanically when it cannot; the next turn is
/// shown the carried turn and the summary, and the old segment's lines are
/// recorded.
#[tokio::test]
async fn a_history_that_outgrows_the_window_continues_in_a_new_segment() {
    continues(Some("We spoke of two lines.")).await;
    continues(None).await;
}

/// Three turns in a small window, `summary` what the model condenses the
/// first two into, if it does, then the turn after them.
async fn continues(summary: Option<&str>) {
    let mut chat = Chat::new(&[]);
    let id = chat.id();

    chat.window = SMALL;

    if let Some(summary) = summary {
        chat.model.complete(TextCompletion::Completed {
            text: format!("  {summary}\n"),
            provider: ProviderName::Nvidia,
            model: Some("summary-model".to_owned()),
        });
    }

    line(&mut chat, 1).await;
    line(&mut chat, 2).await;
    assert_eq!(segments(&chat), [format!("{id}.1")]);

    let turn = line(&mut chat, 3).await;
    let day = day_of(&chat);
    let (written, summarizer) = expected(summary, &day);
    let continued = continuation(&chat, 2);
    let requests = chat.model.summarized.lock().unwrap().clone();

    assert_eq!(turn.post_commit_failures, Vec::<String>::new());
    assert_eq!(segments(&chat), [format!("{id}.1"), format!("{id}.2")]);
    assert_eq!(
        continued.continued_from().session_id,
        session(&format!("{id}.1"))
    );
    assert_eq!(
        continued.summarized_turn_count(),
        NonZeroU32::new(2).unwrap()
    );
    assert_eq!(continued.summary(), written);
    assert_eq!(continued.summarizer(), &summarizer);
    assert_eq!(said(continued.carried_turns()), ["Line 3."]);
    assert_eq!(
        requests[0].input,
        format!(
            "<conversation>\n[{day}]\nSam: Line 1.\nMira: Reply 1.\nSam: Line 2.\nMira: Reply \
             2.\n</conversation>"
        )
    );
    assert!(requests[0].instructions.contains("Sam"));

    let turn = line(&mut chat, 4).await;
    let asked = chat.model.asked.lock().unwrap();

    assert_eq!(segments(&chat), [format!("{id}.1"), format!("{id}.2")]);
    assert_eq!(turn.messages[0].id.to_string(), format!("{id}.2:message-1"));
    assert_eq!(said(&asked[3].history), ["Line 3."]);
    assert_eq!(
        TakenLines::read(&chat.world.data(), &id).taken(&stamp("line-1")),
        Some(&MessageId::parse(&format!("{id}.1:message-1")).unwrap())
    );
}

/// The summary a continuation of the first two lines holds, and who wrote
/// it: the model's `summary`, or without one, the mechanical summary of
/// those lines, said on `day`.
fn expected(summary: Option<&str>, day: &str) -> (String, Summarizer) {
    match summary {
        Some(summary) => (
            summary.to_owned(),
            Summarizer::Model {
                provider: SummaryProvider {
                    name: ProviderName::Nvidia,
                    model: Some("summary-model".to_owned()),
                },
            },
        ),
        None => (
            format!(
                "Earlier conversation (2 turns, {day} to {day}) is not in context verbatim. Most \
                 recent things Sam said there: “Line 1.” · “Line 2.”. Details from that part are \
                 not available in context."
            ),
            Summarizer::Fallback {
                reason: "The selected provider has no summarizer model.".to_owned(),
            },
        ),
    }
}

/// The day the thread's first segment began, as its records spell it.
fn day_of(chat: &Chat) -> String {
    let records = chat.records(1);
    let (day, _) = records[0]
        .identity()
        .created_at()
        .as_str()
        .split_once('T')
        .unwrap();

    day.to_owned()
}

/// What the person said in each of `turns`.
fn said(turns: &[ConversationTurn]) -> Vec<&str> {
    turns
        .iter()
        .map(|turn| turn.user_message.text.as_str())
        .collect()
}

/// A rotation that fails before its continuation is committed leaves the
/// turn completed, the thread in its segment, and the next line completing
/// there, its rotation planned again.
#[tokio::test]
async fn a_rotation_that_fails_leaves_the_turn_completed_and_the_thread_in_its_segment() {
    let mut chat = Chat::new(&[]);
    let id = chat.id();
    let data = chat.world.data().root().to_path_buf();
    let catalog = data.join("sessions.jsonl");

    chat.window = SMALL;
    line(&mut chat, 1).await;
    line(&mut chat, 2).await;

    // A rename replaces a read-only file on Unix, where the folder that
    // holds the catalog decides; Windows refuses to replace one.
    let catalog_writable = make_read_only(&catalog);
    let data_writable = make_read_only(&data);
    let turn = line(&mut chat, 3).await;

    restore(&data, data_writable);
    restore(&catalog, catalog_writable);

    let [failure] = turn.post_commit_failures.as_slice() else {
        panic!("{:?}", turn.post_commit_failures);
    };

    assert_eq!(turn.messages[1].text.as_str(), "Reply 3.");
    assert!(failure.contains("could not write"), "{failure}");
    assert_eq!(segments(&chat), [format!("{id}.1")]);

    let turn = line(&mut chat, 4).await;

    assert_eq!(turn.messages[0].id.to_string(), format!("{id}.1:message-7"));
    assert_eq!(turn.post_commit_failures, Vec::<String>::new());
    assert_eq!(segments(&chat), [format!("{id}.1"), format!("{id}.2")]);
}
