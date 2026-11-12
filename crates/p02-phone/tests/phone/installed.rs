//! Apps installed on her phone: kept in her own files beside the apps the
//! phone comes with, updated by installing them again, and removed whole.

use p02_phone::{Phone, Source};
use serde_json::{Value, json};

use crate::support::{Files, actions, input, manifest, millis, now, text};

const SCREEN: &str = "export function screen() { return { items: [] }; }";

fn phone() -> &'static Phone {
    Phone::bundled().unwrap()
}

/// Notes at `version`, as its one file: it shows what she wrote down,
/// writes down what she adds, and sets a ring to remind her.
fn notes(version: &str) -> String {
    text(
        &manifest(&json!({
            "version": version,
            "wakes": true,
            "actions": actions(&["add", "remind"]),
        })),
        "export function screen() {
            const notes = phone.storage.get('notes') ?? [];

            return { items: notes.map((text) => ({ kind: 'text', text })) };
        }
        export function add({ text }) {
            phone.storage.set('notes', [...(phone.storage.get('notes') ?? []), text]);
        }
        export function remind(ring) { phone.rings.set(ring); }",
    )
}

/// Lists, as its one file.
fn lists() -> String {
    text(&manifest(&json!({"id": "lists", "name": "Lists"})), SCREEN)
}

/// A ring of Notes's, to buy milk at 6 PM in New York.
fn milk() -> Value {
    json!({"id": "milk", "at": millis("2026-03-07T23:00:00.000Z"), "title": "Buy milk"})
}

/// What is on the phone `files` keep, an app a line: its id, its version
/// and where it came from.
fn on_phone(files: &Files) -> Vec<String> {
    phone()
        .apps(files)
        .unwrap()
        .apps
        .iter()
        .map(|app| format!("{} {} {:?}", app.id, app.version, app.source))
        .collect()
}

fn act(files: &mut Files, action: &str, given: &Value) {
    phone()
        .act(files, "notes", action, &input(given), &now())
        .unwrap();
}

#[test]
fn an_app_installed_is_on_her_phone_by_name_opens_and_is_updated_keeping_what_it_keeps() {
    let mut files = Files::default();

    phone()
        .install(&mut files, &notes("1.0.0"), Source::File)
        .unwrap();
    phone()
        .install(&mut files, &lists(), Source::Catalog)
        .unwrap();
    act(&mut files, "add", &json!({"text": "milk"}));

    assert_eq!(
        on_phone(&files),
        [
            "clock 1.0.0 None",
            "lists 1.0.0 Some(Catalog)",
            "notes 1.0.0 Some(File)",
            "store 1.0.0 None"
        ]
    );
    assert_eq!(files.texts["apps/notes.txt"], notes("1.0.0"));
    assert_eq!(
        files.documents["installed.json"]["apps"][0],
        json!({
            "id": "notes", "name": "Notes", "summary": "What she writes down",
            "version": "1.0.0", "icon": "notebook", "tint": "orange", "wakes": true,
            "views": [{"id": "all", "title": "All", "icon": "doc"}], "opensOn": "all",
            "source": "file",
        })
    );

    phone()
        .install(&mut files, &notes("1.1.0"), Source::Catalog)
        .unwrap();

    let opened = phone().open(&mut files, "notes", None, &now()).unwrap();

    assert_eq!(
        on_phone(&files),
        [
            "clock 1.0.0 None",
            "lists 1.0.0 Some(Catalog)",
            "notes 1.1.0 Some(Catalog)",
            "store 1.0.0 None"
        ]
    );
    assert_eq!(opened.app.version(), "1.1.0");
    assert_eq!(
        serde_json::to_value(opened.screen).unwrap(),
        json!({"items": [{"kind": "text", "text": "milk"}]})
    );
}

#[test]
fn an_app_that_cannot_be_installed_is_refused_and_nothing_is_written() {
    let mut files = Files::default();

    for (file, refusal) in [
        (
            text(&manifest(&json!({"name": " "})), SCREEN),
            "manifest name must not be blank",
        ),
        (
            text(
                &manifest(&json!({"id": "clock", "name": "My Clock"})),
                SCREEN,
            ),
            "the phone comes with an app of the same id, Clock",
        ),
        (
            text(
                &manifest(&json!({"id": "store", "name": "My Store"})),
                SCREEN,
            ),
            "the phone comes with an app of the same id, App Store",
        ),
    ] {
        assert_eq!(
            phone()
                .install(&mut files, &file, Source::File)
                .unwrap_err()
                .to_string(),
            refusal
        );
    }

    assert_eq!(files.writes, 0);
}

#[test]
fn an_app_removed_takes_its_file_its_place_what_it_keeps_and_its_rings_from_in_front_of_her() {
    let mut files = Files::default();

    phone()
        .install(&mut files, &notes("1.0.0"), Source::File)
        .unwrap();
    act(&mut files, "remind", &milk());

    assert_eq!(phone().rings(&files).unwrap().len(), 1);
    assert_eq!(files.documents["phone.json"]["front"]["app"], "notes");

    phone().remove(&mut files, "notes").unwrap();

    assert_eq!(on_phone(&files), ["clock 1.0.0 None", "store 1.0.0 None"]);
    assert!(files.texts.is_empty());
    assert_eq!(
        files.documents.keys().collect::<Vec<_>>(),
        ["installed.json", "phone.json"]
    );
    assert_eq!(phone().rings(&files).unwrap(), []);
    assert_eq!(files.documents["phone.json"].get("front"), None);

    for (id, refusal) in [
        ("clock", "Clock comes with the phone and cannot be removed"),
        (
            "store",
            "App Store comes with the phone and cannot be removed",
        ),
        ("notes", "there is no app \"notes\" on the phone"),
    ] {
        assert_eq!(
            phone().remove(&mut files, id).unwrap_err().to_string(),
            refusal
        );
    }
}

#[test]
fn her_phone_is_hers_and_an_app_whose_file_is_gone_cannot_run_while_the_rest_of_it_works() {
    let (mut hers, mut another) = (Files::default(), Files::default());

    phone()
        .install(&mut hers, &notes("1.0.0"), Source::File)
        .unwrap();
    act(&mut hers, "remind", &milk());

    assert_eq!(on_phone(&another), ["clock 1.0.0 None", "store 1.0.0 None"]);
    assert_eq!(
        phone()
            .open(&mut another, "notes", None, &now())
            .unwrap_err()
            .to_string(),
        "there is no app \"notes\" on the phone"
    );

    let told = phone().rings(&hers).unwrap();

    hers.texts.clear();

    assert_eq!(
        on_phone(&hers),
        [
            "clock 1.0.0 None",
            "notes 1.0.0 Some(File)",
            "store 1.0.0 None"
        ]
    );
    assert_eq!(
        phone()
            .open(&mut hers, "notes", None, &now())
            .unwrap_err()
            .to_string(),
        "Notes cannot run: its file is gone"
    );
    assert!(phone().open(&mut hers, "clock", None, &now()).is_ok());
    assert_eq!(
        phone()
            .told(&mut hers, &told, &now())
            .unwrap()
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        ["Notes cannot run: its file is gone"]
    );
    assert_eq!(phone().rings(&hers).unwrap(), []);
}
