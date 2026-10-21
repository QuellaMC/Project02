//! A character's package's settings, merged into her overlay as she
//! starts.

use p02_config::{Code, MaterializeError, Resolution, materialize};
use p02_store::CharacterData;
use serde_json::{Value, json};

use crate::support::{WAIT, World, document, id, of, section, tree};

fn overlay_of(world: &World, character: &str) -> Value {
    serde_json::from_slice(&std::fs::read(world.overlay(character)).unwrap()).unwrap()
}

fn start(world: &World, character: &str) -> Result<CharacterData, MaterializeError> {
    materialize(
        &world.home,
        &world.sections,
        &world.character(character),
        WAIT,
    )
}

#[test]
fn her_first_start_writes_only_her_packages_settings_for_the_plugins_this_build_has() {
    let world = World::new();

    world
        .write_home(&document(
            json!({"plugins": {"demo-config": {"enabled": false}}}),
        ))
        .package(
            "nova",
            &json!({
                "required": ["demo-config", "ghost"],
                "config": {"demo-config": {"tone": "warm"}, "ghost": {"apiKey": "sk-shipped"}},
            }),
            "1.0.0",
        );

    let data = start(&world, "nova").unwrap();

    assert_eq!(
        data.package_version()
            .map(p02_characters::CharacterVersion::as_str),
        Some("1.0.0")
    );
    assert_eq!(
        overlay_of(&world, "nova"),
        document(json!({
            "plugins": {"demo-config": {"enabled": true, "config": {"tone": "warm"}}},
        }))
    );
    assert_eq!(
        section(&world.view(&of("nova")), "plugins", "demo-config").unwrap()["activation"]["status"],
        "active"
    );

    start(&world, "mira").unwrap();

    assert_eq!(
        overlay_of(&world, "mira"),
        document(json!({"plugins": {"character-state": {"enabled": true}}}))
    );
}

#[test]
fn a_new_version_of_her_package_fills_in_only_what_her_overlay_lacks() {
    let world = World::new();
    let package = |config: Value, version: &str| {
        world.package(
            "nova",
            &json!({"recommended": ["demo-config"], "config": {"demo-config": config}}),
            version,
        );
    };

    package(json!({"tone": "warm"}), "1.0.0");
    start(&world, "nova").unwrap();
    world.save(
        &of("nova"),
        json!({
            "kind": "section_field_set", "namespace": "plugins", "id": "demo-config",
            "field": "tone", "value": "playful",
        }),
    );
    world.save(
        &of("nova"),
        json!({"kind": "section_enabled", "namespace": "plugins", "id": "demo-config"}),
    );

    let edited = std::fs::read(world.overlay("nova")).unwrap();

    package(json!({"tone": "formal", "signoff": "Same."}), "1.0.0");
    start(&world, "nova").unwrap();
    assert_eq!(std::fs::read(world.overlay("nova")).unwrap(), edited);

    package(json!({"tone": "formal", "signoff": "Upgraded."}), "2.0.0");

    let data = start(&world, "nova").unwrap();

    assert_eq!(
        data.package_version()
            .map(p02_characters::CharacterVersion::as_str),
        Some("2.0.0")
    );
    assert_eq!(
        overlay_of(&world, "nova"),
        document(json!({
            "plugins": {
                "demo-config": {"config": {"tone": "playful", "signoff": "Upgraded."}, "enabled": true},
            },
        }))
    );
}

#[test]
fn a_change_on_her_screen_before_she_starts_is_made_in_her_settings_as_her_start_merges_them() {
    let world = World::new();
    let demo = |kind: &str| json!({"kind": kind, "namespace": "plugins", "id": "demo-config"});
    let mut tone = demo("section_field_unset");

    tone["field"] = json!("tone");
    world
        .package(
            "nova",
            &json!({
                "recommended": ["demo-config"],
                "config": {"demo-config": {"tone": "warm", "signoff": "Yours."}},
            }),
            "1.0.0",
        )
        .save(&of("nova"), tone)
        .save(&of("nova"), demo("section_enabled"));

    let data = start(&world, "nova").unwrap();

    assert_eq!(
        data.package_version()
            .map(p02_characters::CharacterVersion::as_str),
        Some("1.0.0")
    );
    assert_eq!(
        overlay_of(&world, "nova"),
        document(json!({"plugins": {"demo-config": {"config": {"signoff": "Yours."}}}}))
    );
}

#[test]
fn an_overlay_value_that_is_no_object_is_left_for_its_diagnostic_to_name() {
    let world = World::new();
    let hers = document(json!({"plugins": {"demo-config": {"enabled": true, "config": "warm"}}}));

    world
        .package(
            "nova",
            &json!({"config": {"demo-config": {"tone": "warm"}}}),
            "1.0.0",
        )
        .write_overlay("nova", &hers);

    start(&world, "nova").unwrap();

    assert_eq!(overlay_of(&world, "nova"), hers);

    let resolution =
        Resolution::character(&world.home, &world.sections, &world.character("nova")).unwrap();
    let named: Vec<_> = resolution
        .diagnostics()
        .iter()
        .map(|diagnostic| {
            (
                diagnostic.code(),
                diagnostic.path(),
                diagnostic.message().to_owned(),
            )
        })
        .collect();

    assert_eq!(
        named,
        [(
            Code::PluginConfigNotObject,
            Some("plugins.demo-config.config"),
            "plugins.demo-config.config must be an object.".to_owned()
        )]
    );
}

#[test]
fn a_package_carrying_a_credential_or_a_value_its_field_refuses_is_invalid_and_creates_nothing() {
    for (config, named) in [
        (
            json!({"apiKey": "sk-shipped"}),
            "plugins.demo-config.config.apiKey",
        ),
        (json!({"tone": 42}), "plugins.demo-config.config.tone"),
    ] {
        let world = World::new();

        world.package("nova", &json!({"config": {"demo-config": config}}), "1.0.0");

        let Err(MaterializeError::Package { diagnostics }) = start(&world, "nova") else {
            panic!("{config}");
        };

        assert_eq!(diagnostics.len(), 1, "{config}");
        assert_eq!(
            diagnostics[0].code(),
            Code::CharacterPackagePluginConfigInvalid
        );
        assert_eq!(diagnostics[0].path(), Some(named));
        assert_eq!(
            tree(&world.root().join("character-data")),
            Vec::<String>::new()
        );

        let view = world.view(&of("nova"));

        assert_eq!(view["status"], "ok");
        assert_eq!(
            view["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .map(|diagnostic| diagnostic["code"].clone())
                .collect::<Vec<_>>(),
            [json!("character_package_plugin_config_invalid")]
        );
    }
}

#[test]
fn a_document_that_does_not_load_stops_her_start_with_nothing_written_for_her() {
    let world = World::new();

    world.write_overlay("mira", &json!("not a document"));

    let Err(MaterializeError::Unloadable { diagnostics }) = start(&world, "mira") else {
        panic!("her overlay loads");
    };

    assert_eq!(diagnostics[0].character(), Some(&id("mira")));
    assert_eq!(
        tree(&world.root().join("character-data")),
        ["mira", "mira/config.json"]
    );

    let world = World::new();

    world.write_home(&document(json!({"unknownField": true})));

    assert!(matches!(
        start(&world, "mira"),
        Err(MaterializeError::Unloadable { .. })
    ));
    assert_eq!(
        tree(&world.root().join("character-data")),
        Vec::<String>::new()
    );
}
