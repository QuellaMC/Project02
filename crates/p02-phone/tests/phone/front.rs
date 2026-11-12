//! What she has in front on her phone and what she last did on it: put
//! there by her open and her action, left as it was by a look and by a
//! call that fails, read forgivingly, and never what fails a call that
//! stood.

use p02_core::Timestamp;
use p02_phone::{Did, Front, Phone, PhoneState};
use p02_shared::Identifier;
use serde_json::json;

use crate::support::{Files, app, at, took, view};

/// When she opened Notes.
const OPENED: &str = "2026-03-07T17:00:00.000Z";
/// When she starred a note.
const STARRED: &str = "2026-03-07T17:05:00.000Z";

/// Notes, which opens on all its notes, shows the starred ones after she
/// stars one, and will not let her tear one out.
fn notes() -> Phone {
    let action = |name: &str, did: &str, view: &str| {
        json!({
            "name": name,
            "description": "Something to do.",
            "did": did,
            "view": view,
            "input": {"type": "object"},
        })
    };

    Phone::new(vec![app(
        &json!({
            "views": [view("all", "All"), view("starred", "Starred")],
            "actions": [
                action("star", "Starred a note", "starred"),
                action("tear", "Tore a note out", "all"),
            ],
        }),
        "export function screen() { return { items: [] }; }
        export function star() { phone.storage.set('starred', true); }
        export function tear() { throw new Error('The page will not come out.'); }",
    )])
}

fn state(phone: &Phone, files: &Files) -> PhoneState {
    phone.state(files).unwrap()
}

/// Notes in front of her on `view`, and what she last did in it.
fn in_notes(view: &str, words: &str, moment: &str) -> PhoneState {
    let notes = Identifier::new("notes").unwrap();

    PhoneState {
        front: Some(Front {
            app: notes.clone(),
            view: Identifier::new(view).unwrap(),
        }),
        did: Some(Did {
            app: notes,
            words: words.to_owned(),
            at: Timestamp::new(moment).unwrap(),
        }),
    }
}

#[test]
fn her_open_and_her_action_say_what_she_has_in_front_and_did_and_nothing_else_does() {
    let phone = notes();
    let mut files = Files::default();
    let later = at("2026-03-07T17:10:00.000Z");

    assert_eq!(state(&phone, &files), PhoneState::default());

    phone.open(&mut files, "notes", None, &at(OPENED)).unwrap();

    assert_eq!(
        state(&phone, &files),
        in_notes("all", "Opened Notes", OPENED)
    );

    took(
        &phone,
        &mut files,
        "notes",
        "star",
        &json!({}),
        &at(STARRED),
    )
    .unwrap();

    let written = files.writes;

    phone.look(&files, "notes", "all", &later).unwrap();
    phone
        .open(&mut files, "notes", Some("trash"), &later)
        .unwrap_err();
    took(&phone, &mut files, "notes", "tear", &json!({}), &later).unwrap_err();

    assert_eq!(files.writes, written);
    assert_eq!(
        state(&phone, &files),
        in_notes("starred", "Starred a note", STARRED)
    );
    assert_eq!(
        files.documents["phone.json"],
        json!({
            "front": {"app": "notes", "view": "starred"},
            "did": {"app": "notes", "words": "Starred a note", "at": STARRED},
        })
    );
}

/// What she has in front is kept after the call stood: an open and an
/// action whose keeping fails still stand, the action's own changes saved,
/// and each says why it could not be kept.
#[test]
fn a_call_stands_when_what_she_has_in_front_cannot_be_kept() {
    let phone = notes();
    let mut files = Files {
        unwritable: Some("phone.json"),
        ..Files::default()
    };
    let opened = phone.open(&mut files, "notes", None, &at(OPENED)).unwrap();

    assert!(opened.unkept.is_some());

    let starred = took(
        &phone,
        &mut files,
        "notes",
        "star",
        &json!({}),
        &at(STARRED),
    )
    .unwrap();

    assert!(starred.unkept.is_some());
    assert_eq!(
        files.documents["apps/notes.json"],
        json!({"storage": {"starred": true}, "rings": []})
    );
    assert_eq!(state(&phone, &files), PhoneState::default());
}

#[test]
fn what_she_has_in_front_is_read_forgivingly() {
    let phone = notes();
    let opened = json!({"app": "notes", "words": "Opened Notes", "at": OPENED});
    let mut gone_view = in_notes("all", "Opened Notes", OPENED);

    gone_view.front = None;

    for (kept, read) in [
        (None, PhoneState::default()),
        (
            Some(json!({
                "front": {"app": "weather", "view": "today"},
                "did": {"app": "weather", "words": "Looked at the weather", "at": OPENED},
            })),
            PhoneState::default(),
        ),
        (
            Some(json!({"front": {"app": "notes", "view": "trash"}, "did": opened})),
            gone_view,
        ),
        (
            Some(json!({
                "front": "notes",
                "did": {"app": "notes", "words": "Opened Notes", "at": "yesterday"},
            })),
            PhoneState::default(),
        ),
        (Some(json!(["notes"])), PhoneState::default()),
    ] {
        let mut files = Files::default();

        if let Some(kept) = kept.clone() {
            files.documents.insert("phone.json".to_owned(), kept);
        }

        assert_eq!(state(&phone, &files), read, "{kept:?}");
    }
}
