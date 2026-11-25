//! The documents as their files hold them: unreadable, or judged.

use std::num::NonZeroU32;

use p02_config::{ReadSettingsError, Resolution, TranslationWord};
use p02_core::LanguageTag;
use p02_wire::{Code, RoleModelProvider};
use serde_json::json;

use crate::support::{World, document, home, host_field, of};

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

/// Her own service and model are hers, as every host value of hers is,
/// while the home's key reaches her and the home keeps its own. Her
/// translator's are the home's, put in place of her service and its model.
#[test]
fn a_hand_written_document_keeps_every_value_its_fields_take() {
    let world = World::new();

    world
        .write_home(&document(json!({
            "project02": {
                "userDisplayName": "  Robin  ",
                "userLanguage": "de",
                "roleModelProvider": "nvidia",
                "openaiApiKey": "  sk-as typed  ",
                "nvidiaApiKey": "  nvapi-as typed  ",
                "nvidiaModel": "meta/llama",
                "nvidiaBaseUrl": "https://nim.example.test/v1/",
                "translatorProvider": "anthropic",
                "translatorModel": "claude-haiku-5-5",
                "contextWindowTokens": 4096,
            },
        })))
        .write_overlay(
            "mira",
            &document(json!({"project02": {
                "userLanguage": "ja",
                "enabled": false,
                "heartbeat": "2h",
                "roleModelProvider": "openai",
                "openaiModel": "gpt-5.6-terra",
                "translationWords": [{"hers": "ダーリン", "shown": "Darling"}],
                "translationTone": "Playful and teasing,\nnever formal.",
            }})),
        );

    let settings = world.resolve(&of("mira")).settings();
    let host = settings.host();
    let homes = world.resolve(&home()).settings();
    let translator = host.translator().unwrap();

    assert_eq!(
        [&host.user_language, &homes.host().user_language]
            .map(|tag| tag.as_ref().map(LanguageTag::as_str)),
        [Some("ja"), Some("de")]
    );
    assert_eq!(
        host.translation_words,
        [TranslationWord {
            hers: "ダーリン".to_owned(),
            shown: "Darling".to_owned(),
        }]
    );
    assert_eq!(
        host.translation_tone.as_deref(),
        Some("Playful and teasing,\nnever formal.")
    );
    assert_eq!(
        (
            translator.role_model_provider,
            translator.anthropic_model.as_str(),
            host.role_model_provider,
            host.anthropic_model.as_str(),
        ),
        (
            Some(RoleModelProvider::Anthropic),
            "claude-haiku-5-5",
            Some(RoleModelProvider::Openai),
            "claude-opus-5-5",
        )
    );
    assert_eq!(host.user_display_name.as_str(), "Robin");
    assert_eq!(
        (
            host.role_model_provider,
            host.openai_api_key.as_deref(),
            host.openai_model.as_str()
        ),
        (
            Some(RoleModelProvider::Openai),
            Some("  sk-as typed  "),
            "gpt-5.6-terra"
        )
    );
    assert_eq!(
        (
            homes.host().role_model_provider,
            homes.host().openai_model.as_str()
        ),
        (Some(RoleModelProvider::Nvidia), "gpt-6-luna")
    );
    assert_eq!(host.nvidia_model.as_deref(), Some("meta/llama"));
    assert!(!host.enabled);
    assert_eq!(host.heartbeat, NonZeroU32::new(120));
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
