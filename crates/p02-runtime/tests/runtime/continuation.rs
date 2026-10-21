//! A session that outgrows the model's window, continued in a new segment,
//! and the thread when the rotation, or the old segment's end, fails.

use std::num::{NonZeroU32, NonZeroU64};
use std::sync::Arc;

use p02_contracts::{
    ConversationTurn, HookReport, HookStatus, PluginError, ProviderName, TextCompletion,
};
use p02_core::{MessageId, SessionId};
use p02_runtime::{CompletedTurn, Delivery, Rotation};
use p02_store::{RecordBody, SessionContinuation, Summarizer, SummaryProvider, TakenLines};

use crate::support::{Chat, Round, Toy, make_read_only, reply, restore, stamp};

/// A window that holds two of the turns these tests say, never three, and
/// whose quarter holds one.
const SMALL: NonZeroU64 = NonZeroU64::new(80).unwrap();

fn session(text: &str) -> SessionId {
    SessionId::parse(text).unwrap()
}

/// Sam says line `n`, which Mira answers with reply `n`.
async fn line(chat: &mut Chat, n: u32) -> (CompletedTurn, Option<Rotation>) {
    chat.model
        .script([Round::says(reply(&[&format!("Reply {n}.")]))]);

    match chat.say(&format!("Line {n}."), &format!("line-{n}")).await {
        Delivery::Completed { turn, rotation } => (turn, rotation),
        other => panic!("{other:?}"),
    }
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
/// shown the carried turn and the summary, the old segment's lines are
/// recorded, and its end hooks run.
#[tokio::test]
async fn a_history_that_outgrows_the_window_continues_in_a_new_segment() {
    continues(Some("We spoke of two lines.")).await;
    continues(None).await;
}

/// Three turns in a small window, `summary` what the model condenses the
/// first two into, if it does, then the turn after them.
async fn continues(summary: Option<&str>) {
    let ender = Arc::new(Toy::new("ender").end(|_| {
        Ok(HookReport {
            status: HookStatus::Completed,
            evidence: Vec::new(),
        })
    }));
    let mut chat = Chat::new(&[Arc::clone(&ender)]);
    let id = chat.id();

    chat.window = SMALL;

    if let Some(summary) = summary {
        chat.model.complete(TextCompletion::Completed {
            text: format!("  {summary}\n"),
            provider: ProviderName::Nvidia,
            model: Some("summary-model".to_owned()),
        });
    }

    assert_eq!(line(&mut chat, 1).await.1, None);
    assert_eq!(line(&mut chat, 2).await.1, None);

    let rotation = line(&mut chat, 3).await.1;
    let day = day_of(&chat);
    let (written, summarizer) = expected(summary, &day);
    let continued = continuation(&chat, 2);
    let requests = chat.model.summarized.lock().unwrap().clone();

    assert_eq!(
        rotation,
        Some(Rotation::Rotated {
            from: session(&format!("{id}.1")),
            to: session(&format!("{id}.2")),
            summarized_turn_count: NonZeroU32::new(2).unwrap(),
            summarizer: summarizer.clone(),
            end_failure: None,
        })
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

    let (turn, rotation) = line(&mut chat, 4).await;
    let asked = chat.model.asked.lock().unwrap();

    assert_eq!(rotation, None);
    assert_eq!(turn.messages[0].id.to_string(), format!("{id}.2:message-1"));
    assert_eq!(
        asked[3].envelope.decision_context.context_summary(),
        Some(written.as_str())
    );
    assert_eq!(said(&asked[3].history), ["Line 3."]);
    assert_eq!(*ender.ended.lock().unwrap(), [session(&format!("{id}.1"))]);
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
    let (turn, rotation) = line(&mut chat, 3).await;

    restore(&data, data_writable);
    restore(&catalog, catalog_writable);

    let Some(Rotation::Failed { from, message }) = rotation else {
        panic!("{rotation:?}");
    };
    let segments: Vec<String> = chat
        .world
        .data()
        .sessions()
        .unwrap()
        .iter()
        .map(|entry| entry.session_id().to_string())
        .collect();

    assert_eq!(turn.messages[1].text.as_str(), "Reply 3.");
    assert_eq!(from, session(&format!("{id}.1")));
    assert!(message.contains("could not write"), "{message}");
    assert_eq!(segments, [format!("{id}.1")]);

    let (turn, rotation) = line(&mut chat, 4).await;

    assert_eq!(turn.messages[0].id.to_string(), format!("{id}.1:message-7"));
    assert!(
        matches!(rotation, Some(Rotation::Rotated { .. })),
        "{rotation:?}"
    );
}

/// storage.continuation-end-hook-failure: a rotation whose old segment's session-end hook fails still adopts the continuation, reports the failure, and chatting goes on in the new segment
#[tokio::test]
async fn a_failed_end_hook_reports_the_failure_and_the_continuation_stands() {
    let archive = Toy::new("archive").end(|_| Err(PluginError::new("The archive is unreachable.")));
    let mut chat = Chat::new(&[Arc::new(archive)]);
    let id = chat.id();

    chat.window = SMALL;
    line(&mut chat, 1).await;
    line(&mut chat, 2).await;

    let Some(Rotation::Rotated {
        to, end_failure, ..
    }) = line(&mut chat, 3).await.1
    else {
        panic!("the rotation is committed");
    };
    let (turn, _) = line(&mut chat, 4).await;

    assert_eq!(to, session(&format!("{id}.2")));
    assert_eq!(
        end_failure.as_deref(),
        Some("onSessionEnd plugin hook failed: The archive is unreachable.")
    );
    assert_eq!(turn.messages[0].id.to_string(), format!("{id}.2:message-1"));
}
