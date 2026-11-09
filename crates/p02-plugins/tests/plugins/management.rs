//! The host's own plugin in Mira's host as her daemon builds it: the list
//! of plugins, and her settings read and changed through it.

use p02_contracts::ToolCallResult;
use p02_plugins::{BeforeCallOutcome, PluginHost, ToolCallReport};
use p02_shared::read_file;
use p02_store::SettingsDocument;
use serde_json::{Value, json};

use crate::home::{MiraHome, Person, rewrite};
use crate::support::{call, run_round, turn};

async fn ask(host: &PluginHost, tool: &str, input: Value) -> ToolCallReport {
    run_round(host, vec![call("c1", tool, input)], &turn())
        .await
        .remove(0)
}

fn output(report: &ToolCallReport) -> &Value {
    match &report.result {
        ToolCallResult::Accepted { output } => output,
        ToolCallResult::Rejected { reason, message } => panic!("{reason}: {message}"),
    }
}

fn reason(report: &ToolCallReport) -> Option<&str> {
    match &report.result {
        ToolCallResult::Accepted { .. } => None,
        ToolCallResult::Rejected { reason, .. } => Some(reason),
    }
}

/// Each plugin a listing names, with whether it runs and its status.
fn listed(report: &ToolCallReport) -> Vec<(String, bool, String)> {
    output(report)["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .map(|plugin| {
            (
                plugin["id"].as_str().unwrap().to_owned(),
                plugin["enabled"].as_bool().unwrap(),
                plugin["activationStatus"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn update(fingerprint: &str, change: &Value) -> Value {
    let mut input = json!({
        "pluginId": "demo-config",
        "fieldName": "tone",
        "expectedFingerprint": fingerprint,
    });

    for (key, value) in change.as_object().unwrap() {
        input[key] = value.clone();
    }

    input
}

/// Demo-config's settings in Mira's own settings.
fn demo_config(home: &MiraHome) -> Value {
    home.overlay()["plugins"]["demo-config"]["config"].clone()
}

#[tokio::test]
async fn the_list_names_the_plugins_she_runs_and_on_asking_every_other_as_her_settings_decide() {
    let home = MiraHome::new();

    home.settings(&json!({"plugins": {"demo-config": {"enabled": true, "config": {"tone": 42}}}}));

    let host = home.mira(Person::approving());
    let running = ask(&host, "runtime.plugin.list", json!({})).await;
    let everything = ask(&host, "runtime.plugin.list", json!({"scope": "all"})).await;
    let disabled_too = ask(
        &host,
        "runtime.plugin.list",
        json!({"includeDisabled": true}),
    )
    .await;
    let runs = |id: &str| (id.to_owned(), true, "active".to_owned());
    let not = |id: &str, status: &str| (id.to_owned(), false, status.to_owned());

    assert_eq!(
        listed(&running),
        [runs("runtime.plugin")],
        "a setting in error stops her: no plugin of hers runs"
    );
    let own = &output(&running)["plugins"][0];
    let tools: Vec<(&str, &str, bool)> = own["providedTools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| {
            (
                tool["name"].as_str().unwrap(),
                tool["concurrency"].as_str().unwrap(),
                tool["requiresConfirmation"].as_bool().unwrap(),
            )
        })
        .collect();

    assert_eq!(own["kind"], "first_party");
    assert_eq!(own["grantedAccess"], json!({"model_input": "write"}));
    assert_eq!(own["registeredLifecycleHooks"], json!(["handleToolCall"]));
    assert_eq!(
        tools,
        [
            ("runtime.plugin.list", "shared", false),
            ("runtime.plugin.config", "shared", false),
            ("runtime.plugin.config.update", "exclusive", true),
        ],
        "exactly the tools the model is offered"
    );
    assert_eq!(
        own["providedTools"][2]["description"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        160,
        "a text is cut to what a listing keeps"
    );
    assert_eq!(
        listed(&everything),
        [
            runs("runtime.plugin"),
            not("character-memory", "blocked"),
            not("character-state", "blocked"),
            not("demo-config", "blocked"),
            not("mem0", "disabled"),
            not("session-history", "blocked"),
        ],
        "a plugin her settings block is listed blocked"
    );
    assert_eq!(
        output(&everything)["plugins"][3]["grantedAccess"],
        json!({})
    );
    assert_eq!(output(&everything)["truncated"], false);
    assert_eq!(listed(&disabled_too), listed(&everything));
}

#[tokio::test]
async fn the_config_read_shows_a_plugins_settings_a_secret_redacted() {
    let secret = "sk-demo-secret-value";
    let home = MiraHome::new();

    home.settings(&json!({
        "plugins": {"demo-config": {"enabled": true, "config": {"signoff": "Yours."}}},
    }));

    let host = home.mira(Person::approving());

    home.change("demo-config", "tone", json!("warm"));
    home.change("demo-config", "apiKey", json!(secret));

    let read = ask(
        &host,
        "runtime.plugin.config",
        json!({"pluginId": "demo-config"}),
    )
    .await;
    let fields = output(&read)["fields"].as_array().unwrap();
    let field = |name: &str| {
        fields
            .iter()
            .find(|field| field["name"] == name)
            .unwrap()
            .clone()
    };

    assert_eq!(output(&read)["id"], "demo-config");
    assert_eq!(output(&read)["displayName"], "Demo Config");
    assert_eq!(output(&read)["activation"]["status"], "active");
    assert_eq!(output(&read)["fingerprint"], home.fingerprint());
    assert_eq!(output(&read)["diagnostics"], json!([]));
    assert_eq!(
        field("tone")["authored"],
        json!({"configured": true, "value": "warm"})
    );
    assert_eq!(field("signoff")["authored"], json!({"configured": false}));
    assert_eq!(field("signoff")["effectiveSource"], "global");
    assert_eq!(field("signoff")["effective"]["value"], "Yours.");
    assert_eq!(field("apiKey")["sensitive"], true);
    assert_eq!(field("apiKey")["effective"]["sensitive"], true);
    assert_eq!(
        field("apiKey")["authored"],
        json!({"configured": true, "value": "[redacted]"})
    );
    assert!(
        !serde_json::to_string(&(&read.result, &read.evidence))
            .unwrap()
            .contains(secret)
    );
}

#[tokio::test]
async fn what_needs_her_settings_fails_saying_why_while_they_do_not_load() {
    let home = MiraHome::new();
    let host = home.mira(Person::approving());

    rewrite(&home.path(SettingsDocument::Home), "{");

    let running = ask(&host, "runtime.plugin.list", json!({})).await;
    let everything = ask(&host, "runtime.plugin.list", json!({"scope": "all"})).await;
    let read = ask(
        &host,
        "runtime.plugin.config",
        json!({"pluginId": "demo-config"}),
    )
    .await;

    assert_eq!(
        listed(&running).len(),
        4,
        "what the host runs it lists without them"
    );

    for refused in [everything, read] {
        assert_eq!(
            refused.result,
            ToolCallResult::Rejected {
                reason: "handler_failed".to_owned(),
                message: "a settings document does not load".to_owned(),
            }
        );
    }
}

#[tokio::test]
async fn an_approved_update_is_written_to_her_overlay_live_and_bound_to_the_fingerprint_it_was_read_under()
 {
    let home = MiraHome::new();

    home.settings(&json!({"plugins": {"demo-config": {"enabled": true}}}));

    let home_settings = read_file(&home.path(SettingsDocument::Home)).unwrap();
    let person = Person::approving();
    let host = home.mira(person.clone());
    let read = home.fingerprint();
    let set = json!({"operation": "set", "value": "formal"});
    let applied = ask(&host, "runtime.plugin.config.update", update(&read, &set)).await;

    assert_eq!(
        person.asked()[0].preview,
        *json!({
            "kind": "runtime_plugin_config_change",
            "targetPluginId": "demo-config",
            "fieldName": "tone",
            "operation": "set",
            "expectedFingerprint": read,
            "before": {"configured": false},
            "after": {"configured": true, "value": "formal"},
        })
        .as_object()
        .unwrap()
    );
    assert_eq!(
        output(&applied),
        &json!({
            "status": "applied",
            "appliesTo": "now",
            "pluginId": "demo-config",
            "fieldName": "tone",
            "operation": "set",
            "fingerprint": home.fingerprint(),
            "reloadRequired": false,
        })
    );
    assert_eq!(demo_config(&home), json!({"tone": "formal"}));
    assert_eq!(
        read_file(&home.path(SettingsDocument::Home)).unwrap(),
        home_settings,
        "never the home's settings"
    );

    let BeforeCallOutcome::Prepared(prepared) = host.before_role_model_call(&turn()).await else {
        panic!("no plugin rejects the turn");
    };

    assert!(
        prepared
            .runtime_notes
            .iter()
            .any(|note| note.text().contains("speak in a formal tone")),
        "applied live, the plugin rebuilt with it"
    );

    let stale = ask(&host, "runtime.plugin.config.update", update(&read, &set)).await;

    assert_eq!(reason(&stale), Some("plugin_config_fingerprint_conflict"));
    assert_eq!(person.asked().len(), 1, "refused unasked");

    let waiting = Person::holding();
    let host = home.mira(waiting.clone());
    let pirate = json!({"operation": "set", "value": "pirate"});
    let (moved, ()) = tokio::join!(
        ask(
            &host,
            "runtime.plugin.config.update",
            update(&home.fingerprint(), &pirate)
        ),
        async {
            waiting.being_asked().await;
            home.change("demo-config", "signoff", json!("Yours."));
            waiting.answer();
        }
    );

    assert_eq!(reason(&moved), Some("plugin_config_fingerprint_conflict"));
    assert_eq!(
        demo_config(&home),
        json!({"tone": "formal", "signoff": "Yours."}),
        "an update her settings moved under writes nothing"
    );
}

#[tokio::test]
async fn an_unset_is_shown_as_an_unset_and_leaves_the_field_to_the_settings_beneath() {
    let home = MiraHome::new();

    home.settings(&json!({"plugins": {"demo-config": {"enabled": true}}}));

    let person = Person::approving();
    let host = home.mira(person.clone());

    home.change("demo-config", "tone", json!("formal"));

    let unset = ask(
        &host,
        "runtime.plugin.config.update",
        update(&home.fingerprint(), &json!({"operation": "unset"})),
    )
    .await;
    let preview = &person.asked()[0].preview;

    assert_eq!(preview["operation"], "unset");
    assert_eq!(
        preview["before"],
        json!({"configured": true, "value": "formal"})
    );
    assert_eq!(preview["after"], json!({"configured": false}));
    assert_eq!(output(&unset)["operation"], "unset");
    assert_eq!(output(&unset)["appliesTo"], "now");
    assert_eq!(demo_config(&home), Value::Null);
}

#[tokio::test]
async fn with_runtime_plugin_switched_off_none_of_its_tools_is_offered() {
    let home = MiraHome::new();

    home.settings(&json!({"plugins": {"runtime.plugin": {"enabled": false}}}));

    let host = home.mira(Person::approving());

    assert!(
        host.tool_definitions()
            .definitions()
            .iter()
            .all(|definition| !definition
                .tool
                .name()
                .as_str()
                .starts_with("runtime.plugin"))
    );
    assert!(
        host.tool_definitions().get("memory.update").is_some(),
        "the other plugins' tools stay"
    );
}
