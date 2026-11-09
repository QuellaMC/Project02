//! A line through the turn: what it records, in the order the gate admits
//! it, what it announces, and how a turn its model does not finish ends.

use std::sync::{Arc, Mutex};

use p02_contracts::{ChatMessage, DecisionResult, ModelOutput, ToolCallOutcome};
use p02_runtime::{CompletedTurn, Delivery, Progress, RejectedTurn, Submission};
use p02_store::{LogRecord, RecordBody, RecordKind, ToolDispatch, TurnRejected};
use serde_json::{Value, json};

use crate::support::{Chat, Fixed, Round, Toy, calling, reply, stamp, told, written};

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
        window,
        ..
    } = &mut chat;
    let heard = Mutex::new(Vec::new());
    let delivery = conversation
        .as_mut()
        .unwrap()
        .deliver(
            Submission {
                line: " Hello? ",
                source: Some(stamp("web")),
                client_message_id: Some(stamp("hello")),
            },
            &mut Fixed {
                model,
                host,
                window: *window,
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
            "reply_delta 1.0 Hel",
            "reply_delta 1.0 lo.",
            "visible_reply 1.0 Hello."
        ]
    );
    assert_eq!(moments, [(0, 1), (1, 1), (1, 1), (1, 2)]);
    assert!(matches!(
        &progress[0],
        Progress::UserMessage { source, client_message_id, .. }
            if source == &Some(stamp("web")) && client_message_id == &Some(stamp("hello"))
    ));

    let Delivery::Completed {
        turn,
        rotation: None,
    } = delivery
    else {
        panic!("{delivery:?}");
    };

    assert_eq!(texts(&turn), ["Hello?", "Hello."]);
    assert_eq!(turn.post_commit_failures, Vec::<String>::new());
    assert_eq!(
        chat.kinds(1),
        [RECEIVED, COMMITTED, ROUND, COMMITTED, COMPLETED]
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
        Delivery::InputRejected { message, .. } => {
            assert_eq!(message, "Provide a non-empty message.");
        }
        other => panic!("{other:?}"),
    }

    assert_eq!(chat.heard.take(), Vec::<String>::new());
    assert!(matches!(
        chat.say("Hi?", "hi").await,
        Delivery::Completed { .. }
    ));
    assert_eq!(
        chat.kinds(1),
        [
            RECEIVED, REJECTED, RECEIVED, COMMITTED, ROUND, COMMITTED, COMPLETED
        ]
    );
    assert!(matches!(
        chat.records(1)[0].body(),
        RecordBody::EventReceived(received)
            if received.payload_summary.raw_input == " \t "
                && received.payload_summary.normalized_current_user_message.is_none()
    ));
    assert_eq!(chat.model.asked.lock().unwrap().len(), 1);
}

/// A turn whose provider gives nothing usable, or whose model's last
/// allowed answer is still malformed, ends rejected for its round's own
/// reason, the round recorded and the person's line kept.
#[tokio::test]
async fn a_provider_failure_or_a_malformed_last_answer_rejects_the_turn_and_keeps_the_line() {
    let mut chat = Chat::new(&[]);

    chat.model
        .script([Round::fails("The provider answered 503.")]);

    assert!(matches!(
        chat.say("Hello?", "first").await,
        Delivery::Rejected {
            turn: RejectedTurn { reason: "provider_error", ref message }
        } if message == "The provider answered 503."
    ));

    chat.model
        .script((0..100).map(|_| Round::says(ModelOutput::default())));

    let Delivery::Rejected { turn } = chat.say("Hello again?", "second").await else {
        panic!("a malformed last answer rejects its turn");
    };
    let records = chat.records(1);
    let rounds: Vec<&LogRecord> = records
        .iter()
        .filter(|record| record.kind() == ROUND)
        .collect();
    let Some(RecordBody::ModelRound(last)) = rounds.last().map(|record| record.body()) else {
        panic!("the turn recorded its rounds");
    };
    let DecisionResult::Rejected { rejection } = last.result() else {
        panic!("the last round was refused");
    };

    let rejections: Vec<&TurnRejected> = records
        .iter()
        .filter_map(|record| match record.body() {
            RecordBody::TurnRejected(rejected) => Some(rejected),
            _ => None,
        })
        .collect();

    assert_eq!(turn.reason, "malformed_output");
    assert_eq!(Some(&turn.message), rejection.details.as_ref());
    assert_eq!(rounds.len(), 1 + 100);
    assert_eq!(
        records
            .iter()
            .filter(|record| record.kind() == COMMITTED)
            .count(),
        2
    );
    assert_eq!(records.last().unwrap().kind(), REJECTED);
    assert_eq!(rejections.len(), 2);
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

    let Delivery::Completed { turn, .. } = chat.say("Remember tea and cake.", "notes").await else {
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
    let finished: Vec<(String, ToolDispatch)> = records
        .iter()
        .filter_map(|record| match record.body() {
            RecordBody::ToolCallFinished(call) => {
                Some((call.tool_plugin_id().to_string(), call.dispatch()))
            }
            _ => None,
        })
        .collect();
    let asked = chat.model.asked.lock().unwrap();
    let shown: Vec<Value> = asked[1]
        .messages
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
    assert_eq!(
        finished,
        [
            ("notes".to_owned(), ToolDispatch::Host),
            ("undeclared.notes.burn".to_owned(), ToolDispatch::Undeclared),
            ("notes".to_owned(), ToolDispatch::Host),
        ]
    );
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

/// The round budget spent on a round still asking for a tool ends the turn
/// rejected as `tool_rounds_exhausted`, the last round's call never made.
#[tokio::test]
async fn a_round_budget_spent_still_asking_for_a_tool_rejects_the_turn() {
    let notes = Toy::new("notes")
        .access(json!({"model_input": "write"}))
        .tool("notes.add", |_| ToolCallOutcome::Accepted {
            output: json!({"added": true}),
            evidence: Vec::new(),
        });
    let mut chat = Chat::new(&[Arc::new(notes)]);

    chat.model
        .script((0..100).map(|_| Round::says(calling("notes.add", &json!({"note": "more"})))));

    let delivery = chat.say("Keep noting.", "notes").await;
    let kinds = chat.kinds(1);
    let count = |kind| kinds.iter().filter(|&&found| found == kind).count();

    assert!(
        matches!(
            &delivery,
            Delivery::Rejected {
                turn: RejectedTurn { reason: "tool_rounds_exhausted", message }
            } if message == "Role model exceeded maximum executable tool rounds (99)."
        ),
        "{delivery:?}"
    );
    assert_eq!(
        (count(ROUND), count(STARTED), count(FINISHED)),
        (100, 99, 99)
    );
    assert_eq!(kinds.last(), Some(&REJECTED));
}
