//! The App Store's catalog: read from its document, an app's text taken
//! only when it is the file the catalog lists, and what an app may do said
//! from what it asks for.

use std::fmt::Write as _;

use p02_phone::{App, Catalog, CatalogError, Phone, it_may};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};

use crate::support::{manifest, text};

const SCREEN: &str = "export function screen() { return { items: [] }; }";

/// Notes at `version`, as its one file.
fn notes(version: &str) -> String {
    text(&manifest(&json!({"version": version})), SCREEN)
}

/// Notes reaching `hosts`, on `account` when it names one, as its one file.
fn reaching(hosts: &[&str], account: Option<&str>) -> String {
    text(
        &manifest(&json!({"reaches": hosts, "account": account})),
        SCREEN,
    )
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
        entry(
            "1.0.0",
            &file,
            &json!({"id": "web", "reaches": ["api.tavily.com"], "account": "tavily"}),
        ),
        entry(
            "1.0.0",
            &file,
            &json!({"id": "local", "reaches": ["localhost"]}),
        ),
        entry(
            "1.0.0",
            &file,
            &json!({"id": "chat", "reaches": ["api.openai.com"], "account": "openai"}),
        ),
        named("reminders"),
    ]))
    .unwrap();

    assert_eq!(ids(&read), ["notes", "web", "reminders"]);
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
    let searching = reaching(&["api.tavily.com"], Some("tavily"));
    let not_an_app = SCREEN;
    let asks_otherwise = "its file asks of her phone other than the catalog lists".to_owned();

    for (entry, file) in [
        (entry("1.0.0", &file, &json!({})), &file),
        (
            entry(
                "1.0.0",
                &searching,
                &json!({"reaches": ["api.tavily.com"], "account": "tavily"}),
            ),
            &searching,
        ),
    ] {
        let read = Catalog::read(&catalog(&[entry])).unwrap();

        assert_eq!(
            phone
                .judge(read.app("notes").unwrap(), file)
                .unwrap()
                .id()
                .as_str(),
            "notes"
        );
    }

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
        (
            entry("1.0.0", &file, &json!({"reaches": ["api.tavily.com"]})),
            file.clone(),
            asks_otherwise.clone(),
        ),
        (
            entry("1.0.0", &searching, &json!({"reaches": ["api.tavily.com"]})),
            searching.clone(),
            asks_otherwise.clone(),
        ),
        (
            entry("1.0.0", &file, &json!({"wakes": true})),
            file.clone(),
            asks_otherwise,
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

#[test]
fn what_an_app_may_do_is_said_from_what_it_asks_for_by_its_listing_and_its_file_alike() {
    let read = Catalog::read(&catalog(&[
        entry("1.0.0", SCREEN, &json!({"id": "quiet"})),
        entry(
            "1.0.0",
            SCREEN,
            &json!({
                "id": "search", "wakes": true, "reaches": ["api.tavily.com"], "account": "tavily",
            }),
        ),
        entry(
            "1.0.0",
            SCREEN,
            &json!({
                "id": "weather", "reaches": ["api.open-meteo.com", "geocoding-api.open-meteo.com"],
            }),
        ),
        entry(
            "1.0.0",
            SCREEN,
            &json!({"id": "news", "reaches": ["a.example", "b.example", "c.example"]}),
        ),
    ]))
    .unwrap();
    let said = |id: &str| it_may(read.app(id).unwrap().asks());

    assert_eq!(said("quiet"), ["Keep its own data"]);
    assert_eq!(
        said("search"),
        [
            "Keep its own data",
            "Wake her when something is due",
            "Reach the internet at api.tavily.com",
            "Use your Tavily account",
        ]
    );
    assert_eq!(
        said("weather"),
        [
            "Keep its own data",
            "Reach the internet at api.open-meteo.com and geocoding-api.open-meteo.com",
        ]
    );
    assert_eq!(
        said("news"),
        [
            "Keep its own data",
            "Reach the internet at a.example, b.example and c.example",
        ]
    );
    assert_eq!(
        it_may(
            App::new(&reaching(&["api.tavily.com"], Some("tavily")))
                .unwrap()
                .asks()
        ),
        [
            "Keep its own data",
            "Reach the internet at api.tavily.com",
            "Use your Tavily account",
        ]
    );
}
