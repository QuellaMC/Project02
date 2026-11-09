//! What a session's log is replayed into: the turns its model is shown,
//! and the session its visible messages make.

use std::num::{NonZeroU32, NonZeroU64};

use p02_contracts::{ConversationTurn, ToolCallResult};
use p02_core::{
    Conversation, ConversationId, EventId, Participant, SessionId, Timestamp, UserLine,
    VisibleMessageRole,
};
use p02_store::{
    ContinuedFrom, LogRecord, RecordBody, SessionContinuation, SessionContinued, SessionWriter,
    Summarizer,
};
use serde_json::json;

use crate::support::{Script, World, answer, id, mira, sam};

/// Appends `records` through `writer`, then releases it.
pub(crate) fn written(mut writer: SessionWriter, records: &[LogRecord]) {
    for record in records {
        writer.append(record.clone()).unwrap();
    }

    writer.release();
}

fn texts(turn: &ConversationTurn) -> Vec<&str> {
    turn.visible_messages()
        .map(|message| message.text.as_str())
        .collect()
}

#[test]
fn a_turn_replays_as_its_line_its_answered_tool_rounds_and_its_final_replies() {
    let world = World::new();
    let mut script = Script::new(world.segment(1));
    let writer = world.first_segment(&world.conversation).unwrap();

    script
        .turn("Feeling?")
        .user("feeling")
        .round(Some(answer(
            &["Let me see."],
            &["curious", "calm"],
            Some("Checking my mood."),
        )))
        .replies()
        .start_calls()
        .finish_calls()
        .round(Some(answer(&["Curious.", "And calm."], &[], None)))
        .replies()
        .completed();
    script.refused_input(" \t\n ");
    script
        .turn("Cut short?")
        .user("cut")
        .round(Some(answer(&[], &["tired"], None)))
        .start_calls();
    script
        .turn("Still there?")
        .user("still")
        .round(Some(answer(&["Here."], &[], None)))
        .replies()
        .completed();
    written(writer, &script.records);

    let history = world.log(1).read().unwrap().history();
    let [tools, cut_short, replied] = history.turns.as_slice() else {
        panic!("{:#?}", history.turns);
    };
    let round = &tools.tool_rounds[0];

    assert_eq!(history.summary, None);
    assert_eq!(
        texts(tools),
        ["Feeling?", "Let me see.", "Curious.", "And calm."]
    );
    assert_eq!(tools.tool_rounds.len(), 1);
    assert_eq!(round.round, NonZeroU32::MIN);
    assert_eq!(round.text.as_deref(), Some("Checking my mood."));
    assert_eq!(round.interim_replies.len(), 1);
    assert_eq!(
        round
            .tool_calls
            .iter()
            .map(|call| (call.input().clone(), call.result().clone()))
            .collect::<Vec<_>>(),
        ["curious", "calm"].map(|mood| (
            json!({"mood": mood}).as_object().cloned().unwrap(),
            ToolCallResult::Accepted {
                output: json!({"applied": {"mood": mood}, "token": "[redacted]"}),
            },
        ))
    );
    assert_eq!(texts(cut_short), ["Cut short?"]);
    assert_eq!(cut_short.tool_rounds, []);
    assert_eq!(texts(replied), ["Still there?", "Here."]);
}

#[test]
fn a_continued_session_opens_with_its_summary_and_the_turns_it_carried() {
    let world = World::new();
    let mut first = Script::new(world.segment(1));
    let writer = world.first_segment(&world.conversation).unwrap();

    first
        .turn("Tea?")
        .user("tea")
        .round(Some(answer(&["Tea, always."], &[], None)))
        .replies()
        .completed();
    written(writer, &first.records);

    let carried = world.log(1).read().unwrap().history().turns;
    let continued = world.next_segment(&world.conversation, 1).unwrap();
    let mut second = Script::new(continued.session_id().clone());
    let identity = first.records[0].identity().clone();
    let continuation = SessionContinuation::new(
        continued.session_id().clone(),
        ContinuedFrom {
            session_id: world.segment(1),
            last_event_id: EventId::new("evt_1").unwrap(),
        },
        "They talked about tea.".to_owned(),
        NonZeroU32::MIN,
        carried.clone(),
        Summarizer::Fallback {
            reason: "The provider has no model to ask.".to_owned(),
        },
    );

    second.push(
        &p02_core::EventIdentity::new(
            EventId::new("evt_continued").unwrap(),
            p02_core::TraceId::new("trace_continued").unwrap(),
            identity.created_at().clone(),
        )
        .unwrap(),
        RecordBody::SessionContinued(SessionContinued {
            session_continuation: continuation,
        }),
    );
    second
        .turn("Coffee?")
        .user("coffee")
        .round(Some(answer(&["Never."], &[], None)))
        .replies()
        .completed();
    written(continued, &second.records);

    let history = world.log(2).read().unwrap().history();

    assert_eq!(history.summary.as_deref(), Some("They talked about tea."));
    assert_eq!(history.turns[..1], carried);
    assert_eq!(texts(&history.turns[1]), ["Coffee?", "Never."]);
}

#[test]
fn a_log_makes_its_session_through_the_core_gate_numbering_after_the_last_message() {
    let world = World::new();
    let mut script = Script::new(world.segment(1));
    let writer = world.first_segment(&world.conversation).unwrap();

    script
        .turn("One?")
        .user("one")
        .round(Some(answer(&["Two."], &[], None)))
        .replies()
        .completed();
    script.skip_message();
    script
        .turn("Three?")
        .user("three")
        .round(None)
        .rejected_by_its_round();
    written(writer, &script.records);

    let replay = world.log(1).read().unwrap();
    let session = replay.session();
    let said: Vec<(String, VisibleMessageRole)> = session
        .messages()
        .iter()
        .map(|message| (message.id.to_string(), message.role))
        .collect();

    assert_eq!(
        said,
        [
            (
                format!("{}:message-1", world.segment(1)),
                VisibleMessageRole::User
            ),
            (
                format!("{}:message-2", world.segment(1)),
                VisibleMessageRole::Character
            ),
            (
                format!("{}:message-4", world.segment(1)),
                VisibleMessageRole::User
            ),
        ]
    );
    assert_eq!(
        session
            .user_message(UserLine::new("Five?").unwrap(), sam())
            .id
            .number(),
        NonZeroU64::new(5).unwrap()
    );
    assert_eq!(
        replay
            .user_lines()
            .keys()
            .map(p02_core::ClientStamp::as_str)
            .collect::<Vec<_>>(),
        ["one", "three"]
    );
}

/// A session's user is the person, whoever else its conversation is
/// between, and a conversation she is not in has no session of hers.
#[test]
fn a_session_is_the_person_s_whoever_else_its_conversation_is_between() {
    let world = World::new();
    let alice = Participant {
        kind: VisibleMessageRole::User,
        id: id("alice"),
    };
    let between = |id: &str, participants| {
        Conversation::new(
            ConversationId::new(id).unwrap(),
            participants,
            Timestamp::new("2026-10-21T00:00:00.000Z").unwrap(),
        )
        .unwrap()
    };
    let group = between(
        "conv_group",
        vec![
            Participant::character(mira().id),
            alice.clone(),
            Participant::local_user(),
        ],
    );
    let mut script = Script::new(SessionId::new(group.id().clone(), NonZeroU64::MIN));
    let writer = world.first_segment(&group).unwrap();

    script
        .turn("Hello?")
        .user("hello")
        .round(Some(answer(&["Hi."], &[], None)))
        .replies()
        .completed();
    written(writer, &script.records);
    assert_eq!(
        world
            .log_of(&group, 1)
            .read()
            .unwrap()
            .session()
            .messages()
            .iter()
            .map(|message| &message.speaker_id)
            .collect::<Vec<_>>(),
        [Participant::local_user_id(), &id("mira")]
    );

    let without = between(
        "conv_without",
        vec![Participant::character(mira().id), alice],
    );

    assert_eq!(
        world.first_segment(&without).unwrap_err().code(),
        "character_identity_mismatch"
    );
    assert_eq!(world.data.sessions().unwrap().sessions.len(), 1);
}
