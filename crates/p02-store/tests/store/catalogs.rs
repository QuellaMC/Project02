//! The catalogs: a character's sessions and their directories, which must
//! agree; a home's conversations, one record per thread; and the record of
//! the lines a conversation's segments took.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::num::NonZeroU64;

use p02_core::{ClientStamp, ConversationId, MessageId, Participant, SpeakerName};
use p02_store::{StorageError, TakenLines};
use serde_json::{Value, json};

use crate::support::{Script, World, answer, id, lines_of, sam};

fn ids(sessions: &[p02_store::SessionEntry]) -> Vec<String> {
    sessions
        .iter()
        .map(|entry| entry.session_id().to_string())
        .collect()
}

fn catalog_ids(world: &World) -> Vec<String> {
    lines_of(&world.data.root().join("sessions.jsonl"))
        .iter()
        .map(|row| {
            serde_json::from_str::<Value>(row).unwrap()["sessionId"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

#[test]
fn a_conversation_is_one_record_per_set_of_participants_found_again_in_any_order() {
    let world = World::new();
    let renamed = vec![
        Participant::local_user(SpeakerName::new("Samuel").unwrap()),
        Participant::character(p02_core::CharacterProfile {
            id: id("mira"),
            display_name: SpeakerName::new("Mira Two").unwrap(),
        }),
    ];
    let zeta = vec![
        Participant::character(p02_core::CharacterProfile {
            id: id("zeta"),
            display_name: SpeakerName::new("Zeta").unwrap(),
        }),
        Participant::local_user(sam()),
    ];

    assert_eq!(
        world.home.ensure_conversation(renamed).unwrap(),
        world.conversation
    );

    let other = world.home.ensure_conversation(zeta).unwrap();
    let record: Value = serde_json::from_slice(
        &std::fs::read(
            world
                .root()
                .join("conversations")
                .join(world.conversation.id().as_str())
                .join("conversation.json"),
        )
        .unwrap(),
    )
    .unwrap();

    assert!(world.conversation.id().as_str().starts_with("conv_"));
    assert_eq!(
        record,
        json!({
            "id": world.conversation.id(),
            "participants": [
                {"kind": "character", "id": "mira", "displayName": "Mira"},
                {"kind": "user", "id": "local-user", "displayName": "Sam"},
            ],
            "createdAt": world.conversation.created_at(),
        })
    );
    assert_eq!(
        world.home.conversations().unwrap(),
        [world.conversation.clone(), other]
    );
    assert_eq!(
        world.home.conversation(world.conversation.id()).unwrap(),
        world.conversation
    );
    assert_eq!(
        world
            .home
            .conversation(&ConversationId::new("conv_absent").unwrap())
            .unwrap_err()
            .code(),
        "conversation_not_found"
    );
}

#[test]
fn a_conversation_directory_without_its_record_is_no_conversation_and_one_naming_another_is_refused()
 {
    let world = World::new();
    let conversations = world.root().join("conversations");
    let interrupted = ConversationId::new("conv_interrupted").unwrap();

    std::fs::create_dir(conversations.join(interrupted.as_str())).unwrap();
    std::fs::write(conversations.join(".DS_Store"), "Finder").unwrap();

    assert_eq!(
        world.home.conversations().unwrap(),
        std::slice::from_ref(&world.conversation)
    );
    assert_eq!(
        world.home.conversation(&interrupted).unwrap_err().code(),
        "conversation_not_found"
    );

    std::fs::copy(
        conversations
            .join(world.conversation.id().as_str())
            .join("conversation.json"),
        conversations
            .join(interrupted.as_str())
            .join("conversation.json"),
    )
    .unwrap();

    let refused = world.home.conversations().unwrap_err();

    assert_eq!(refused.code(), "malformed_record");
    assert!(
        refused.to_string().contains("not its own directory"),
        "{refused}"
    );
}

#[test]
fn segments_are_made_in_order_and_only_the_newest_goes_on_or_is_discarded() {
    let world = World::new();
    let conversation = world.conversation.id();
    let first = world.first_segment(conversation).unwrap();
    let mut script = Script::new(world.segment(1));

    assert_eq!(
        world.first_segment(conversation).unwrap_err().code(),
        "session_already_exists"
    );

    script
        .turn("Hello?")
        .user("hello")
        .round(Some(answer(&["Hi."], &[], None)))
        .replies()
        .completed();

    let mut writer = world.log(1).writer().unwrap();

    for record in &script.records {
        writer.append(record.clone()).unwrap();
    }

    writer.release();

    let second = world.next_segment(first.session_id()).unwrap();

    assert_eq!(second.session_id(), &world.segment(2));
    assert_eq!(
        world.next_segment(first.session_id()).unwrap_err().code(),
        "session_not_found"
    );
    assert_eq!(
        world.log(1).writer().unwrap().discard().unwrap_err().code(),
        "session_not_found"
    );
    assert_eq!(
        world.data.latest_segment(conversation).unwrap(),
        Some(second.clone())
    );
    assert_eq!(ids(&world.data.sessions().unwrap()), catalog_ids(&world));
    assert_eq!(world.data.sessions().unwrap(), [first, second]);
}

#[test]
fn a_catalog_a_crash_cut_mid_row_still_lists_every_session_before_the_cut() {
    let world = World::new();
    let catalog = world.data.root().join("sessions.jsonl");

    world.first_segment(world.conversation.id()).unwrap();
    world.next_segment(&world.segment(1)).unwrap();
    world.next_segment(&world.segment(2)).unwrap();

    let rows = lines_of(&catalog);

    for tail in [&rows[2][..rows[2].len() / 2], rows[2].as_str()] {
        std::fs::write(&catalog, format!("{}\n{}\n{tail}", rows[0], rows[1])).unwrap();

        assert_eq!(
            ids(&world.data.sessions().unwrap()),
            [world.segment(1).to_string(), world.segment(2).to_string()]
        );
    }

    world.log(2).writer().unwrap().discard().unwrap();
    assert_eq!(catalog_ids(&world), [world.segment(1).to_string()]);
}

#[test]
fn what_an_interrupted_operation_leaves_is_tolerated() {
    let world = World::new();
    let sessions = world.data.root().join("sessions");

    world.first_segment(world.conversation.id()).unwrap();

    let orphan = sessions.join("conv_orphan.1");
    let torn = world.path_of(&world.segment(2));

    std::fs::create_dir(&orphan).unwrap();
    std::fs::write(orphan.join(".DS_Store"), "Finder").unwrap();
    std::fs::write(sessions.join(".DS_Store"), "Finder").unwrap();
    std::fs::create_dir(torn.parent().unwrap()).unwrap();
    std::fs::write(&torn, r#"{"eventId":"evt_torn","kin"#).unwrap();

    assert_eq!(
        ids(&world.data.sessions().unwrap()),
        [world.segment(1).to_string()]
    );

    let continued = world.next_segment(&world.segment(1)).unwrap();
    let mut script = Script::new(continued.session_id().clone());

    script.turn("Hello?");

    let mut writer = world.log(2).writer().unwrap();

    writer.append(script.records[0].clone()).unwrap();
    writer.release();
    assert_eq!(lines_of(&torn), [script.records[0].to_line()]);
    assert_eq!(
        world.log(2).writer().unwrap().discard().unwrap_err().code(),
        "session_not_empty"
    );

    let empty = world.next_segment(&world.segment(2)).unwrap();

    world.log(3).writer().unwrap().discard().unwrap();
    assert_eq!(
        world
            .data
            .latest_segment(world.conversation.id())
            .unwrap()
            .map(|e| e.session_id().clone()),
        Some(world.segment(2))
    );
    assert!(!sessions.join(empty.session_id().to_string()).exists());
}

#[test]
fn damage_in_the_catalog_or_beside_it_is_reported_never_read_as_fewer_sessions() {
    let world = World::new();
    let catalog = world.data.root().join("sessions.jsonl");
    let first = world.first_segment(world.conversation.id()).unwrap();
    let mut script = Script::new(world.segment(1));

    script
        .turn("Hello?")
        .user("hello")
        .round(Some(answer(&["Hi."], &[], None)))
        .replies()
        .completed();

    let mut writer = world.log(1).writer().unwrap();

    for record in &script.records {
        writer.append(record.clone()).unwrap();
    }

    writer.release();

    let rows = std::fs::read_to_string(&catalog).unwrap();

    std::fs::write(&catalog, format!("{rows}{{\"sessionId\": 7}}\n")).unwrap();

    let refused = world.data.sessions().unwrap_err();

    assert_eq!(refused.code(), "malformed_record");
    assert!(
        matches!(refused, StorageError::MalformedCatalogRow { line: 2, .. }),
        "{refused}"
    );
    assert_eq!(world.data.session(first.session_id()).unwrap(), first);
    assert_eq!(world.log(1).read().unwrap().records(), script.records);

    std::fs::write(&catalog, format!("{rows}{rows}")).unwrap();

    for refused in [
        world.data.sessions().map(drop).unwrap_err(),
        world
            .data
            .session(first.session_id())
            .map(drop)
            .unwrap_err(),
    ] {
        assert!(
            matches!(refused, StorageError::RepeatedCatalogRow { line: 2, .. }),
            "{refused}"
        );
    }

    std::fs::remove_file(&catalog).unwrap();

    for refused in [
        world.data.sessions().map(drop).unwrap_err(),
        world
            .data
            .session(first.session_id())
            .map(drop)
            .unwrap_err(),
        world
            .first_segment(&ConversationId::new("conv_new").unwrap())
            .map(drop)
            .unwrap_err(),
    ] {
        assert_eq!(refused.code(), "missing_file", "{refused}");
    }

    assert!(!catalog.exists());

    std::fs::write(&catalog, &rows).unwrap();
    std::fs::rename(
        world
            .data
            .root()
            .join("sessions")
            .join(first.session_id().to_string()),
        world.data.root().join("moved"),
    )
    .unwrap();

    for refused in [
        world.data.sessions().map(drop).unwrap_err(),
        world.log(1).read().map(drop).unwrap_err(),
    ] {
        assert_eq!(refused.code(), "missing_file", "{refused}");
    }

    std::fs::rename(
        world.data.root().join("moved"),
        world
            .data
            .root()
            .join("sessions")
            .join(first.session_id().to_string()),
    )
    .unwrap();
    std::fs::write(world.data.root().join("sessions").join("stray.txt"), "?").unwrap();
    assert_eq!(
        world.data.sessions().unwrap_err().code(),
        "malformed_record"
    );
}

#[test]
fn taken_lines_read_back_whole_and_a_record_that_cannot_be_read_reads_as_none() {
    let world = World::new();
    let writer = world
        .home
        .conversation_writer(world.conversation.id())
        .unwrap();
    let message = |segment: u64, number: u64| {
        MessageId::new(world.segment(segment), NonZeroU64::new(number).unwrap())
    };
    let stamp = |text: &str| ClientStamp::new(text).unwrap();
    let mut taken = TakenLines::default();

    taken.insert(
        NonZeroU64::new(2).unwrap(),
        BTreeMap::from([(stamp("two"), message(2, 1))]),
    );
    taken.insert(
        NonZeroU64::MIN,
        BTreeMap::from([
            (stamp("one"), message(1, 1)),
            (stamp("again"), message(1, 3)),
        ]),
    );
    taken.write(&world.data, &writer).unwrap();
    writer.release();

    let path = world
        .data
        .root()
        .join("taken-lines")
        .join(format!("{}.json", world.conversation.id()));
    let read = TakenLines::read(&world.data, world.conversation.id());

    assert_eq!(read, taken);
    assert_eq!(read.taken(&stamp("again")), Some(&message(1, 3)));
    assert_eq!(read.taken(&stamp("absent")), None);
    assert!(read.covers(NonZeroU64::new(2).unwrap()));
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap(),
        json!({"segments": {
            "1": {"again": message(1, 3), "one": message(1, 1)},
            "2": {"two": message(2, 1)},
        }})
    );

    for unreadable in [
        "not JSON".to_owned(),
        r#"{"segments": {"01": {}}}"#.to_owned(),
        r#"{"segments": {"1": {"one": 7}}}"#.to_owned(),
        json!({"segments": {"1": {"two words": message(1, 1)}}}).to_string(),
        r#"{"segments": []}"#.to_owned(),
        json!({"segments": {"1": {"one": "conv_other.1:message-1"}}}).to_string(),
        json!({"segments": {"2": {"one": message(1, 1)}}}).to_string(),
    ] {
        std::fs::write(&path, &unreadable).unwrap();

        assert_eq!(
            TakenLines::read(&world.data, world.conversation.id()),
            TakenLines::default(),
            "{unreadable}"
        );
    }
}

/// A listing that meets a session being made or discarded in the middle of
/// its read is read again, and never reports what it raced as damage. The
/// race needs a read that takes a while, as a long-lived home's does, so
/// the catalog first lists thousands of sessions.
#[test]
fn a_listing_raced_by_a_session_made_or_discarded_never_reports_damage() {
    let world = World::new();
    let mut rows = String::new();

    for n in 1..=3_000 {
        let id = format!("conv_old{n}.1");

        std::fs::create_dir_all(world.data.root().join("sessions").join(&id)).unwrap();
        writeln!(
            rows,
            r#"{{"sessionId":"{id}","createdAt":"2026-10-20T00:00:00.000Z"}}"#
        )
        .unwrap();
    }

    std::fs::write(world.data.root().join("sessions.jsonl"), rows).unwrap();

    let first = world.first_segment(world.conversation.id()).unwrap();

    std::thread::scope(|scope| {
        let writer = scope.spawn(|| {
            let mut latest = first.session_id().clone();

            for _ in 0..20 {
                let kept = world.next_segment(&latest).unwrap();
                let mut script = Script::new(kept.session_id().clone());
                let mut writer = world
                    .log(kept.session_id().segment().get())
                    .writer()
                    .unwrap();

                script.turn("Hello?");
                writer.append(script.records[0].clone()).unwrap();
                writer.release();
                latest = kept.session_id().clone();

                let empty = world.next_segment(&latest).unwrap();

                world
                    .log(empty.session_id().segment().get())
                    .writer()
                    .unwrap()
                    .discard()
                    .unwrap();
            }
        });

        while !writer.is_finished() {
            for read in [
                world.data.sessions().map(drop),
                world.data.latest_segment(world.conversation.id()).map(drop),
            ] {
                if let Err(error) = read {
                    assert_eq!(error.code(), "concurrent_write", "{error}");
                }
            }
        }

        writer.join().unwrap();
    });
}
