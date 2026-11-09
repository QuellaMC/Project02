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
fn a_section_this_build_lacks_warns_for_its_id_in_each_document_naming_it() {
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
    let warned = |code: &str, path: &str| (code.to_owned(), path.to_owned());

    assert_eq!(
        unknown(&world.view(&home())),
        [
            warned("runtime_config_unknown_plugin", "plugins.ghost"),
            warned("runtime_config_unknown_plugin", "plugins.spirit"),
            warned("runtime_config_unknown_connector", "connectors.discord"),
        ]
    );
    assert_eq!(
        unknown(&world.view(&of("mira"))),
        [
            warned("runtime_config_unknown_plugin", "plugins.ghost"),
            warned("runtime_config_unknown_plugin", "plugins.ghost"),
            warned("runtime_config_unknown_plugin", "plugins.spirit"),
            warned("runtime_config_unknown_connector", "connectors.discord"),
        ]
    );
}

#[test]
fn a_section_off_by_its_switch_or_its_default_is_never_judged_and_a_broken_switch_blocks_it() {
    let world = World::new();
    let misspelled = json!({"nope": 1, "tone": "shouty"});
    let demo = |target: &p02_config::ConfigTarget| {
        let view = world.view(target);

        (
            findings(&view["diagnostics"]),
            section(&view, "plugins", "demo-config").unwrap()["activation"]["reasons"].clone(),
        )
    };

    for (stanza, reason) in [
        (json!({"config": misspelled}), "not_enabled"),
        (
            json!({"enabled": false, "config": misspelled}),
            "disabled_by_config",
        ),
    ] {
        world.write_home(&document(json!({"plugins": {"demo-config": stanza}})));
        assert_eq!(demo(&home()), (Vec::new(), json!([reason])), "{stanza}");
    }

    world.write_overlay(
        "mira",
        &document(json!({"plugins": {"demo-config": {"enabled": true}}})),
    );

    assert_eq!(
        demo(&of("mira")).0,
        [
            (
                "runtime_config_ignored".to_owned(),
                "plugins.demo-config.config.nope".to_owned()
            ),
            (
                "runtime_config_value_invalid".to_owned(),
                "plugins.demo-config.config.tone".to_owned()
            ),
        ]
    );

    world.write_home(&document(
        json!({"plugins": {"demo-config": {"enabled": "yes"}}}),
    ));

    assert_eq!(
        demo(&home()),
        (
            vec![(
                "runtime_config_value_invalid".to_owned(),
                "plugins.demo-config.enabled".to_owned()
            )],
            json!(["blocked_by_config_errors"])
        )
    );
    assert_eq!(
        demo(&of("mira")),
        (
            Vec::new(),
            json!(["bundled_demo-config", "enabled_by_config"])
        )
    );
}

#[test]
fn a_memory_provider_the_settings_do_not_choose_never_runs_and_is_never_judged() {
    let world = World::new();
    let mem0 = json!({"enabled": true, "config": {"backend": "cloud"}});

    world.write_home(&document(json!({
        "project02": {"defaultMemoryProvider": "another"},
        "plugins": {"mem0": mem0},
    })));

    let view = world.view(&home());

    assert_eq!(view["diagnostics"], json!([]));
    assert_eq!(
        section(&view, "plugins", "mem0").unwrap()["activation"],
        json!({
            "enabled": false,
            "status": "disabled",
            "reasons": ["not_selected_as_default_memory_provider"],
        })
    );
    assert!(
        world
            .resolve(&of("mira"))
            .settings()
            .plugins()
            .all(|(id, _)| id.as_str() != "mem0")
    );

    world.write_home(&document(json!({
        "project02": {"defaultMemoryProvider": "mem0"},
        "plugins": {"mem0": mem0},
    })));
    assert_eq!(
        findings(&world.view(&home())["diagnostics"]),
        [(
            "runtime_config_value_invalid".to_owned(),
            "plugins.mem0.config.backend".to_owned()
        )]
    );
}

#[test]
fn a_finding_in_her_overlay_names_her_and_one_in_the_homes_document_no_one() {
    let world = World::new();

    world
        .write_home(&document(json!({
            "plugins": {"demo-config": {"enabled": true, "config": {"signoff": 1}}, "ghost": {}},
        })))
        .write_overlay(
            "mira",
            &document(json!({
                "plugins": {"demo-config": {"config": {"tone": "shouty", "nope": 1}}, "spirit": {}},
            })),
        );

    let resolution = world.resolve(&of("mira"));
    let found: Vec<(&str, &str, Option<&str>)> = resolution
        .diagnostics()
        .iter()
        .map(|diagnostic| {
            (
                diagnostic.code().as_str(),
                diagnostic.path().unwrap_or(""),
                diagnostic.character().map(p02_shared::Identifier::as_str),
            )
        })
        .collect();

    assert_eq!(
        found,
        [
            ("runtime_config_unknown_plugin", "plugins.ghost", None),
            (
                "runtime_config_unknown_plugin",
                "plugins.spirit",
                Some("mira")
            ),
            (
                "runtime_config_ignored",
                "plugins.demo-config.config.nope",
                Some("mira")
            ),
            (
                "runtime_config_value_invalid",
                "plugins.demo-config.config.tone",
                Some("mira")
            ),
            (
                "runtime_config_value_invalid",
                "plugins.demo-config.config.signoff",
                None
            ),
        ]
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
            "name": "mirror", "description": "Not the connector's.", "secret": false,
            "valueType": "string", "redactionLabels": [],
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
            "runtime_config_value_invalid".to_owned(),
            "connectors.telegram.config.mirror".to_owned()
        )]
    );
}

#[test]
fn what_she_runs_on_changes_only_with_her_own_values_and_the_plugins_she_runs() {
    let world = World::new();
    let key = |key: &str| json!({"nvidiaApiKey": key});
    let mem0 = json!({"enabled": true});

    world
        .write_home(&document(
            json!({"project02": key("nvapi-first"), "plugins": {"mem0": mem0}}),
        ))
        .write_overlay(
            "mira",
            &document(json!({"project02": {"userDisplayName": "Sam"}})),
        );

    let settings = || world.resolve(&of("mira")).settings();
    let before = settings();

    for unchanged in [
        document(json!({
            "project02": {"nvidiaApiKey": "nvapi-first", "userDisplayName": "Robin"},
            "plugins": {"mem0": mem0},
        })),
        document(json!({
            "project02": key("nvapi-first"),
            "plugins": {"mem0": mem0, "demo-config": {"config": {"tone": "warm"}}},
        })),
        document(json!({
            "project02": key("nvapi-first"),
            "plugins": {"mem0": mem0},
            "connectors": {"telegram": {"config": {"mirror": false}}},
        })),
        document(json!({
            "project02": key("nvapi-first"),
            "plugins": {"mem0": {"enabled": true, "config": {"backend": "platform"}}},
        })),
    ] {
        world.write_home(&unchanged);
        assert_eq!(settings(), before, "{unchanged}");
    }

    world.write_home(&document(
        json!({"project02": key("nvapi-second"), "plugins": {"mem0": mem0}}),
    ));
    assert_ne!(settings(), before);

    world
        .write_home(&document(
            json!({"project02": key("nvapi-first"), "plugins": {"mem0": mem0}}),
        ))
        .write_overlay(
            "mira",
            &document(json!({"project02": {"userDisplayName": "Robin"}})),
        );
    assert_ne!(settings(), before);
}
