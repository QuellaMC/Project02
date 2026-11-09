//! A home and a character's data directory, as the store adopts, makes and
//! refuses them: nothing below either is read or written until its marker
//! vouches for it, and nothing at all is written for one that is refused.

use std::collections::BTreeMap;
use std::path::Path;

use p02_store::CharacterData;

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

fn link(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, link).unwrap();
    } else {
        std::os::windows::fs::symlink_file(target, link).unwrap();
    }
}

/// A directory a crash left before her marker reads as no data yet, and
/// her writer adopts it.
#[test]
fn an_unmarked_data_directory_is_adopted() {
    let (_directory, home) = World::empty();
    let data = home.root().join("character-data").join("mira");

    home.ensure().unwrap();
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

/// What a home holds before its marker, its conversations directory still
/// empty among it, is no reason to refuse it; history, or anything else,
/// is, whichever way in is asked.
#[test]
fn an_unmarked_home_holding_history_or_more_than_a_home_holds_is_refused_and_left_as_it_was() {
    for (entry, held) in [
        ("notes.txt", "notes.txt"),
        ("conversations", "conversations/conv_a/conversation.json"),
    ] {
        let (_directory, home) = World::empty();
        let elsewhere = tempfile::TempDir::new().unwrap();
        let held = home.root().join(held);

        std::fs::write(home.root().join("config.json"), "{}").unwrap();
        std::fs::write(
            home.root()
                .join(format!(".config.json.{}.tmp", uuid::Uuid::new_v4())),
            "{",
        )
        .unwrap();
        std::fs::create_dir(home.root().join("character-data")).unwrap();
        std::fs::create_dir(home.root().join("conversations")).unwrap();
        link(elsewhere.path(), &home.root().join("characters"));
        home.check().unwrap();

        std::fs::create_dir_all(held.parent().unwrap()).unwrap();
        std::fs::write(&held, "{}").unwrap();

        let before = snapshot(home.root());

        for refused in [
            CharacterData::ensure(&home, &mira().id)
                .map(drop)
                .unwrap_err(),
            CharacterData::open(&home, &mira().id)
                .map(drop)
                .unwrap_err(),
            home.conversations().map(drop).unwrap_err(),
        ] {
            assert_eq!(refused.code(), "missing_file", "{entry}");
            assert!(
                refused
                    .to_string()
                    .contains(&format!("holds \"{entry}\" and no home marker")),
                "{refused}"
            );
        }

        assert_eq!(snapshot(home.root()), before, "{entry}");
    }
}

/// Before its marker a home holds its characters' data whatever is in it:
/// each character's directory is judged by its own marker when she is
/// reached, so one that is damaged refuses her alone, and the home with the
/// others is adopted.
#[test]
fn an_unmarked_home_adopts_its_character_data_each_directory_judged_as_hers() {
    let (_directory, home) = World::empty();
    let data = home.root().join("character-data");
    let zeta = p02_shared::Identifier::new("zeta").unwrap();

    std::fs::create_dir_all(data.join("mira")).unwrap();
    std::fs::write(data.join("mira").join("config.json"), "{}").unwrap();
    std::fs::create_dir_all(data.join("zeta")).unwrap();
    std::fs::write(data.join("zeta").join("schema.json"), "not json").unwrap();
    home.check().unwrap();

    let refused = CharacterData::ensure(&home, &zeta).unwrap_err();

    assert_eq!(refused.code(), "malformed_schema_marker");
    assert!(!home.root().join("schema.json").exists());
    assert_eq!(
        CharacterData::ensure(&home, &mira().id)
            .unwrap()
            .character(),
        &mira().id
    );
    assert!(home.root().join("schema.json").exists());
}
