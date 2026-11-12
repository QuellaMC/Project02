//! The App Store's catalog: read from its document, and an app's text
//! taken only when it is the file the catalog lists.

use std::fmt::Write as _;

use p02_phone::{Catalog, CatalogError, Phone};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};

use crate::support::{manifest, text};

const SCREEN: &str = "export function screen() { return { items: [] }; }";

/// Notes at `version`, as its one file.
fn notes(version: &str) -> String {
    text(&manifest(&json!({"version": version})), SCREEN)
}

/// The catalog's entry of Notes at `version`, listing the file `file`, with
/// `fields` in place of its own.
fn entry(version: &str, file: &str, fields: &Value) -> Value {
    let mut entry = json!({
        "id": "notes",
        "name": "Notes",
        "summary": "What she writes down",
        "icon": "notebook",
        "tint": "orange",
        "version": version,
        "changes": "The first version.",
        "wakes": false,
        "sha256": Sha256::digest(file).iter().fold(String::new(), |mut hex, byte| {
            // Writing to a String cannot fail.
            let _ = write!(hex, "{byte:02x}");
            hex
        }),
    });

    for (field, value) in fields.as_object().unwrap() {
        entry[field] = value.clone();
    }

    entry
}

fn catalog(apps: &[Value]) -> Vec<u8> {
    json!({"format": "project02.catalog.v1", "apps": apps})
        .to_string()
        .into_bytes()
}

fn ids(read: &Catalog) -> Vec<&str> {
    read.apps().iter().map(|app| app.id().as_str()).collect()
}

#[test]
fn a_catalog_keeps_the_entries_that_read_and_is_refused_when_it_is_none_the_phone_reads() {
    let file = notes("1.0.0");
    let named = |id: &str| entry("1.0.0", &file, &json!({"id": id}));
    let read = Catalog::read(&catalog(&[
        named("notes"),
        named("Lists"),
        entry(
            "1.0.0",
            &file,
            &json!({"id": "tea", "summary": "Two\nlines"}),
        ),
        entry("1.0", &file, &json!({"id": "maps"})),
        entry("1.0.0", &file, &json!({"id": "chess", "sha256": "abc"})),
        entry("1.0.0", &file, &json!({"id": "music", "wakes": null})),
        named("reminders"),
    ]))
    .unwrap();

    assert_eq!(ids(&read), ["notes", "reminders"]);
    assert_eq!(
        read.app("reminders").unwrap().changes(),
        "The first version."
    );

    for (document, refusal) in [
        (
            b"<html>".to_vec(),
            "not one this version of the app can read",
        ),
        (
            json!({"format": "project02.catalog.v2", "apps": []})
                .to_string()
                .into_bytes(),
            "not one this version of the app can read",
        ),
        (
            json!({"format": "project02.catalog.v1"})
                .to_string()
                .into_bytes(),
            "not one this version of the app can read",
        ),
        (
            catalog(&vec![named("notes"); 101]),
            "longer than the phone reads",
        ),
    ] {
        let refused = Catalog::read(&document).unwrap_err().to_string();

        assert!(refused.ends_with(refusal), "{refused}");
    }

    assert_eq!(
        ids(&Catalog::read(&catalog(&vec![named("notes"); 100])).unwrap()).len(),
        100
    );
}

#[test]
fn an_apps_text_is_taken_only_when_it_is_the_file_the_catalog_lists_of_it() {
    let phone = Phone::new(Vec::new());
    let file = notes("1.0.0");
    let not_an_app = SCREEN;
    let read = Catalog::read(&catalog(&[entry("1.0.0", &file, &json!({}))])).unwrap();
    let listed = read.app("notes").unwrap();

    assert_eq!(phone.judge(listed, &file).unwrap().id().as_str(), "notes");

    for (entry, file, why) in [
        (
            entry("1.0.0", &file, &json!({})),
            notes("1.0.1"),
            "its file is not the one whose SHA-256 the catalog lists".to_owned(),
        ),
        (
            entry("1.0.0", not_an_app, &json!({})),
            not_an_app.to_owned(),
            "its file makes no app: the app exports no manifest".to_owned(),
        ),
        (
            entry("1.1.0", &file, &json!({})),
            file.clone(),
            "its file is notes 1.0.0, not the notes 1.1.0 the catalog lists".to_owned(),
        ),
    ] {
        let read = Catalog::read(&catalog(&[entry])).unwrap();
        let refused = phone.judge(read.app("notes").unwrap(), &file).unwrap_err();

        assert_eq!(
            refused.to_string(),
            "Notes in the App Store does not match its listing, so it cannot be installed"
        );
        assert!(
            matches!(&refused, CatalogError::NotTheApp { why: said, .. } if *said == why),
            "{refused:?}"
        );
    }
}
