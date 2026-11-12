//! The settings as a settings screen, a connector and `inspect` are shown
//! them.

use p02_config::connector_config_view;
use p02_wire::{ConfigChange, PlanAccount};
use serde_json::{Value, json};

use crate::support::{World, document, field, findings, home, host_field, of, section};

fn sections_of(view: &Value) -> Vec<String> {
    view["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|section| {
            format!(
                "{}.{}",
                section["namespace"].as_str().unwrap(),
                section["id"].as_str().unwrap()
            )
        })
        .collect()
}

#[test]
fn her_view_shows_the_homes_values_in_effect_her_own_as_authored_and_her_packages_before_she_starts()
 {
    let world = World::new();

    world
        .write_home(&document(
            json!({"project02": {"userDisplayName": "Robin"}}),
        ))
        .write_overlay(
            "mira",
            &document(json!({"project02": {"enabled": false, "contextWindowTokens": 4096}})),
        );

    let view = world.view(&of("mira"));
    let shown = |name: &str| {
        let field = host_field(&view, name);

        (
            field["authored"].clone(),
            field["effectiveSource"].clone(),
            field["effective"]["value"].clone(),
        )
    };
    let state = section(&view, "plugins", "character-state").unwrap();

    assert_eq!(
        shown("userDisplayName"),
        (
            json!({"configured": false}),
            json!("global"),
            json!("Robin")
        )
    );
    assert_eq!(
        shown("contextWindowTokens"),
        (
            json!({"configured": true, "value": 4096}),
            json!("character"),
            json!(4096)
        )
    );
    assert_ne!(view["fingerprint"], world.view(&home())["fingerprint"]);
    assert_eq!(
        (&state["enabled"], &state["activation"]["status"]),
        (&json!(true), &json!("active"))
    );
    assert!(sections_of(&view).contains(&"plugins.character-state".to_owned()));
}

#[test]
fn a_view_draws_only_what_its_target_may_set_in_the_cards_and_words_its_declaration_gives() {
    let world = World::new();
    let home_view = world.view(&home());
    let mira_view = world.view(&of("mira"));
    let memory = section(&home_view, "plugins", "mem0").unwrap();
    let hers = section(&mira_view, "plugins", "mem0").unwrap();
    let backend = field(memory, "backend").unwrap();
    let platform = json!({"field": "backend", "is": ["platform"]});
    let telegram = |view| section(view, "connectors", "telegram").unwrap();

    assert_eq!(
        memory["page"],
        json!({
            "summary": "Remembers across all chats",
            "icon": "archive",
            "tint": "brown",
            "placement": "mind_body",
            "order": 3,
            "connection": "Memory",
        })
    );
    assert_eq!(memory["access"], json!({"model_input": "write"}));
    assert_eq!(
        json!([backend["label"], backend["choices"]]),
        json!(["Kept At", {"platform": "Mem0 Cloud", "server": "Your Server", "oss": "This Computer"}])
    );
    assert_eq!(field(memory, "apiKey").unwrap()["placeholder"], "Paste key");
    assert_eq!(
        memory["layout"],
        json!([
            {"advanced": false, "rows": [{"field": "backend"}]},
            {
                "footer": "Get a key at app.mem0.ai.",
                "advanced": false,
                "when": platform,
                "rows": [{"field": "apiKey"}],
            },
            {
                "title": "Advanced",
                "advanced": true,
                "rows": [{"field": "baseUrl", "when": platform}],
            },
        ])
    );
    // She switches her memory and sets none of it: the account is the home's.
    assert_eq!(
        json!([hers["page"], hers["fields"], hers["layout"]]),
        json!([memory["page"], [], []])
    );
    assert_eq!(
        telegram(&mira_view)["layout"],
        json!([{"advanced": false, "rows": [{"field": "botToken"}]}])
    );
    assert_eq!(
        json!([
            telegram(&home_view).get("page"),
            telegram(&home_view).get("access")
        ]),
        json!([null, null])
    );
    assert_eq!(host_field(&home_view, "userDisplayName")["label"], "Name");
}

/// A page lists the services from the view alone: each one's name, what it
/// is and where its key comes from, its own fields and its model's among
/// them, connected while a credential of it is in effect for the target, a
/// server of the person's own among NVIDIA's; and the OpenAI model offers
/// its models, the default in effect until one is chosen.
#[test]
fn a_view_lists_every_service_each_connected_by_a_credential_in_effect_for_its_target() {
    let world = World::new();

    world
        .write_home(&document(json!({"project02": {"openaiApiKey": "sk-home"}})))
        .write_overlay(
            "mira",
            &document(json!({"project02": {"nvidiaBaseUrl": "http://localhost:1234/v1"}})),
        );

    let home_view = world.view(&home());
    let connected = |view: &Value| -> Vec<Value> {
        view["services"]
            .as_array()
            .unwrap()
            .iter()
            .map(|service| json!([service["id"], service["connected"]]))
            .collect()
    };
    let model = host_field(&home_view, "openaiModel");

    assert_eq!(
        home_view["services"],
        json!([
            {
                "id": "chatgpt",
                "name": "ChatGPT Plan",
                "summary": "Sign in with the plan you already pay for",
                "connected": false,
                "model": "chatgptModel",
                "fields": ["chatgptModel"],
            },
            {
                "id": "openai",
                "name": "OpenAI API",
                "summary": "Pay as you go, with an API key",
                "keyFrom": "Get one at platform.openai.com.",
                "connected": true,
                "model": "openaiModel",
                "fields": ["openaiApiKey", "openaiModel"],
            },
            {
                "id": "anthropic",
                "name": "Claude API",
                "summary": "Pay as you go, with an API key",
                "keyFrom": "Get one in the Claude Console.",
                "connected": false,
                "model": "anthropicModel",
                "fields": ["anthropicApiKey", "anthropicModel"],
            },
            {
                "id": "nvidia",
                "name": "NVIDIA",
                "summary": "An API key, or a server of your own",
                "keyFrom": "Get one at build.nvidia.com.",
                "connected": false,
                "model": "nvidiaModel",
                "fields": ["nvidiaApiKey", "nvidiaModel", "nvidiaBaseUrl"],
            },
        ])
    );
    assert_eq!(
        connected(&world.view(&of("mira"))),
        [
            json!(["chatgpt", false]),
            json!(["openai", true]),
            json!(["anthropic", false]),
            json!(["nvidia", true])
        ]
    );
    assert_eq!(
        json!([
            model["suggestedValues"],
            model["choices"],
            model["effective"]["source"],
            model["effective"]["value"],
            host_field(&home_view, "roleModelProvider")["allowedValues"],
        ]),
        json!([
            ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"],
            {
                "gpt-6-astra": "GPT-6 Astra",
                "gpt-6.1-sol": "GPT-6.1 Sol",
                "gpt-6.1-terra": "GPT-6.1 Terra",
                "gpt-6-luna": "GPT-6 Luna",
            },
            "default",
            "gpt-6-luna",
            ["chatgpt", "openai", "anthropic", "nvidia"],
        ])
    );
}

/// The ChatGPT plan is connected while the home is signed in, which no
/// document says, and then says as whom. Its model offers what the plan
/// offers, every model to a paid plan and those of the free plan to a
/// free one or one OpenAI does not name, each in its words; the first of
/// them is in effect until one is set, and one set is in effect whatever
/// the plan.
#[test]
fn the_chatgpt_plan_is_connected_while_signed_in_and_its_model_offers_what_the_plan_offers() {
    let world = World::new();
    let account = |plan: Option<&str>| PlanAccount {
        email: Some("sam@example.com".to_owned()),
        plan: plan.map(str::to_owned),
    };
    let offered = |view: &Value| {
        let model = host_field(view, "chatgptModel");

        json!([
            view["services"][0]["connected"],
            view["services"][0]["account"],
            model["suggestedValues"],
            model["effective"]["source"],
            model["effective"]["value"],
        ])
    };
    let every = json!([
        "gpt-6.1-sol",
        "gpt-6-sol",
        "gpt-6.1-terra",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
    ]);
    let free = json!([
        "gpt-6.1-terra",
        "gpt-6-luna",
        "gpt-5.6-terra",
        "gpt-5.6-luna"
    ]);

    assert_eq!(
        offered(&world.signed_in_view(&home(), Some(&account(Some("plus"))))),
        json!([
            true,
            {"email": "sam@example.com", "plan": "plus"},
            every,
            "default",
            "gpt-6.1-sol",
        ])
    );
    assert_eq!(
        host_field(
            &world.signed_in_view(&home(), Some(&account(Some("free")))),
            "chatgptModel"
        )["choices"],
        json!({
            "gpt-6.1-terra": "GPT-6.1 Terra",
            "gpt-6-luna": "GPT-6 Luna",
            "gpt-5.6-terra": "GPT-5.6 Terra",
            "gpt-5.6-luna": "GPT-5.6 Luna",
        })
    );
    assert_eq!(
        offered(&world.signed_in_view(&home(), Some(&account(None)))),
        json!([true, {"email": "sam@example.com"}, free, "default", "gpt-6.1-terra"])
    );
    assert_eq!(
        offered(&world.view(&home())),
        json!([false, null, free, "default", "gpt-6.1-terra"])
    );

    world.write_home(&document(
        json!({"project02": {"chatgptModel": "gpt-6-luna"}}),
    ));

    assert_eq!(
        offered(&world.signed_in_view(&of("mira"), Some(&account(Some("pro"))))),
        json!([
            true,
            {"email": "sam@example.com", "plan": "pro"},
            every,
            "config",
            "gpt-6-luna",
        ])
    );
}

#[test]
fn no_secret_reaches_a_view_a_report_or_a_debug_rendering_but_as_redacted() {
    let secrets = [
        "nvapi-home-secret",
        "sk-home-secret",
        "sk-ant-home-secret",
        "mem0-key-secret",
        "123456:management-secret",
        "111111:misplaced-secret",
        "987654:mira-secret",
        "paired-key-secret",
        "paired-token-secret",
        "paired-access-secret",
        "paired-dotted-secret",
    ];
    let world = World::new();

    world
        .write_home(&document(json!({
            "project02": {
                "nvidiaApiKey": "nvapi-home-secret",
                "openaiApiKey": "sk-home-secret",
                "anthropicApiKey": "sk-ant-home-secret",
            },
            "plugins": {"mem0": {"config": {"apiKey": "mem0-key-secret"}}},
            "connectors": {"telegram": {"config": {
                "managementBotToken": "123456:management-secret",
                "botToken": "111111:misplaced-secret",
                "pairedUsers": {
                    "381940562": "Alice (@alice)",
                    "apiKey": "paired-key-secret",
                    "token": "paired-token-secret",
                    "nested": {"access_token": "paired-access-secret", "label": "kept"},
                    "api.key": "paired-dotted-secret",
                },
            }}},
        })))
        .write_overlay(
            "mira",
            &document(
                json!({"connectors": {"telegram": {"config": {"botToken": "987654:mira-secret"}}}}),
            ),
        );

    let home_view = world.view(&home());
    let mira_view = world.view(&of("mira"));
    let report = serde_json::to_value(world.resolve(&of("mira")).report(&world.home)).unwrap();
    let telegram = section(&home_view, "connectors", "telegram").unwrap();

    for key in ["nvidiaApiKey", "openaiApiKey", "anthropicApiKey"] {
        assert_eq!(
            host_field(&home_view, key)["effective"]["value"],
            "[redacted]"
        );
        assert_eq!(report["runtimeConfig"]["project02"][key], "[redacted]");
    }

    assert_eq!(
        field(section(&home_view, "plugins", "mem0").unwrap(), "apiKey").unwrap()["authored"]["value"],
        "[redacted]"
    );
    assert_eq!(
        field(telegram, "managementBotToken").unwrap()["authored"]["value"],
        "[redacted]"
    );
    assert_eq!(
        field(telegram, "pairedUsers").unwrap()["authored"]["value"],
        json!({
            "381940562": "Alice (@alice)",
            "apiKey": "[redacted]",
            "token": "[redacted]",
            "nested": {"access_token": "[redacted]", "label": "kept"},
            "api.key": "[redacted]",
        })
    );
    assert_eq!(
        field(
            section(&mira_view, "connectors", "telegram").unwrap(),
            "botToken"
        )
        .unwrap()["authored"]["value"],
        "[redacted]"
    );

    let change: ConfigChange = serde_json::from_value(json!({
        "target": {"scope": "global"},
        "expectedFingerprint": home_view["fingerprint"],
        "operation": {"kind": "set", "path": "project02.nvidiaApiKey", "value": "nvapi-home-secret"},
    }))
    .unwrap();
    let shown = [
        home_view.to_string(),
        mira_view.to_string(),
        report.to_string(),
        format!("{:?}", world.resolve(&of("mira"))),
        format!("{:?}", world.resolve(&of("mira")).settings()),
        format!(
            "{:?}",
            connector_config_view(&world.home, &world.sections, &world.discovery(), "telegram")
        ),
        format!("{change:?}"),
    ];

    for text in shown {
        for secret in secrets {
            assert!(!text.contains(secret), "{secret} in {text}");
        }
    }
}

#[test]
fn a_connectors_read_hands_each_entry_its_own_values_secrets_in_the_clear() {
    let world = World::new();

    world
        .package("nova", &json!({}), "1.0.0")
        .package("vega", &json!({}), "1.0.0")
        .package("zeta", &json!({}), "1.0.0")
        .write_home(&document(json!({"connectors": {"telegram": {
            "enabled": false,
            "config": {"managementBotToken": "123456:home", "mirror": false, "botToken": "111111:home"},
        }}})))
        .write_overlay(
            "mira",
            &document(json!({"connectors": {"telegram": {
                "enabled": true,
                "config": {"botToken": "987654:mira"},
            }}})),
        )
        .write_overlay(
            "nova",
            &document(json!({"connectors": {"telegram": {"enabled": true}}})),
        )
        .write_overlay("zeta", &document(json!({"project02": {"enabled": false}})));

    let read = world.connector("telegram");
    let entries: Vec<Value> = read["characters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            json!([
                entry["characterId"],
                entry["activation"]["status"],
                entry["values"]
            ])
        })
        .collect();

    assert_eq!(read["status"], "ok");
    assert_eq!(read["connectorId"], "telegram");
    assert_eq!(
        json!([read["home"]["activation"]["status"], read["home"]["values"]]),
        json!(["disabled", {}])
    );
    assert_eq!(
        entries,
        [
            json!(["mira", "active", {
                "botToken": "987654:mira",
                "managementBotToken": "123456:home",
                "mirror": false,
                "pairedUsers": {},
            }]),
            json!(["nova", "active", {
                "managementBotToken": "123456:home",
                "mirror": false,
                "pairedUsers": {},
            }]),
            json!(["vega", "disabled", {}]),
        ]
    );
    assert_eq!(
        json!([
            world.connector("discord")["status"],
            world.connector("discord")["reason"]
        ]),
        json!(["refused", "unknown_connector"])
    );

    std::fs::write(world.home_document(), "{not json").unwrap();
    assert_eq!(world.connector("telegram")["reason"], "config_unloadable");
}

#[test]
fn a_view_of_an_unknown_or_broken_character_is_refused() {
    let world = World::new();

    std::fs::create_dir_all(world.root().join("characters/broken")).unwrap();
    std::fs::write(
        world
            .root()
            .join("characters/broken/project02.character.json"),
        "{not json",
    )
    .unwrap();

    let nobody = world.view(&of("nobody"));
    let broken = world.view(&of("broken"));

    assert_eq!(
        json!([nobody["status"], nobody["reason"]]),
        json!(["refused", "unknown_character"])
    );
    assert_eq!(broken["reason"], "unknown_character");
    assert!(
        broken["message"].as_str().unwrap().contains("valid JSON"),
        "{broken}"
    );
}

#[test]
fn inspect_reports_where_the_settings_come_from_the_host_values_and_each_connector() {
    let world = World::new();

    world.write_home(&document(json!({
        "project02": {
            "roleModelProvider": "openai",
            "openaiApiKey": "sk-home",
            "nvidiaApiKey": "nvapi-home",
            "contextWindowTokens": 4096,
        },
        "connectors": {"telegram": {"config": {
            "managementBotToken": "123456:home",
            "botToken": "654321:misplaced",
            "pairedUsers": {"381940562": "Alice (@alice)"},
        }}},
    })));

    let report = serde_json::to_value(world.resolve(&of("mira")).report(&world.home)).unwrap();
    let telegram = &report["connectors"][0];

    assert_eq!(report["runtimeConfig"]["source"], "path");
    assert_eq!(
        report["runtimeConfig"]["path"],
        world.home_document().display().to_string()
    );
    assert_eq!(
        report["runtimeConfig"]["project02"],
        json!({
            "storeRoot": world.root().display().to_string(),
            "character": "mira",
            "enabled": true,
            "userDisplayName": "You",
            "roleModelProvider": "openai",
            "openaiApiKey": "[redacted]",
            "openaiModel": "gpt-6-luna",
            "anthropicModel": "claude-opus-5-5",
            "nvidiaApiKey": "[redacted]",
            "contextWindowTokens": 4096,
            "heartbeatMinutes": 30,
        })
    );
    assert_eq!(
        json!([
            telegram["id"],
            telegram["enabled"],
            telegram["activation"]["status"]
        ]),
        json!(["telegram", true, "active"])
    );
    assert_eq!(
        findings(&telegram["diagnostics"]),
        [(
            "runtime_config_authored_outside_scope".to_owned(),
            "connectors.telegram.config.botToken".to_owned()
        )]
    );
    assert_eq!(
        json!([
            telegram["config"]["botToken"]["source"],
            telegram["config"]["managementBotToken"],
            telegram["config"]["mirror"]["value"],
            telegram["config"]["pairedUsers"]["value"],
        ]),
        json!([
            "missing",
            {"name": "managementBotToken", "secret": true, "source": "config", "resolved": true, "value": "[redacted]"},
            true,
            {"381940562": "Alice (@alice)"},
        ])
    );
    assert!(!report.to_string().contains("654321:misplaced"));
}
