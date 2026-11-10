//! The settings in effect: each value from the nearest document its scope
//! lets the target read, else its default, and what is wrong with them.

use p02_wire::Code;
use serde_json::json;

use crate::support::{World, document, field, findings, home, manifest, of, plugins, section};

#[test]
fn a_value_held_outside_its_scope_warns_at_its_path_and_never_takes_effect() {
    let world = World::new();

    world
        .package("zeta", &json!({}), "1.0.0")
        .write_home(&document(json!({
            "project02": {"enabled": false},
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
            "project02.enabled",
            "plugins.character-state.enabled",
            "connectors.telegram.config.botToken"
        ]
    );
    assert_eq!(
        outside(&world.view(&of("mira"))),
        [
            "project02.enabled",
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
fn a_section_off_by_its_switch_or_its_default_is_never_judged_and_a_broken_switch_blocks_it() {
    let world = World::new();
    let misspelled = json!({"nope": 1, "backend": "cloud"});
    let memory = |target: &p02_wire::ConfigTarget| {
        let view = world.view(target);

        (
            findings(&view["diagnostics"]),
            section(&view, "plugins", "mem0").unwrap()["activation"]["reasons"].clone(),
        )
    };

    for (stanza, reason) in [
        (json!({"config": misspelled}), "not_enabled"),
        (
            json!({"enabled": false, "config": misspelled}),
            "disabled_by_config",
        ),
    ] {
        world.write_home(&document(json!({"plugins": {"mem0": stanza}})));
        assert_eq!(memory(&home()), (Vec::new(), json!([reason])), "{stanza}");
    }

    world.write_overlay(
        "mira",
        &document(json!({"plugins": {"mem0": {"enabled": true}}})),
    );

    assert_eq!(
        memory(&of("mira")).0,
        [
            (
                "runtime_config_ignored".to_owned(),
                "plugins.mem0.config.nope".to_owned()
            ),
            (
                "runtime_config_value_invalid".to_owned(),
                "plugins.mem0.config.backend".to_owned()
            ),
        ]
    );

    world.write_home(&document(json!({"plugins": {"mem0": {"enabled": "yes"}}})));

    assert_eq!(
        memory(&home()),
        (
            vec![(
                "runtime_config_value_invalid".to_owned(),
                "plugins.mem0.enabled".to_owned()
            )],
            json!(["blocked_by_config_errors"])
        )
    );
    assert_eq!(
        memory(&of("mira")),
        (Vec::new(), json!(["bundled_mem0", "enabled_by_config"]))
    );
}

#[test]
fn a_finding_in_her_overlay_names_her_and_one_in_the_homes_document_no_one() {
    let world = World::new();

    world
        .write_home(&document(json!({
            "plugins": {"mem0": {"enabled": true, "config": {"backend": "cloud"}}, "ghost": {}},
        })))
        .write_overlay(
            "mira",
            &document(json!({
                "plugins": {
                    "reply-style": {"enabled": true, "config": {"tone": "shouty", "nope": 1}},
                    "spirit": {},
                },
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
                "runtime_config_value_invalid",
                "plugins.mem0.config.backend",
                None
            ),
            (
                "runtime_config_ignored",
                "plugins.reply-style.config.nope",
                Some("mira")
            ),
            (
                "runtime_config_value_invalid",
                "plugins.reply-style.config.tone",
                Some("mira")
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

    // A plugin she does not run is none of what she runs on.
    world.write_overlay(
        "mira",
        &document(json!({
            "project02": {"userDisplayName": "Sam"},
            "plugins": {"reply-style": {"config": {"tone": "warm"}}},
        })),
    );
    assert_eq!(settings(), before);

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
