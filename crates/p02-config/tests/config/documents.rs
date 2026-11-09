//! The documents as their files hold them: absent, unreadable, or judged.

use p02_config::{Code, ReadSettingsError, Resolution, RoleModelProvider};
use serde_json::{Value, json};

use crate::support::{World, document, home, host_field, of};

#[test]
fn a_home_without_settings_has_no_findings_and_shows_each_default() {
    let world = World::new();
    let view = world.view(&home());

    assert_eq!(view["status"], "ok");
    assert_eq!(view["diagnostics"], json!([]));

    let fields: Vec<(Value, Value, Value)> = view["project02"]
        .as_array()
        .unwrap()
        .iter()
        .map(|field| {
            (
                field["name"].clone(),
                field["effective"]["source"].clone(),
                field["effective"]
                    .get("value")
                    .cloned()
                    .unwrap_or(Value::Null),
            )
        })
        .collect();

    assert_eq!(
        fields,
        [
            (json!("userDisplayName"), json!("default"), json!("You")),
            (json!("roleModelProvider"), json!("missing"), Value::Null),
            (json!("nvidiaApiKey"), json!("missing"), Value::Null),
            (json!("nvidiaModel"), json!("missing"), Value::Null),
            (json!("nvidiaBaseUrl"), json!("missing"), Value::Null),
            (json!("contextWindowTokens"), json!("default"), json!(32768)),
            (
                json!("defaultMemoryProvider"),
                json!("missing"),
                Value::Null
            ),
            (json!("enabled"), json!("default"), json!(true)),
        ]
    );

    let settings = world.resolve(&of("mira")).settings();

    assert_eq!(settings.host().role_model_provider, None);
    assert!(settings.host().enabled);
}

#[test]
fn a_document_that_is_no_json_object_refuses_its_targets_and_one_of_hers_names_her() {
    for content in ["{not json", "[]"] {
        let world = World::new();

        std::fs::write(world.home_document(), content).unwrap();

        let Err(ReadSettingsError::Unreadable(diagnostic)) =
            Resolution::home(&world.home, &world.sections)
        else {
            panic!("{content}");
        };

        assert_eq!(diagnostic.code(), Code::Unreadable);
        assert_eq!(
            world.view(&home())["reason"],
            "config_unloadable",
            "{content}"
        );
        assert_eq!(
            world.view(&of("mira"))["reason"],
            "config_unloadable",
            "{content}"
        );
    }

    let world = World::new();

    world.write_overlay("mira", &json!("not a document"));

    let Err(ReadSettingsError::Unreadable(diagnostic)) =
        Resolution::character(&world.home, &world.sections, &world.character("mira"))
    else {
        panic!("her overlay reads");
    };

    assert_eq!(
        diagnostic.character().map(p02_shared::Identifier::as_str),
        Some("mira")
    );
    assert_eq!(world.resolve(&home()).diagnostics(), []);
}

#[test]
fn what_a_document_holds_that_the_settings_do_not_know_is_not_used_and_said() {
    let world = World::new();

    world.write_home(&json!({
        "version": "project02.config.v1",
        "storeRoot": "/elsewhere",
        "project02": {"storeRoot": "/elsewhere", "userDisplayName": "Robin"},
        "plugins": [],
    }));

    let resolution = world.resolve(&of("mira"));
    let found: Vec<(Code, Option<&str>)> = resolution
        .diagnostics()
        .iter()
        .map(|diagnostic| (diagnostic.code(), diagnostic.path()))
        .collect();

    assert_eq!(
        found,
        [
            (Code::Ignored, Some("storeRoot")),
            (Code::Ignored, Some("project02.storeRoot")),
            (Code::Ignored, Some("plugins")),
        ]
    );
    assert_eq!(resolution.stopping().count(), 0);
    assert_eq!(
        resolution.settings().host().user_display_name.as_str(),
        "Robin"
    );
}

#[test]
fn a_hand_written_document_keeps_every_value_its_fields_take() {
    let world = World::new();

    world.write_home(&document(json!({
        "project02": {
            "userDisplayName": "  Robin  ",
            "roleModelProvider": "nvidia",
            "nvidiaApiKey": "  nvapi-as typed  ",
            "nvidiaModel": "meta/llama",
            "nvidiaBaseUrl": "https://nim.example.test/v1/",
            "contextWindowTokens": 4096,
            "defaultMemoryProvider": "mem0",
            "enabled": false,
        },
    })));

    let settings = world.resolve(&of("mira")).settings();
    let host = settings.host();

    assert_eq!(host.user_display_name.as_str(), "Robin");
    assert_eq!(host.role_model_provider, Some(RoleModelProvider::Nvidia));
    assert_eq!(host.nvidia_model.as_deref(), Some("meta/llama"));
    assert_eq!(host.default_memory_provider.as_deref(), Some("mem0"));
    assert!(!host.enabled);
    assert_eq!(host.context_window_tokens.get(), 4096);
    assert_eq!(
        host.nvidia_base_url
            .as_ref()
            .map(p02_shared::BaseUrl::as_str),
        Some("https://nim.example.test/v1")
    );
    assert_eq!(host.nvidia_api_key.as_deref(), Some("  nvapi-as typed  "));
    assert_eq!(
        host_field(&world.view(&home()), "userDisplayName")["effective"]["value"],
        "  Robin  "
    );
}
