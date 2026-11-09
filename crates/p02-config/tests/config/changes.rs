//! The one way settings change, as a page, a pairing or a race of two
//! reaches it.

use std::sync::Barrier;

use p02_config::create_home_document;
use p02_wire::{ChangeOutcome, ChangeRefusal, Code, ConfigChange, Namespace, Operation};
use serde_json::{Value, json};

use crate::support::{WAIT, World, document, home, of, section, tree};

fn fingerprint(view: &Value) -> String {
    view["fingerprint"].as_str().unwrap().to_owned()
}

fn refusal(outcome: &ChangeOutcome) -> Option<ChangeRefusal> {
    match outcome {
        ChangeOutcome::Refused { reason, .. } => Some(*reason),
        _ => None,
    }
}

#[test]
fn a_switch_a_change_gives_is_a_boolean_and_absent_one_leaves_it_to_the_document_beneath() {
    let operation = |enabled: Option<Value>| {
        let mut operation =
            json!({"kind": "section_enabled", "namespace": "plugins", "id": "demo-config"});

        if let Some(enabled) = enabled {
            operation["enabled"] = enabled;
        }

        serde_json::from_value::<ConfigChange>(json!({
            "target": {"scope": "global"},
            "expectedFingerprint": "sha256:read",
            "operation": operation,
        }))
        .map(|change| change.operation)
    };

    for refused in [json!(null), json!("on")] {
        assert!(operation(Some(refused.clone())).is_err(), "{refused}");
    }

    for (given, enabled) in [
        (None, None),
        (Some(json!(true)), Some(true)),
        (Some(json!(false)), Some(false)),
    ] {
        assert_eq!(
            operation(given).unwrap(),
            Operation::SectionEnabled {
                namespace: Namespace::Plugins,
                id: "demo-config".to_owned(),
                enabled,
            }
        );
    }
}

#[test]
fn a_new_home_is_given_a_document_naming_its_version_and_one_already_there_stays() {
    let world = World::new();

    create_home_document(&world.home, WAIT).unwrap();

    assert_eq!(
        std::fs::read_to_string(world.home_document()).unwrap(),
        "{\n  \"version\": \"project02.config.v2\"\n}\n"
    );

    std::fs::write(world.home_document(), "{not json").unwrap();
    create_home_document(&world.home, WAIT).unwrap();

    assert_eq!(
        std::fs::read_to_string(world.home_document()).unwrap(),
        "{not json"
    );
}

#[test]
fn a_document_is_written_indented_with_a_trailing_newline_its_sections_in_their_stanzas() {
    let world = World::new();

    world
        .save(
            &home(),
            json!({"kind": "set", "path": "project02.userDisplayName", "value": "Robin"}),
        )
        .save(
            &home(),
            json!({
                "kind": "section_field_set", "namespace": "plugins", "id": "demo-config",
                "field": "tone", "value": "warm",
            }),
        )
        .save(
            &home(),
            json!({
                "kind": "section_field_set", "namespace": "connectors", "id": "telegram",
                "field": "mirror", "value": false,
            }),
        );

    assert_eq!(
        std::fs::read_to_string(world.home_document()).unwrap(),
        concat!(
            "{\n",
            "  \"version\": \"project02.config.v2\",\n",
            "  \"project02\": {\n",
            "    \"userDisplayName\": \"Robin\"\n",
            "  },\n",
            "  \"plugins\": {\n",
            "    \"demo-config\": {\n",
            "      \"config\": {\n",
            "        \"tone\": \"warm\"\n",
            "      }\n",
            "    }\n",
            "  },\n",
            "  \"connectors\": {\n",
            "    \"telegram\": {\n",
            "      \"config\": {\n",
            "        \"mirror\": false\n",
            "      }\n",
            "    }\n",
            "  }\n",
            "}\n",
        )
    );
}

#[test]
fn a_secrets_presence_moves_the_fingerprint_and_its_value_never_does() {
    let world = World::new();
    let unset = fingerprint(&world.view(&home()));
    let key =
        |value: &str| json!({"kind": "set", "path": "project02.nvidiaApiKey", "value": value});

    world.save(&home(), key("nvapi-first"));

    let set = fingerprint(&world.view(&home()));

    assert_ne!(set, unset);

    for value in ["nvapi-second", "nvapi-third"] {
        assert_eq!(
            world.change_bound(&home(), &set, key(value)),
            ChangeOutcome::Applied {
                fingerprint: p02_shared::Fingerprint::parse(&set).unwrap()
            }
        );
    }

    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(world.home_document()).unwrap()).unwrap()["project02"]
            ["nvidiaApiKey"],
        "nvapi-third"
    );
}

#[test]
fn a_secret_is_kept_as_typed_and_a_blank_one_is_refused_when_saved() {
    let world = World::new();
    let token = |value: &str| {
        json!({
            "kind": "section_field_set", "namespace": "connectors", "id": "telegram",
            "field": "managementBotToken", "value": value,
        })
    };

    world.save(&home(), token("  123456:as typed  "));

    assert_eq!(
        world.connector("telegram")["home"]["values"]["managementBotToken"],
        "  123456:as typed  "
    );

    for blank in ["", "   "] {
        assert_eq!(
            refusal(&world.change(&home(), token(blank))),
            Some(ChangeRefusal::Invalid),
            "{blank:?}"
        );
    }
}

#[test]
fn a_host_value_its_rule_refuses_is_refused_and_the_refusal_never_repeats_it() {
    let world = World::new();
    let marker = "never-repeated";
    let refused = [
        ("project02.contextWindowTokens", json!(0)),
        ("project02.contextWindowTokens", json!(1.5)),
        ("project02.contextWindowTokens", json!("4096")),
        ("project02.userDisplayName", json!("x".repeat(129))),
        ("project02.userDisplayName", json!("Two\nlines")),
        ("project02.userDisplayName", json!("   ")),
        ("project02.roleModelProvider", json!("deterministic")),
        (
            "project02.nvidiaBaseUrl",
            json!(format!("ftp://{marker}.example.test/v1")),
        ),
        (
            "project02.nvidiaBaseUrl",
            json!(format!("{marker}.example.test/v1")),
        ),
        (
            "project02.nvidiaBaseUrl",
            json!(format!("https://user:{marker}@nim.example.test/v1")),
        ),
        (
            "project02.nvidiaBaseUrl",
            json!(format!("https://nim.example.test/v1?key={marker}")),
        ),
        (
            "project02.nvidiaBaseUrl",
            json!(format!("https://nim.example.test/v1#{marker}")),
        ),
    ];

    for (path, value) in refused {
        let outcome = world.change(
            &home(),
            json!({"kind": "set", "path": path, "value": value}),
        );

        assert_eq!(
            refusal(&outcome),
            Some(ChangeRefusal::Invalid),
            "{path} {value}"
        );
        assert!(!format!("{outcome:?}").contains(marker), "{outcome:?}");
    }

    world
        .save(
            &home(),
            json!({"kind": "set", "path": "project02.userDisplayName", "value": "x".repeat(128)}),
        )
        .save(
            &home(),
            json!({"kind": "set", "path": "project02.nvidiaBaseUrl", "value": "http://127.0.0.1:1234/v1"}),
        );
}

#[test]
fn a_change_its_own_rules_refuse_is_refused_and_makes_no_data_directory() {
    let world = World::new();

    world.write_home(&document(json!({"project02": {"enabled": false}})));

    let demo = |field: &str, value: Value| {
        json!({
            "kind": "section_field_set", "namespace": "plugins", "id": "demo-config",
            "field": field, "value": value,
        })
    };

    for operation in [
        json!({"kind": "set", "path": "project02.contextWindowTokens", "value": "many"}),
        demo("tone", json!("shouty")),
        json!({"kind": "set", "path": "project02.storeRoot", "value": "/elsewhere"}),
        demo("volume", json!(11)),
        json!({
            "kind": "section_field_set", "namespace": "plugins", "id": "nope",
            "field": "tone", "value": "warm",
        }),
        json!({
            "kind": "section_field_set", "namespace": "connectors", "id": "discord",
            "field": "botToken", "value": "555555:discord",
        }),
    ] {
        assert_eq!(
            refusal(&world.change(&of("mira"), operation.clone())),
            Some(ChangeRefusal::Invalid),
            "{operation}"
        );
    }

    assert_eq!(
        refusal(&world.change_bound(
            &of("nobody"),
            &fingerprint(&world.view(&of("mira"))),
            json!({"kind": "set", "path": "project02.enabled", "value": true}),
        )),
        Some(ChangeRefusal::UnknownCharacter)
    );
    assert_eq!(
        tree(&world.root().join("character-data")),
        Vec::<String>::new()
    );
}

#[test]
fn each_target_lists_and_writes_only_what_its_scope_lets_it_set() {
    let world = World::new();

    world.save(
        &home(),
        json!({"kind": "set", "path": "project02.userDisplayName", "value": "Robin"}),
    );
    world.save(
        &of("mira"),
        json!({"kind": "set", "path": "project02.contextWindowTokens", "value": 4096}),
    );

    let telegram_fields = |view: &Value| -> Vec<Value> {
        section(view, "connectors", "telegram").unwrap()["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|field| field["name"].clone())
            .collect()
    };
    let home_view = world.view(&home());
    let mira_view = world.view(&of("mira"));

    assert!(section(&home_view, "plugins", "character-state").is_none());
    assert!(section(&mira_view, "plugins", "character-state").is_some());
    assert_eq!(
        telegram_fields(&home_view),
        [
            json!("managementBotToken"),
            json!("mirror"),
            json!("pairedUsers")
        ]
    );
    assert_eq!(
        telegram_fields(&mira_view),
        [json!("botToken"), json!("mirror")]
    );

    let documents =
        || [world.home_document(), world.overlay("mira")].map(|path| std::fs::read(path).unwrap());
    let before = documents();
    let telegram = |field: &str, value: Value| {
        json!({
            "kind": "section_field_set", "namespace": "connectors", "id": "telegram",
            "field": field, "value": value,
        })
    };

    for (target, operation) in [
        (
            home(),
            json!({
                "kind": "section_enabled", "namespace": "plugins", "id": "character-state",
                "enabled": true,
            }),
        ),
        (home(), telegram("botToken", json!("987654:bot"))),
        (
            of("mira"),
            telegram("managementBotToken", json!("123456:bot")),
        ),
        (of("mira"), telegram("pairedUsers", json!({}))),
    ] {
        assert_eq!(
            refusal(&world.change(&target, operation.clone())),
            Some(ChangeRefusal::Invalid),
            "{operation}"
        );
    }

    assert_eq!(documents(), before);
}

#[test]
fn a_change_over_a_document_that_cannot_be_read_is_refused_saying_why_and_writes_nothing() {
    let world = World::new();
    let read = fingerprint(&world.view(&of("mira")));

    std::fs::write(world.home_document(), "{not json").unwrap();

    let outcome = world.change_bound(
        &of("mira"),
        &read,
        json!({"kind": "set", "path": "project02.userDisplayName", "value": "Sam"}),
    );

    assert_eq!(
        refusal(&outcome),
        Some(ChangeRefusal::Invalid),
        "{outcome:?}"
    );
    assert!(
        format!("{outcome:?}").contains("not valid JSON"),
        "{outcome:?}"
    );
    assert_eq!(
        std::fs::read_to_string(world.home_document()).unwrap(),
        "{not json"
    );
    assert!(!world.overlay("mira").exists());
}

#[test]
fn a_change_applies_beside_values_a_document_refuses_so_each_is_put_right_in_turn() {
    let world = World::new();

    world
        .write_home(&document(json!({"project02": {"contextWindowTokens": -5}})))
        .write_overlay(
            "mira",
            &document(json!({"plugins": {"demo-config": {
                "enabled": true,
                "config": {"nope": 1, "tone": "shouty", "signoff": 7},
            }}})),
        );

    let demo = |field: &str, value: Value| {
        json!({
            "kind": "section_field_set", "namespace": "plugins", "id": "demo-config",
            "field": field, "value": value,
        })
    };

    world
        .save(&of("mira"), demo("tone", json!("warm")))
        .save(&of("mira"), demo("signoff", json!("Yours.")))
        .save(
            &home(),
            json!({"kind": "set", "path": "project02.contextWindowTokens", "value": 4096}),
        );

    let resolution = world.resolve(&of("mira"));

    assert_eq!(
        resolution
            .diagnostics()
            .iter()
            .map(|diagnostic| (diagnostic.code(), diagnostic.path()))
            .collect::<Vec<_>>(),
        [(Code::Ignored, Some("plugins.demo-config.config.nope"))]
    );
    assert_eq!(
        resolution.settings().host().context_window_tokens.get(),
        4096
    );
}

#[cfg(unix)]
#[test]
fn a_change_that_fails_after_her_packages_settings_are_settled_leaves_them_as_shown_and_a_retry_applies()
 {
    use std::os::unix::fs::PermissionsExt as _;

    use p02_store::CharacterData;

    use crate::support::id;

    let world = World::new();
    let locks = world.root().join("character-data/mira/.locks");
    let tokens = json!({"kind": "set", "path": "project02.contextWindowTokens", "value": 4096});
    let mode = |mode| {
        std::fs::set_permissions(&locks, std::fs::Permissions::from_mode(mode)).unwrap();
    };

    CharacterData::ensure(&world.home, &id("mira")).unwrap();

    let read = fingerprint(&world.view(&of("mira")));

    mode(0o000);

    // Permissions do not bind root, who records her package's version anyway.
    let bound = std::fs::write(locks.join("probe"), "").is_err();
    let outcome = world.change_bound(&of("mira"), &read, tokens.clone());

    mode(0o755);

    if bound {
        assert!(
            matches!(outcome, ChangeOutcome::Failed { .. }),
            "{outcome:?}"
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(world.overlay("mira")).unwrap())
                .unwrap(),
            document(json!({"plugins": {"character-state": {"enabled": true}}}))
        );
        assert_eq!(fingerprint(&world.view(&of("mira"))), read);
        assert!(matches!(
            world.change_bound(&of("mira"), &read, tokens),
            ChangeOutcome::Applied { .. }
        ));
    }
}

/// Each character's write ends in conflict when the home's landed first.
#[test]
fn a_home_write_and_character_writes_racing_each_other_serialize_without_deadlock() {
    for round in 0..16 {
        let world = World::new();

        world.package("zeta", &json!({}), "1.0.0");

        let read = [home(), of("mira"), of("zeta")].map(|target| fingerprint(&world.view(&target)));
        let barrier = Barrier::new(3);
        let outcomes = std::thread::scope(|scope| {
            let writers: Vec<_> = [
                (home(), "project02.userDisplayName", json!("Robin")),
                (of("mira"), "project02.contextWindowTokens", json!(4096)),
                (of("zeta"), "project02.contextWindowTokens", json!(2048)),
            ]
            .into_iter()
            .zip(&read)
            .map(|((target, path, value), read)| {
                let world = &world;
                let barrier = &barrier;

                scope.spawn(move || {
                    barrier.wait();
                    world.change_bound(
                        &target,
                        read,
                        json!({"kind": "set", "path": path, "value": value}),
                    )
                })
            })
            .collect();

            writers
                .into_iter()
                .map(|writer| writer.join().unwrap())
                .collect::<Vec<_>>()
        });

        assert!(
            matches!(outcomes[0], ChangeOutcome::Applied { .. }),
            "round {round}: {outcomes:?}"
        );

        for (character, outcome) in ["mira", "zeta"].into_iter().zip(&outcomes[1..]) {
            let overlay = world.overlay(character);

            match outcome {
                ChangeOutcome::Applied { .. } => assert!(overlay.exists(), "round {round}"),
                ChangeOutcome::Refused {
                    reason: ChangeRefusal::Conflict,
                    ..
                } => assert!(!overlay.exists(), "round {round}"),
                other => panic!("round {round}: {other:?}"),
            }
        }

        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(world.home_document()).unwrap())
                .unwrap(),
            document(json!({"project02": {"userDisplayName": "Robin"}})),
            "round {round}"
        );
    }
}
