//! A home and a character's data directory, as the store adopts, makes and
//! refuses them: nothing below either is read or written until its marker
//! vouches for it, and nothing at all is written for one that is refused.

use std::collections::BTreeMap;
use std::path::Path;

use p02_characters::CharacterVersion;
use p02_core::ConversationId;
use p02_store::{CharacterData, StorageError};
use serde_json::{Value, json};

use crate::support::{World, mira};

/// Every file under `root`, with its bytes; a directory left empty counts
/// too, and a link names where it leads.
pub(crate) fn snapshot(root: &Path) -> BTreeMap<String, String> {
    let mut found = BTreeMap::new();

    for entry in std::fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        let name = path.strip_prefix(root).unwrap().display().to_string();
        let kind = entry.file_type().unwrap();

        if kind.is_symlink() {
            found.insert(
                name,
                format!("-> {}", std::fs::read_link(&path).unwrap().display()),
            );
        } else if kind.is_dir() {
            let inner = snapshot(&path);

            for (inner_name, content) in &inner {
                found.insert(format!("{name}/{inner_name}"), content.clone());
            }

            if inner.is_empty() {
                found.insert(name, "<empty>".to_owned());
            }
        } else {
            found.insert(
                name,
                String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned(),
            );
        }
    }

    found
}

pub(crate) fn link(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, link).unwrap();
    } else {
        std::os::windows::fs::symlink_file(target, link).unwrap();
    }
}

fn marker(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn a_home_and_her_data_are_marked_at_version_15_with_their_scope_and_her_name() {
    let world = World::new();
    let home = marker(&world.root().join("schema.json"));
    let data = marker(&world.data.root().join("schema.json"));

    assert_eq!(home["createdAt"].as_str().map(str::len), Some(24));
    assert_eq!(
        home,
        json!({"schemaVersion": 15, "scope": "home", "createdAt": home["createdAt"]})
    );
    assert_eq!(
        data,
        json!({
            "schemaVersion": 15,
            "scope": "character-data",
            "characterId": "mira",
            "createdAt": data["createdAt"],
        })
    );
    assert_eq!(world.data.package_version(), None);
}

#[test]
fn the_merged_package_version_is_recorded_beside_her_marker() {
    let world = World::new();
    let mut data = world.data.clone();

    data.record_package_version(CharacterVersion::new("1.1.0").unwrap())
        .unwrap();

    let reopened = CharacterData::open(&world.home, &mira().id)
        .unwrap()
        .unwrap();

    assert_eq!(
        reopened.package_version().map(CharacterVersion::as_str),
        Some("1.1.0")
    );
    assert_eq!(
        marker(&world.data.root().join("schema.json"))["materializedCharacterPackageVersion"],
        "1.1.0"
    );
}

/// What each damage is refused as, and the marker put in its place: none
/// stands for a directory there.
#[test]
fn a_marker_of_another_version_or_one_that_is_no_marker_is_refused_and_left_as_it_was() {
    let world = World::new();
    let damages = |marker: &Value| -> Vec<(&str, &str, Option<String>)> {
        let mut older = marker.clone();
        let mut newer = marker.clone();

        older["schemaVersion"] = json!(14);
        newer["schemaVersion"] = json!(99);

        vec![
            ("unsupported_schema_version", "schema version 14", Some(older.to_string())),
            ("unsupported_schema_version", "schema version 99", Some(newer.to_string())),
            ("malformed_schema_marker", "not valid JSON", Some(r#"{"schemaVersion":"#.to_owned())),
            ("malformed_schema_marker", "whole-number schemaVersion", Some(r#"{"schemaVersion":15.0}"#.to_owned())),
            ("malformed_schema_marker", "malformed", Some(json!({"schemaVersion": 15, "scope": "home", "createdAt": "2026-10-21T00:00:00.000Z", "storeRoot": "/elsewhere"}).to_string())),
            ("malformed_schema_marker", "must be a regular file", None),
        ]
    };

    for (path, open) in [
        (
            world.root().join("schema.json"),
            Box::new(|| world.home.check()) as Box<dyn Fn() -> Result<(), StorageError>>,
        ),
        (
            world.data.root().join("schema.json"),
            Box::new(|| CharacterData::open(&world.home, &mira().id).map(drop)),
        ),
    ] {
        let original = std::fs::read(&path).unwrap();

        for (code, says, bytes) in damages(&marker(&path)) {
            std::fs::remove_file(&path).ok();
            std::fs::remove_dir(&path).ok();

            match &bytes {
                Some(bytes) => std::fs::write(&path, bytes).unwrap(),
                None => std::fs::create_dir(&path).unwrap(),
            }

            let refused = open().unwrap_err();

            assert_eq!(refused.code(), code, "{says}");
            assert!(refused.to_string().contains(says), "{refused}");

            match &bytes {
                Some(bytes) => assert_eq!(&std::fs::read_to_string(&path).unwrap(), bytes),
                None => assert!(path.is_dir()),
            }
        }

        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, &original).unwrap();
        open().unwrap();
    }
}

#[test]
fn an_unmarked_data_directory_holding_history_or_a_foreign_file_is_never_adopted() {
    for name in ["sessions.jsonl", "notes.txt"] {
        let (_directory, home) = World::empty();
        let data = home.root().join("character-data").join("mira");

        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join(name), "").unwrap();

        let refused = CharacterData::ensure(&home, &mira().id).unwrap_err();

        assert_eq!(refused.code(), "missing_file", "{name}");
        assert!(
            refused
                .to_string()
                .contains(&format!("holds \"{name}\" without a data marker")),
            "{refused}"
        );
        assert_eq!(
            snapshot(home.root()),
            BTreeMap::from([(format!("character-data/mira/{name}"), String::new())])
        );
    }
}

#[test]
fn an_unmarked_data_directory_of_control_state_alone_is_adopted() {
    let (_directory, home) = World::empty();
    let data = home.root().join("character-data").join("mira");

    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::create_dir_all(data.join(".locks")).unwrap();
    std::fs::write(data.join("config.json"), "{}").unwrap();

    assert_eq!(CharacterData::open(&home, &mira().id).unwrap(), None);
    assert_eq!(
        CharacterData::ensure(&home, &mira().id)
            .unwrap()
            .character(),
        &mira().id
    );
}

#[test]
fn a_data_directory_copied_from_another_character_is_refused_naming_her_and_left_as_it_was() {
    let world = World::new();
    let zeta = world.root().join("character-data").join("zeta");
    let data = world.data.root();

    world.data.create_session(world.conversation.id()).unwrap();
    std::fs::create_dir_all(&zeta).unwrap();
    for name in ["schema.json", "sessions.jsonl"] {
        std::fs::copy(data.join(name), zeta.join(name)).unwrap();
    }
    std::fs::remove_file(world.root().join("schema.json")).unwrap();

    let copied = snapshot(world.root());
    let zeta_id = p02_shared::Identifier::new("zeta").unwrap();

    for refused in [
        CharacterData::open(&world.home, &zeta_id)
            .map(drop)
            .unwrap_err(),
        CharacterData::ensure(&world.home, &zeta_id)
            .map(drop)
            .unwrap_err(),
    ] {
        assert_eq!(refused.code(), "character_identity_mismatch");
        assert!(
            refused
                .to_string()
                .contains("holds history for character \"mira\""),
            "{refused}"
        );
    }

    assert_eq!(snapshot(world.root()), copied);
}

#[test]
fn an_unmarked_home_holding_more_than_a_home_holds_is_refused_and_left_as_it_was() {
    let (_directory, home) = World::empty();
    let elsewhere = tempfile::TempDir::new().unwrap();

    std::fs::write(home.root().join("config.json"), "{}").unwrap();
    std::fs::write(
        home.root()
            .join(format!(".config.json.{}.tmp", uuid::Uuid::new_v4())),
        "{",
    )
    .unwrap();
    link(elsewhere.path(), &home.root().join("characters"));
    home.check().unwrap();

    std::fs::write(home.root().join("notes.txt"), "Mine.").unwrap();

    let before = snapshot(home.root());
    let refused = CharacterData::ensure(&home, &mira().id).unwrap_err();

    assert_eq!(refused.code(), "missing_file");
    assert!(
        refused
            .to_string()
            .contains("holds \"notes.txt\" and no home marker"),
        "{refused}"
    );
    assert_eq!(snapshot(home.root()), before);
}

/// Each entry, moved elsewhere and linked back, is refused before anything
/// is read through it or written where it leads.
#[test]
fn storage_behind_a_link_is_refused_and_nothing_is_written_where_it_leads() {
    let linked = [
        "character-data",
        "conversations",
        "character-data/mira",
        "character-data/mira/sessions",
        "character-data/mira/taken-lines",
        "character-data/mira/sessions.jsonl",
        "character-data/mira/config.json",
        "character-data/mira/.locks",
        "session",
        "conversation",
    ];

    for path in linked {
        let world = World::new();
        let path = match path {
            "session" => format!("character-data/mira/sessions/{}.1", world.conversation.id()),
            "conversation" => format!("conversations/{}", world.conversation.id()),
            path => path.to_owned(),
        };
        let path = path.as_str();

        world.data.create_session(world.conversation.id()).unwrap();
        std::fs::create_dir_all(world.data.root().join("taken-lines")).unwrap();
        std::fs::write(world.data.root().join("config.json"), "{}").unwrap();

        let elsewhere = tempfile::TempDir::new().unwrap();
        let moved = elsewhere.path().join("moved");

        std::fs::rename(world.root().join(path), &moved).unwrap();
        link(&moved, &world.root().join(path));

        let before = snapshot(elsewhere.path());
        let refused = CharacterData::open(&world.home, &mira().id)
            .and_then(|data| {
                let data = data.unwrap();

                data.sessions()?;
                data.create_session(&ConversationId::new("conv_new").unwrap())?;
                world.home.conversations().map(drop)
            })
            .unwrap_err();

        assert_eq!(refused.code(), "missing_file", "{path}: {refused}");
        assert_eq!(snapshot(elsewhere.path()), before, "{path}");
    }
}
