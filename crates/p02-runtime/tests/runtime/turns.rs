//! A line through the turn: what it records, in the order the gate admits
//! it, and what it announces.

use std::sync::{Arc, Mutex};

use p02_contracts::{ChatMessage, ModelOutput, ToolCallOutcome};
use p02_runtime::{CompletedTurn, Delivery, Progress, Submission};
use p02_store::{EventReceived, RecordBody, RecordKind};
use serde_json::{Value, json};

use crate::support::{Chat, Fixed, Round, Toy, reply, stamp, told, written};

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
/// order, and is announced before the model is asked, each message only
/// once its record is on disk.
#[tokio::test]
async fn a_first_line_lands_in_order_and_is_announced_as_it_lands() {
    let mut chat = Chat::new(&[]);
    let id = chat.id();

    chat.model
        .script([Round::says(reply(&["Hello."])).drafting(0, &["Hel", "lo."])]);

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
            },
            &mut Fixed { model, host },
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
            "reply_delta 1.0 Hel",
            "reply_delta 1.0 lo.",
            "visible_reply 1.0 Hello."
        ]
    );
    assert_eq!(moments, [(0, 1), (1, 1), (1, 1), (1, 2)]);
    assert!(matches!(
        &progress[0],
        Progress::UserMessage { source, client_message_id, .. }
            if source == &stamp("web") && client_message_id == &stamp("hello")
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

/// A reply its model drafts and lets go, as when another model takes its
/// answer over, is withdrawn there and then, and the reply drafted after it
/// is the one its commit replaces.
#[tokio::test]
async fn a_draft_its_model_lets_go_is_withdrawn_and_the_next_takes_its_place() {
    let mut chat = Chat::new(&[]);

    chat.model.script([Round::says(reply(&["Whole."]))
        .drafting(0, &["Half a"])
        .letting_go()
        .drafting(0, &["Who", "le."])]);

    let delivery = chat.say("Hello?", "hello").await;

    assert!(matches!(delivery, Delivery::Completed(_)), "{delivery:?}");
    assert_eq!(
        chat.heard.take(),
        [
            "user_message Hello?",
            "reply_delta 1.0 Half a",
            "reply_withdrawn 1.0",
            "reply_delta 1.0 Who",
            "reply_delta 1.0 le.",
            "visible_reply 1.0 Whole."
        ]
    );
}

/// A blank text is refused with its event and the refusal recorded,
/// nothing committed and the model never asked, and the next line
/// completes.
#[tokio::test]
async fn a_blank_text_is_refused_and_the_next_line_completes() {
    let mut chat = Chat::new(&[]);

    chat.model.script([Round::says(reply(&["Hi."]))]);

    match chat.say(" \t ", "refused").await {
        Delivery::InputRejected { message } => {
            assert_eq!(message, "Provide a non-empty message.");
        }
        other => panic!("{other:?}"),
    }

    assert_eq!(chat.heard.take(), Vec::<String>::new());
    assert!(matches!(
        chat.say("Hi?", "hi").await,
        Delivery::Completed(_)
    ));
    assert_eq!(
        chat.kinds(1),
        [
            RECEIVED, REJECTED, RECEIVED, COMMITTED, ROUND, COMMITTED, COMPLETED
        ]
    );
    assert!(matches!(
        chat.records(1)[0].body(),
        RecordBody::EventReceived(EventReceived::Text(summary))
            if summary.raw_input == " \t " && summary.normalized_current_user_message.is_none()
    ));
    assert_eq!(chat.model.asked.lock().unwrap().len(), 1);
}

/// A round of tool calls starts each in the model's order, finishes each as
/// its plugin answered or, for a tool the turn never offered, as the
/// refusal of it, shows the model the results in its next round, and
/// announces them.
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
            "tool_calls_requested 1 notes.add notes.burn notes.add",
            "tool_call_completed 1 notes.add accepted",
            "tool_call_completed 1 notes.burn rejected",
            "tool_call_completed 1 notes.add accepted",
            "visible_reply 2.0 Noted.",
        ]
    );
}
