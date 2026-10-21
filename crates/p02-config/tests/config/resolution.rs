//! The settings in effect: each value from the nearest document its scope
//! lets the target read, else its default, and what is wrong with them.

use p02_config::Code;
use serde_json::json;

use crate::support::{
    World, document, field, findings, home, host_field, manifest, of, plugins, section,
};

#[test]
fn her_overlay_overrides_the_home_field_by_field_and_says_where_each_value_comes_from() {
    let world = World::new();

    world
        .write_home(&document(json!({
            "project02": {
                "userDisplayName": "Robin",
                "contextWindowTokens": 8192,
                "nvidiaApiKey": "nvapi-home",
            },
            "plugins": {"demo-config": {"enabled": false, "config": {"tone": "warm", "signoff": "-R"}}},
        })))
        .write_overlay(
            "mira",
            &document(json!({
                "project02": {"userDisplayName": "Sam"},
                "plugins": {"demo-config": {"enabled": true, "config": {"tone": "formal"}}},
            })),
        );

    let view = world.view(&of("mira"));
    let demo = section(&view, "plugins", "demo-config").unwrap();
    let provenance = |field: &serde_json::Value| {
        (
            field["effectiveSource"].clone(),
            field["effective"]["value"].clone(),
        )
    };

    assert_eq!(
        provenance(host_field(&view, "userDisplayName")),
        (json!("character"), json!("Sam"))
    );
    assert_eq!(
        provenance(host_field(&view, "contextWindowTokens")),
        (json!("global"), json!(8192))
    );
    assert_eq!(
        host_field(&view, "userDisplayName")["authored"],
        json!({"configured": true, "value": "Sam"})
    );
    assert_eq!(
        host_field(&view, "contextWindowTokens")["authored"],
        json!({"configured": false})
    );
    assert_eq!(
        (
            &demo["enabled"],
            &demo["enabledSource"],
            &demo["activation"]["status"]
        ),
        (&json!(true), &json!("character"), &json!("active"))
    );
    assert_eq!(
        provenance(field(demo, "tone").unwrap()),
        (json!("character"), json!("formal"))
    );
    assert_eq!(
        provenance(field(demo, "signoff").unwrap()),
        (json!("global"), json!("-R"))
    );

    let settings = world.resolve(&of("mira")).settings();
    let demo_values: Vec<_> = settings
        .plugins()
        .filter(|(id, _)| id.as_str() == "demo-config")
        .map(|(_, values)| values.clone())
        .collect();

    assert_eq!(
        settings.host().nvidia_api_key.as_deref(),
        Some("nvapi-home")
    );
    assert_eq!(
        demo_values,
        [json!({"tone": "formal", "signoff": "-R"})
            .as_object()
            .unwrap()
            .clone()]
    );
}

#[test]
fn a_declared_default_sits_beneath_both_documents() {
    let world = World::new();
    let context_window = |world: &World| {
        let view = world.view(&of("mira"));
        let field = host_field(&view, "contextWindowTokens");

        (
            field["effectiveSource"].clone(),
            field["effective"]["value"].clone(),
        )
    };

    assert_eq!(context_window(&world), (json!("default"), json!(32768)));

    world.write_home(&document(
        json!({"project02": {"contextWindowTokens": 8192}}),
    ));
    assert_eq!(context_window(&world), (json!("global"), json!(8192)));

    world.write_overlay(
        "mira",
        &document(json!({"project02": {"contextWindowTokens": 4096}})),
    );
    assert_eq!(context_window(&world), (json!("character"), json!(4096)));
}

#[test]
fn a_value_held_outside_its_scope_warns_at_its_path_and_never_takes_effect() {
    let world = World::new();

    world
        .package("zeta", &json!({}), "1.0.0")
        .write_home(&document(json!({
            "plugins": {"character-state": {"enabled": true}},
            "connectors": {"telegram": {"config": {"botToken": "111111:home"}}},
        })))
        .write_overlay(
            "mira",
            &document(json!({
                "connectors": {"telegram": {"config": {"managementBotToken": "222222:mira"}}},
            })),
        );

    let outside = |view: &serde_json::Value| -> Vec<String> {
        findings(&view["diagnostics"])
            .into_iter()
            .filter(|(code, _)| code == Code::AuthoredOutsideScope.as_str())
            .map(|(_, path)| path)
            .collect()
    };
    let zeta = world.view(&of("zeta"));

    assert_eq!(
        outside(&world.view(&home())),
        [
            "plugins.character-state.enabled",
            "connectors.telegram.config.botToken"
        ]
    );
    assert_eq!(
        outside(&world.view(&of("mira"))),
        [
            "plugins.character-state.enabled",
            "connectors.telegram.config.botToken",
            "connectors.telegram.config.managementBotToken",
        ]
    );
    assert_eq!(
        section(&zeta, "plugins", "character-state").unwrap()["activation"]["status"],
        "disabled"
    );
    assert_eq!(
        world.connector("telegram")["characters"],
        json!([
            {
                "characterId": "mira",
                "activation": {"enabled": true, "status": "active", "reasons": ["built_in_connector", "enabled_by_default"]},
                "values": {"mirror": true, "pairedUsers": {}},
            },
            {
                "characterId": "zeta",
                "activation": {"enabled": true, "status": "active", "reasons": ["built_in_connector", "enabled_by_default"]},
                "values": {"mirror": true, "pairedUsers": {}},
            },
        ])
    );
}

#[test]
fn a_section_this_build_lacks_warns_for_its_id_unless_the_nearest_switch_turns_it_off() {
    let world = World::new();

    world
        .write_home(&document(json!({
            "plugins": {"ghost": {"enabled": true}, "spirit": {"enabled": false}},
            "connectors": {"discord": {}},
        })))
        .write_overlay(
            "mira",
            &document(json!({"plugins": {"ghost": {"enabled": false}}})),
        );

    let unknown = |view: &serde_json::Value| findings(&view["diagnostics"]);

    assert_eq!(
        unknown(&world.view(&home())),
        [
            (
                "runtime_config_unknown_plugin".to_owned(),
                "plugins.ghost".to_owned()
            ),
            (
                "runtime_config_unknown_connector".to_owned(),
                "connectors.discord".to_owned()
            ),
        ]
    );
    assert_eq!(
        unknown(&world.view(&of("mira"))),
        [(
            "runtime_config_unknown_connector".to_owned(),
            "connectors.discord".to_owned()
        )]
    );
}

#[test]
fn the_settings_of_a_section_switched_off_are_never_judged() {
    let world = World::new();
    let misspelled = json!({"enabled": false, "config": {"nope": 1, "tone": "shouty"}});

    world.write_home(&document(json!({"plugins": {"demo-config": misspelled}})));

    assert_eq!(world.view(&home())["diagnostics"], json!([]));
    assert_eq!(
        section(&world.view(&home()), "plugins", "demo-config").unwrap()["activation"]["status"],
        "disabled"
    );

    world.write_overlay(
        "mira",
        &document(json!({"plugins": {"demo-config": {"enabled": true}}})),
    );

    assert_eq!(
        findings(&world.view(&of("mira"))["diagnostics"]),
        [
            (
                "runtime_config_unknown_plugin_config_field".to_owned(),
                "plugins.demo-config.config.nope".to_owned()
            ),
            (
                "runtime_config_value_type_invalid".to_owned(),
                "plugins.demo-config.config.tone".to_owned()
            ),
        ]
    );
}

#[test]
fn a_memory_provider_the_settings_do_not_choose_is_never_judged() {
    let world = World::new();
    let mem0 = json!({"enabled": true, "config": {"backend": "cloud"}});

    world.write_home(&document(json!({
        "project02": {"defaultMemoryProvider": "another"},
        "plugins": {"mem0": mem0},
    })));
    assert_eq!(world.view(&home())["diagnostics"], json!([]));

    world.write_home(&document(json!({
        "project02": {"defaultMemoryProvider": "mem0"},
        "plugins": {"mem0": mem0},
    })));
    assert_eq!(
        findings(&world.view(&home())["diagnostics"]),
        [(
            "runtime_config_value_type_invalid".to_owned(),
            "plugins.mem0.config.backend".to_owned()
        )]
    );
}

#[test]
fn a_plugin_and_a_connector_sharing_an_id_never_meet() {
    let mut declared = plugins();

    declared.push(manifest(
        "telegram",
        "context_provider",
        "global_with_character_overrides",
        true,
        &json!([{
            "name": "mirror", "description": "Not the connector's.", "required": false,
            "secret": false, "valueType": "string", "redactionLabels": [],
        }]),
    ));

    let world = World::with_plugins(declared);

    world.write_home(&document(json!({
        "plugins": {"telegram": {"config": {"mirror": "plain text"}}},
        "connectors": {"telegram": {"config": {"mirror": "not a boolean"}}},
    })));

    let view = world.view(&home());
    let plugin = section(&view, "plugins", "telegram").unwrap();
    let connector = section(&view, "connectors", "telegram").unwrap();

    assert_eq!(plugin["activation"]["status"], "active");
    assert_eq!(
        field(plugin, "mirror").unwrap()["effective"]["value"],
        "plain text"
    );
    assert_eq!(connector["activation"]["status"], "blocked");
    assert_eq!(
        findings(&view["diagnostics"]),
        [(
            "runtime_config_value_type_invalid".to_owned(),
            "connectors.telegram.config.mirror".to_owned()
        )]
    );
}

#[test]
fn what_she_runs_on_changes_only_with_her_own_values_and_the_plugins_she_runs() {
    let world = World::new();

    world
        .write_home(&document(
            json!({"project02": {"nvidiaApiKey": "nvapi-first"}}),
        ))
        .write_overlay(
            "mira",
            &document(json!({"project02": {"userDisplayName": "Sam"}})),
        );

    let settings = || world.resolve(&of("mira")).settings();
    let before = settings();

    for unchanged in [
        document(json!({"project02": {"nvidiaApiKey": "nvapi-first", "userDisplayName": "Robin"}})),
        document(json!({
            "project02": {"nvidiaApiKey": "nvapi-first"},
            "plugins": {"demo-config": {"config": {"tone": "warm"}}},
        })),
        document(json!({
            "project02": {"nvidiaApiKey": "nvapi-first"},
            "connectors": {"telegram": {"config": {"mirror": false}}},
        })),
    ] {
        world.write_home(&unchanged);
        assert_eq!(settings(), before, "{unchanged}");
    }

    world.write_home(&document(
        json!({"project02": {"nvidiaApiKey": "nvapi-second"}}),
    ));
    assert_ne!(settings(), before);

    world
        .write_home(&document(
            json!({"project02": {"nvidiaApiKey": "nvapi-first"}}),
        ))
        .write_overlay(
            "mira",
            &document(json!({"project02": {"userDisplayName": "Robin"}})),
        );
    assert_ne!(settings(), before);
}
