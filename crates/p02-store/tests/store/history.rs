//! What a session's log is replayed into: the session its visible messages
//! make, and the turns its model replays.

use std::num::NonZeroU64;

use p02_contracts::Rang;
use p02_core::{
    Conversation, ConversationId, Participant, SessionId, Timestamp, UserLine, VisibleMessageRole,
};
use p02_store::{LogRecord, SessionWriter};

use crate::support::{Script, World, answer, id, mira, sam};

/// Appends `records` through `writer`, then releases it.
pub(crate) fn written(mut writer: SessionWriter, records: &[LogRecord]) {
    for record in records {
        writer.append(record.clone()).unwrap();
    }

    writer.release();
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

/// The model replays a turn the person's line began once the line is
/// committed, and a moment of hers once she said something or a call of
/// hers came back. A quiet moment, and a line whose commit never landed,
/// stay in the log alone, and a turn read on its own follows the same rule.
#[test]
fn a_moment_is_replayed_once_she_said_or_did_something_and_a_line_once_it_landed() {
    let world = World::new();
    let mut script = Script::new(world.segment(1));
    let writer = world.first_segment(&world.conversation).unwrap();

    script
        .turn("Tea?")
        .user("tea")
        .round(Some(answer(&["Tea, always."], &[], None)))
        .replies()
        .completed();
    script
        .moment(Vec::new())
        .round(Some(answer(
            &[],
            &[],
            Some("I wonder if Sam found the keys."),
        )))
        .completed();
    script
        .moment(Vec::new())
        .round(Some(answer(&["Found your keys yet?"], &[], None)))
        .replies()
        .completed();
    script
        .moment(Vec::new())
        .round(Some(answer(&[], &["wistful"], None)))
        .start_calls()
        .finish_calls()
        .round(Some(answer(&[], &[], None)))
        .completed();
    script.turn("Still there?");
    written(writer, &script.records);

    let replay = world.log(1).read().unwrap();
    let history = replay.history();
    let replayed: Vec<(&str, Option<&str>, Vec<&str>, usize)> = history
        .turns
        .iter()
        .map(|turn| {
            (
                turn.identity.event_id().as_str(),
                turn.user_message
                    .as_ref()
                    .map(|message| message.text.as_str()),
                turn.final_replies
                    .iter()
                    .map(|reply| reply.text.as_str())
                    .collect(),
                turn.tool_rounds.len(),
            )
        })
        .collect();

    assert_eq!(
        replayed,
        [
            ("evt_1", Some("Tea?"), vec!["Tea, always."], 0),
            ("evt_3", None, vec!["Found your keys yet?"], 0),
            ("evt_4", None, Vec::new(), 1),
        ]
    );

    for record in replay.records() {
        let identity = record.identity();

        assert_eq!(
            replay.turn(identity).is_some(),
            history.turns.iter().any(|turn| &turn.identity == identity),
            "{identity:?}"
        );
    }
}

/// A moment her phone's ringing began is replayed with what rang, as its
/// event tells it, and one her heartbeat began with nothing rung.
#[test]
fn a_moment_is_replayed_with_what_rang_on_her_phone() {
    let world = World::new();
    let mut script = Script::new(world.segment(1));
    let writer = world.first_segment(&world.conversation).unwrap();
    let rang = vec![Rang {
        app: "Clock".to_owned(),
        title: "Alarm".to_owned(),
        body: Some("Wake Sam".to_owned()),
        at: Timestamp::new("2026-10-21T07:00:00.000Z").unwrap(),
    }];

    script
        .moment(rang.clone())
        .round(Some(answer(&["Good morning."], &[], None)))
        .replies()
        .completed();
    script
        .moment(Vec::new())
        .round(Some(answer(&["Found your keys yet?"], &[], None)))
        .replies()
        .completed();
    written(writer, &script.records);

    let replayed: Vec<Vec<Rang>> = world
        .log(1)
        .read()
        .unwrap()
        .history()
        .turns
        .into_iter()
        .map(|turn| turn.rang)
        .collect();

    assert_eq!(replayed, [rang, Vec::new()]);
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
