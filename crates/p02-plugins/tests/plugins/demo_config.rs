//! The demo-config package: the style it tells the character before each
//! turn, as its settings give it.

use p02_plugins::{BeforeCallOutcome, PluginHost};
use serde_json::{Value, json};

use crate::home::{MiraHome, Person};
use crate::support::turn;

const STYLE: &str =
    "Your speaking style right now (adjustable through the runtime.plugin.config tools): speak in";

/// The runtime notes the host hands the next model call.
async fn notes(host: &PluginHost) -> Vec<String> {
    match host.before_role_model_call(&turn()).await {
        BeforeCallOutcome::Prepared(prepared) => prepared
            .runtime_notes
            .iter()
            .map(|note| note.text().to_owned())
            .collect(),
        BeforeCallOutcome::Rejected(rejection) => panic!("the turn was rejected: {rejection:?}"),
    }
}

async fn style(home: &MiraHome, values: Value) -> Vec<String> {
    notes(&home.host(&[("demo-config", values)])).await
}

#[tokio::test]
async fn it_names_the_tone_its_settings_give_and_the_exact_signoff_once_one_is_set() {
    let home = MiraHome::new();

    assert_eq!(
        style(&home, json!({})).await,
        [format!("{STYLE} a neutral tone.")],
        "unset, the tone is the first its field allows"
    );
    assert_eq!(
        style(&home, json!({"tone": "pirate", "signoff": "Arr, matey!"})).await,
        [format!(
            "{STYLE} a pirate tone. End everything you say with the exact signoff \"Arr, matey!\"."
        )]
    );
    assert_eq!(
        style(&home, json!({"signoff": "   "})).await,
        [format!("{STYLE} a neutral tone.")]
    );
    assert!(
        notes(&home.mira(Person::approving()))
            .await
            .iter()
            .all(|note| !note.starts_with(STYLE)),
        "off unless her settings switch it on"
    );
}
