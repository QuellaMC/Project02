//! A line through the turn: what it records, in the order the gate admits
//! it, and what it announces.

use std::sync::{Arc, Mutex};

use p02_contracts::{ChatMessage, ModelOutput, ToolCallOutcome};
use p02_core::{Timestamp, VisibleText};
use p02_runtime::{CompletedTurn, Delivery, Progress, Submission, Translation};
use p02_store::{EventReceived, RecordBody, RecordKind};
use serde_json::{Value, json};

use crate::support::{Asked, Chat, Fixed, Round, Toy, reply, stamp, told, written};

const RECEIVED: RecordKind = RecordKind::RuntimeEventReceived;
const COMMITTED: RecordKind = RecordKind::VisibleMessageCommitted;
const ROUND: RecordKind = RecordKind::RoleModelRound;
const STARTED: RecordKind = RecordKind::ToolCallStarted;
const FINISHED: RecordKind = RecordKind::ToolCallFinished;
const COMPLETED: RecordKind = RecordKind::RuntimeTurnCompleted;
const REJECTED: RecordKind = RecordKind::RuntimeTurnRejected;

fn texts(turn: &CompletedTurn) -> Vec<&str> {
    turn.messages
        .iter()
        .map(|message| message.text.as_str())
        .collect()
}

/// A first line through a fresh thread lands its records in the gate's
/// order, sent when its client sent it, and is announced before the model
/// is asked, each message only once its record is on disk; the round is
/// announced as its request goes out, and as it ends, after the message it
/// said.
#[tokio::test]
async fn a_first_line_lands_in_order_and_is_announced_as_it_lands() {
    let mut chat = Chat::new(&[]);
    let id = chat.id();
    let sent_at = Timestamp::new("2026-11-24T14:10:00.000Z").unwrap();

    chat.model.script([Round::says(reply(&["Hello."]))]);

    let Chat {
        world,
        conversation,
        model,
        host,
        ..
    } = &mut chat;
    let heard = Mutex::new(Vec::new());
    let delivery = conversation
        .as_mut()
        .unwrap()
        .deliver(
            Submission {
                line: " Hello? ",
                source: stamp("web"),
                client_message_id: stamp("hello"),
                sent_at: sent_at.clone(),
            },
            &mut Fixed {
                model,
                host,
                translator: None,
            },
            &|progress: Progress| {
                let on_disk = world
                    .records(&id, 1)
                    .iter()
                    .filter(|record| record.kind() == COMMITTED)
                    .count();
                let asked = model.asked.lock().unwrap().len();

                heard.lock().unwrap().push((progress, asked, on_disk));
            },
        )
        .await;
    let heard = heard.into_inner().unwrap();
    let (progress, moments): (Vec<Progress>, Vec<(usize, usize)>) = heard
        .into_iter()
        .map(|(progress, asked, on_disk)| (progress, (asked, on_disk)))
        .unzip();

    assert_eq!(
        told(&progress),
        [
            "user_message Hello?",
            "round_began",
            "visible_reply Hello.",
            "round_ended"
        ]
    );
    assert_eq!(moments, [(0, 1), (0, 1), (1, 2), (1, 2)]);
    assert!(matches!(
        &progress[0],
        Progress::UserMessage { message, source, client_message_id, .. }
            if source == &stamp("web")
                && client_message_id == &stamp("hello")
                && message.sent_at == sent_at
    ));

    let Delivery::Completed(turn) = delivery else {
        panic!("{delivery:?}");
    };

    assert_eq!(texts(&turn), ["Hello?", "Hello."]);
    assert_eq!(turn.post_commit_failures, Vec::<String>::new());
    assert_eq!(
        chat.kinds(1),
        [RECEIVED, COMMITTED, ROUND, COMMITTED, COMPLETED]
    );
}

/// A line refused before its commit, a blank text or one her translator
/// could not put into her language, leaves its event, which keeps what
/// came in as written, and the refusal alone in the log, announces
/// nothing and asks her model nothing; the next line completes.
#[tokio::test]
async fn a_line_refused_before_its_commit_leaves_its_event_and_the_refusal_alone() {
    let unread = Translation::Failed("this AI model cannot translate.".to_owned());
    let mut chat = Chat::translated([unread, Translation::Already, Translation::Already]);
    let refused = |delivery: Delivery| match delivery {
        Delivery::LineRefused(turn) => (turn.reason, turn.message),
        other => panic!("{other:?}"),
    };

    chat.model.script([Round::says(reply(&["Hi."]))]);

    assert_eq!(
        refused(chat.say(" \t ", "blank").await),
        (
            "input_validation_rejected",
            "Provide a non-empty message.".to_owned()
        )
    );
    assert_eq!(
        refused(chat.say(" Hi? ", "unread").await),
        (
            "line_not_translated",
            "Your message did not reach Mira, because it could not be put into her language: \
             this AI model cannot translate."
                .to_owned()
        )
    );
    assert_eq!(chat.heard.take(), Vec::<String>::new());
    assert!(matches!(
        chat.say("Hi?", "hi").await,
        Delivery::Completed(_)
    ));
    assert_eq!(
        chat.kinds(1),
        [
            RECEIVED, REJECTED, RECEIVED, REJECTED, RECEIVED, COMMITTED, ROUND, COMMITTED,
            COMPLETED
        ]
    );

    let received: Vec<(String, Option<String>)> = chat
        .records(1)
        .iter()
        .filter_map(|record| match record.body() {
            RecordBody::EventReceived(EventReceived::Text(summary)) => Some((
                summary.raw_input.clone(),
                summary
                    .normalized_current_user_message
                    .as_ref()
                    .map(ToString::to_string),
            )),
            _ => None,
        })
        .collect();

    assert_eq!(
        received,
        [
            (" \t ".to_owned(), None),
            (" Hi? ".to_owned(), Some("Hi?".to_owned())),
            ("Hi?".to_owned(), Some("Hi?".to_owned())),
        ]
    );
    assert_eq!(chat.translator_asked().len(), 3);
    assert_eq!(chat.model.asked.lock().unwrap().len(), 1);
}

/// For a character a translator reads to the person, the line is committed
/// as she reads it with the person's words beside it, and each message of
/// hers with the person's words beside it, or alone when it needed none or
/// none came, each announced so; her model is given her language alone.
/// The translator is handed the conversation's newest six messages before
/// each, from the history and the turn so far, each as its author wrote
/// it, and for hers the person's newest message as they wrote it: the
/// turn's line, or, in a moment, the newest line before it.
#[tokio::test]
async fn a_translated_turn_commits_both_forms_and_hands_the_translator_what_was_written() {
    let translated = |text: &str| Translation::Translated(VisibleText::normalize(text).unwrap());
    let unread = Translation::Failed("the AI service answered with nothing.".to_owned());
    let mut chat = Chat::translated([
        translated("一？"),
        translated("One."),
        Translation::Already,
        unread,
        translated("二？"),
        translated("Four."),
        translated("Five."),
        translated("Six."),
    ]);
    // The conversation as its authors wrote it, oldest first.
    let said = [
        "Sam: One?",
        "Mira: 一。",
        "Mira: 二。",
        "Mira: 三。",
        "Sam: Two?",
        "Mira: 四。",
        "Mira: 五。",
    ]
    .map(str::to_owned);
    let for_her = |line: &str, before: &[String]| Asked::ForHer {
        line: line.to_owned(),
        before: before.to_vec(),
    };
    let for_person = |message: &str, before: &[String], newest: &str| Asked::ForPerson {
        message: message.to_owned(),
        before: before.to_vec(),
        newest: Some(newest.to_owned()),
    };

    chat.model.script([
        Round::says(reply(&["一。", "二。", "三。"])),
        Round::says(reply(&["四。", "五。"])),
        Round::says(reply(&["六。"])),
    ]);

    let Delivery::Completed(turn) = chat.say("One?", "one").await else {
        panic!("the first line completes");
    };

    assert_eq!(texts(&turn), ["一？", "一。", "二。", "三。"]);
    assert!(matches!(
        chat.say("Two?", "two").await,
        Delivery::Completed(_)
    ));
    assert!(matches!(chat.moment().await, Delivery::Completed(_)));
    assert_eq!(
        chat.translator_asked(),
        [
            for_her("One?", &[]),
            for_person("一。", &said[..1], "One?"),
            for_person("二。", &said[..2], "One?"),
            for_person("三。", &said[..3], "One?"),
            for_her("Two?", &said[..4]),
            for_person("四。", &said[..5], "Two?"),
            for_person("五。", &said[..6], "Two?"),
            for_person("六。", &said[1..], "Two?"),
        ]
    );
    assert_eq!(
        committed(&chat),
        [
            "一？ written One?",
            "一。 translated One.",
            "二。",
            "三。",
            "二？ written Two?",
            "四。 translated Four.",
            "五。 translated Five.",
            "六。 translated Six.",
        ]
    );
    assert_eq!(
        chat.heard
            .take()
            .into_iter()
            .filter(|said| !said.starts_with("round_"))
            .collect::<Vec<_>>(),
        [
            "user_message 一？ (One?)",
            "visible_reply 一。 (One.)",
            "visible_reply 二。",
            "visible_reply 三。",
            "user_message 二？ (Two?)",
            "visible_reply 四。 (Four.)",
            "visible_reply 五。 (Five.)",
            "visible_reply 六。 (Six.)",
        ]
    );

    let shown = serde_json::to_string(&*chat.model.asked.lock().unwrap()).unwrap();

    assert!(
        shown.contains("\\n一？\"") && shown.contains("\\n二？\""),
        "{shown}"
    );
    assert!(
        !shown.contains("One?") && !shown.contains("Two?"),
        "{shown}"
    );
}

/// Each message the log of `chat` committed, with the person's words or
/// hers in the person's language beside it when it has them.
fn committed(chat: &Chat) -> Vec<String> {
    chat.records(1)
        .iter()
        .filter_map(|record| match record.body() {
            RecordBody::MessageCommitted(commit) => {
                let text = &commit.message().text;

                Some(match (commit.written(), commit.translation()) {
                    (Some(written), _) => format!("{text} written {written}"),
                    (_, Some(translation)) => format!("{text} translated {translation}"),
                    (None, None) => text.to_string(),
                })
            }
            _ => None,
        })
        .collect()
}

/// A round of tool calls starts each in the model's order, finishes each as
/// its plugin answered or, for a tool the turn never offered, as the
/// refusal of it, shows the model the results in its next round, and
/// announces them, once the round that called them ended and before the
/// next begins.
#[tokio::test]
async fn a_tool_round_runs_its_calls_in_order_and_shows_the_model_their_results() {
    let notes = Toy::new("notes")
        .access(json!({"model_input": "write"}))
        .tool("notes.add", |call| ToolCallOutcome::Accepted {
            output: json!({"added": call.input()["note"]}),
            evidence: Vec::new(),
        });
    let mut chat = Chat::new(&[Arc::new(notes)]);

    chat.model.script([
        Round::says(ModelOutput {
            tool_calls: vec![
                written("notes.add", json!({"note": "tea"})),
                written("notes.burn", json!({"note": "all"})),
                written("notes.add", json!({"note": "cake"})),
            ],
            text: Some("Noting both.".to_owned()),
        }),
        Round::says(reply(&["Noted."])),
    ]);

    let Delivery::Completed(turn) = chat.say("Remember tea and cake.", "notes").await else {
        panic!("the turn completes");
    };
    let records = chat.records(1);
    let started: Vec<String> = records
        .iter()
        .filter_map(|record| match record.body() {
            RecordBody::ToolCallStarted(call) => Some(call.tool_input()["note"].to_string()),
            _ => None,
        })
        .collect();
    let finished: Vec<String> = records
        .iter()
        .filter_map(|record| match record.body() {
            RecordBody::ToolCallFinished(call) => Some(call.tool_plugin_id().to_string()),
            _ => None,
        })
        .collect();
    let asked = chat.model.asked.lock().unwrap();
    let shown: Vec<Value> = asked[1]
        .iter()
        .filter_map(|message| match message {
            ChatMessage::Tool { content, .. } => Some(serde_json::from_str(content).unwrap()),
            _ => None,
        })
        .collect();

    assert_eq!(texts(&turn), ["Remember tea and cake.", "Noted."]);
    assert_eq!(
        chat.kinds(1),
        [
            RECEIVED, COMMITTED, ROUND, STARTED, STARTED, STARTED, FINISHED, FINISHED, FINISHED,
            ROUND, COMMITTED, COMPLETED
        ]
    );
    assert_eq!(started, [r#""tea""#, r#""all""#, r#""cake""#]);
    assert_eq!(finished, ["notes", "undeclared.notes.burn", "notes"]);
    assert_eq!(
        shown,
        [
            json!({"status": "accepted", "pluginId": "notes", "toolName": "notes.add", "output": {"added": "tea"}}),
            json!({
                "status": "rejected",
                "pluginId": "undeclared.notes.burn",
                "toolName": "notes.burn",
                "reason": "tool_not_declared",
                "message": "Tool \"notes.burn\" is not declared for this turn.",
            }),
            json!({"status": "accepted", "pluginId": "notes", "toolName": "notes.add", "output": {"added": "cake"}}),
        ]
    );
    assert_eq!(
        chat.heard.take(),
        [
            "user_message Remember tea and cake.",
            "round_began",
            "round_ended",
            "tool_calls_requested 1 notes.add notes.burn notes.add",
            "tool_call_completed 1 notes.add accepted",
            "tool_call_completed 1 notes.burn rejected",
            "tool_call_completed 1 notes.add accepted",
            "round_began",
            "visible_reply Noted.",
            "round_ended",
        ]
    );
}
