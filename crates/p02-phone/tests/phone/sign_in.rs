//! How an app that asks a model is signed in on her phone: kept with her
//! phone's own files, whole, read forgivingly, and forgotten when the app
//! is removed.

use p02_phone::{Phone, SignedIn, Source};
use p02_shared::Identifier;
use serde_json::json;

use crate::support::{Files, manifest, text};

fn phone() -> &'static Phone {
    Phone::bundled().unwrap()
}

/// Asker at `version`, as its one file: it asks a model through the
/// person's ChatGPT.
fn asker(version: &str) -> String {
    text(
        &manifest(&json!({
            "id": "asker",
            "name": "Asker",
            "version": version,
            "account": "chatgpt",
        })),
        "export function screen() { return { items: [] }; }",
    )
}

fn signed(connection: &str, model: Option<&str>) -> SignedIn {
    SignedIn {
        connection: Identifier::new(connection).unwrap(),
        model: model.map(str::to_owned),
    }
}

/// How Asker is signed in on the phone `files` keep.
fn asker_signed_in(files: &Files) -> Option<SignedIn> {
    let on_phone = phone().apps(files).unwrap();

    on_phone.signed_in(on_phone.app("asker").unwrap()).cloned()
}

#[test]
fn an_app_signed_in_is_kept_whole_through_its_update_and_forgotten_when_it_is_removed() {
    let mut files = Files::default();

    phone()
        .install(&mut files, &asker("1.0.0"), Source::File)
        .unwrap();

    assert_eq!(asker_signed_in(&files), None);

    phone()
        .sign_in(&mut files, "asker", Some(signed("chatgpt", None)))
        .unwrap();
    phone()
        .sign_in(
            &mut files,
            "asker",
            Some(signed("openai", Some("gpt-6.1-terra"))),
        )
        .unwrap();
    phone()
        .install(&mut files, &asker("1.1.0"), Source::Catalog)
        .unwrap();

    assert_eq!(
        files.documents["signed-in.json"],
        json!({"apps": {"asker": {"connection": "openai", "model": "gpt-6.1-terra"}}})
    );
    assert_eq!(
        asker_signed_in(&files),
        Some(signed("openai", Some("gpt-6.1-terra")))
    );

    phone().sign_in(&mut files, "asker", None).unwrap();

    assert_eq!(files.documents["signed-in.json"], json!({"apps": {}}));

    phone()
        .sign_in(&mut files, "asker", Some(signed("chatgpt", None)))
        .unwrap();
    phone().remove(&mut files, "asker").unwrap();

    assert_eq!(files.documents["signed-in.json"], json!({"apps": {}}));
}

#[test]
fn a_list_of_the_apps_signed_in_that_does_not_read_is_passed_over_and_said_each_app_signed_out() {
    let mut files = Files::default();

    phone()
        .install(&mut files, &asker("1.0.0"), Source::File)
        .unwrap();
    files.documents.insert(
        "signed-in.json".to_owned(),
        json!({"apps": [{"asker": "chatgpt"}]}),
    );

    let on_phone = phone().apps(&files).unwrap();

    assert_eq!(on_phone.signed_in(on_phone.app("asker").unwrap()), None);
    assert_eq!(
        on_phone.passed_over,
        [
            "the list of the apps signed in on the phone does not read, and was passed over: each \
          is signed out"
        ]
    );

    phone()
        .sign_in(&mut files, "asker", Some(signed("chatgpt", None)))
        .unwrap();

    assert_eq!(asker_signed_in(&files), Some(signed("chatgpt", None)));
}
