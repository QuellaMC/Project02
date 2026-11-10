//! A moment of her own through the one turn path: a turn nobody began,
//! which commits no line and may end without a word, and what she replays
//! of it later.

use std::sync::{Arc, Mutex};

use p02_contracts::{ChatMessage, DecisionResult, ModelOutput, ToolCallOutcome};
use p02_runtime::{CompletedTurn, Delivery, RejectedTurn};
use p02_store::{EventReceived, RecordBody, RecordKind};
use serde_json::json;

use crate::support::{Chat, Fixed, Round, Toy, reply, written};

const RECEIVED: RecordKind = RecordKind::RuntimeEventReceived;
const COMMITTED: RecordKind = RecordKind::VisibleMessageCommitted;
const ROUND: RecordKind = RecordKind::RoleModelRound;
const STARTED: RecordKind = RecordKind::ToolCallStarted;
const FINISHED: RecordKind = RecordKind::ToolCallFinished;
const COMPLETED: RecordKind = RecordKind::RuntimeTurnCompleted;
const REJECTED: RecordKind = RecordKind::RuntimeTurnRejected;

impl Chat {
    /// A moment of Mira's own, which nobody began.
    pub(crate) async fn moment(&mut self) -> Delivery {
        let heard = &self.heard;

        self.conversation
            .as_mut()
            .unwrap()
            .moment(
                &mut Fixed {
                    model: &self.model,
                    host: &self.host,
                },
                &|progress| heard.push(progress),
            )
            .await
    }

    /// What the model was shown in its request `request`, counted from
    /// zero, past its system messages: each message as its role and its
    /// text, an assistant's calls by their tools' names.
    pub(crate) fn shown(&self, request: usize) -> Vec<String> {
        self.model.asked.lock().unwrap()[request]
            .iter()
            .filter_map(|message| match message {
                ChatMessage::System { .. } | ChatMessage::Developer { .. } => None,
                ChatMessage::User { content } => Some(format!("user {content}")),
                ChatMessage::Assistant {
                    content,
                    tool_calls,
                } => Some(
                    std::iter::once("assistant")
                        .chain(content.as_deref())
                        .chain(tool_calls.iter().map(|call| call.function().name.as_str()))
                        .collect::<Vec<_>>()
                        .join(" "),
                ),
                ChatMessage::Tool { content, .. } => Some(format!("tool {content}")),
            })
            .collect()
    }
}

fn completed(delivery: Delivery) -> CompletedTurn {
    match delivery {
        Delivery::Completed(turn) => turn,
        other => panic!("{other:?}"),
    }
}

fn texts(turn: &CompletedTurn) -> Vec<&str> {
    turn.messages
        .iter()
        .map(|message| message.text.as_str())
        .collect()
}

fn thought(text: &str) -> ModelOutput {
    ModelOutput {
        tool_calls: Vec::new(),
        text: Some(text.to_owned()),
    }
}

/// A moment's note, as the model reads it where a line would be, up to the
/// time it tells.
const NOTE: &str = "user <moment_of_your_own>\nA moment of your own — nobody has written to you, \
                    and nothing here is something Sam said.\nIt is ";

/// An earlier moment's note, as a later prompt replays it, up to when it
/// was.
const PAST: &str = "user <moment_of_your_own>\nA moment of your own, on ";

/// Plain text alone is her thought: the log keeps it in its round, the turn
/// completes with no message and no reply, nothing is announced, and the
/// next turn's prompt never shows the moment.
#[tokio::test]
async fn a_moment_answered_with_plain_text_ends_with_no_message_and_is_never_replayed() {
    let mut chat = Chat::new(&[]);

    chat.model.script([
        Round::says(thought("I wonder if Sam found the keys.")),
        Round::says(reply(&["Hello."])),
    ]);

    let turn = completed(chat.moment().await);
    let records = chat.records(1);

    assert_eq!(texts(&turn), Vec::<&str>::new());
    assert_eq!(chat.heard.take(), Vec::<String>::new());
    assert_eq!(chat.kinds(1), [RECEIVED, ROUND, COMPLETED]);
    assert!(matches!(
        records[0].body(),
        RecordBody::EventReceived(EventReceived::Moment)
    ));
    assert!(matches!(
        records[1].body(),
        RecordBody::ModelRound(round) if matches!(
            round.result(),
            DecisionResult::Accepted { decision }
                if decision.tool_calls().is_empty()
                    && decision.text() == Some("I wonder if Sam found the keys.")
        )
    ));
    assert!(matches!(
        records[2].body(),
        RecordBody::TurnCompleted(ended)
            if ended.visible_message_ids.is_empty() && ended.judgement.accepted_reply.is_none()
    ));

    completed(chat.say("Hi?", "hi").await);
    assert_eq!(chat.shown(1), ["user Hi?"]);
}

/// Her `visible_reply` in a moment is committed with no line before it and
/// announced as a reply alone; the moment's note tells how long since the
/// person last wrote, and the next turn replays the moment's note, without
/// that, then her message.
#[tokio::test]
async fn a_moment_s_reply_is_committed_with_no_line_before_it_and_replayed_after_its_note() {
    let mut chat = Chat::new(&[]);

    chat.model.script([
        Round::says(reply(&["Not yet."])),
        Round::says(reply(&["Found your keys yet?"])),
        Round::says(reply(&["Good."])),
    ]);
    completed(chat.say("Have you seen my keys?", "keys").await);
    chat.heard.take();

    let turn = completed(chat.moment().await);

    assert_eq!(texts(&turn), ["Found your keys yet?"]);
    assert_eq!(
        chat.heard.take(),
        ["visible_reply 1.0 Found your keys yet?"]
    );
    assert_eq!(chat.kinds(1)[5..], [RECEIVED, ROUND, COMMITTED, COMPLETED]);

    let moment = chat.shown(1).pop().unwrap();

    assert!(moment.starts_with(NOTE), "{moment}");
    assert!(
        moment.contains("; Sam last wrote to you just now.\nNobody is waiting for a reply."),
        "{moment}"
    );

    completed(chat.say("Yes!", "yes").await);

    let shown = chat.shown(2);

    assert_eq!(
        shown[..2],
        ["user Have you seen my keys?", "assistant Not yet."]
    );
    assert!(shown[2].starts_with(PAST), "{}", shown[2]);
    assert!(
        shown[2].ends_with(" — nobody had written to you.\n</moment_of_your_own>"),
        "{}",
        shown[2]
    );
    assert_eq!(shown[3..], ["assistant Found your keys yet?", "user Yes!"]);
}

/// A moment in which she used a tool and then said nothing ends quietly:
/// what the tool did stands, and the next turn's prompt shows the moment and
/// its tool work.
#[tokio::test]
async fn a_moment_that_used_a_tool_and_said_nothing_ends_quietly_and_its_tool_work_is_replayed() {
    let kept = Arc::new(Mutex::new(Vec::new()));
    let notes = {
        let kept = Arc::clone(&kept);

        Toy::new("notes")
            .access(json!({"model_input": "write"}))
            .tool("notes.add", move |call| {
                kept.lock().unwrap().push(call.input()["note"].clone());
                ToolCallOutcome::Accepted {
                    output: json!({"added": call.input()["note"]}),
                    evidence: Vec::new(),
                }
            })
    };
    let mut chat = Chat::new(&[Arc::new(notes)]);

    chat.model.script([
        Round::says(ModelOutput {
            tool_calls: vec![written("notes.add", json!({"note": "keys by the door"}))],
            text: None,
        }),
        Round::says(ModelOutput::default()),
        Round::says(reply(&["By the door."])),
    ]);

    let turn = completed(chat.moment().await);

    assert_eq!(texts(&turn), Vec::<&str>::new());
    assert_eq!(*kept.lock().unwrap(), [json!("keys by the door")]);
    assert_eq!(
        chat.heard.take(),
        [
            "tool_calls_requested 1 notes.add",
            "tool_call_completed 1 notes.add accepted",
        ]
    );
    assert_eq!(
        chat.kinds(1),
        [RECEIVED, ROUND, STARTED, FINISHED, ROUND, COMPLETED]
    );

    completed(chat.say("Where were they?", "where").await);

    let shown = chat.shown(2);

    assert!(shown[0].starts_with(PAST), "{}", shown[0]);
    assert_eq!(
        shown[1..],
        [
            "assistant notes.add",
            r#"tool {"status":"accepted","pluginId":"notes","toolName":"notes.add","output":{"added":"keys by the door"}}"#,
            "user Where were they?",
        ]
    );
}

/// A provider that answers with nothing at all ends a moment, and one that
/// fails refuses it as it refuses a turn the person began.
#[tokio::test]
async fn a_moment_answered_with_nothing_ends_and_one_whose_provider_fails_is_refused() {
    let mut chat = Chat::new(&[]);

    chat.model.script([
        Round::says(ModelOutput::default()),
        Round::fails("The provider answered 503."),
        Round::fails("The provider answered 503."),
    ]);

    assert_eq!(texts(&completed(chat.moment().await)), Vec::<&str>::new());

    let refused = |delivery| match delivery {
        Delivery::Rejected(RejectedTurn { reason, message }) => (reason, message),
        other => panic!("{other:?}"),
    };
    let moment = refused(chat.moment().await);

    assert_eq!(
        moment,
        ("provider_error", "The provider answered 503.".to_owned())
    );
    assert_eq!(refused(chat.say("Hello?", "hello").await), moment);
    assert_eq!(
        chat.kinds(1),
        [
            RECEIVED, ROUND, COMPLETED, RECEIVED, ROUND, REJECTED, RECEIVED, COMMITTED, ROUND,
            REJECTED
        ]
    );
}
