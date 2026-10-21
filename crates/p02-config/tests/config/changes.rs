//! The one way settings change, as a page, a pairing or a race of two
//! reaches it.

use std::sync::Barrier;

use p02_config::{ChangeOutcome, ChangeRefusal, create_home_document};
use serde_json::{Value, json};

use crate::support::{WAIT, World, document, field, home, of, section, tree};

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
fn every_kind_of_change_applies_under_the_fingerprint_the_next_view_carries() {
    let world = World::new();
    let demo = |kind: &str| json!({"kind": kind, "namespace": "plugins", "id": "demo-config"});
    let operations = [
        json!({"kind": "set", "path": "project02.userDisplayName", "value": "Robin"}),
        json!({"kind": "unset", "path": "project02.userDisplayName"}),
        {
            let mut on = demo("section_enabled");

            on["enabled"] = json!(true);
            on
        },
        {
            let mut tone = demo("section_field_set");

            tone["field"] = json!("tone");
            tone["value"] = json!("warm");
            tone
        },
        {
            let mut tone = demo("section_field_unset");

            tone["field"] = json!("tone");
            tone
        },
        demo("section_enabled"),
    ];
    let after = [
        json!({"version": "project02.config.v2", "project02": {"userDisplayName": "Robin"}}),
        json!({"version": "project02.config.v2"}),
        json!({"version": "project02.config.v2", "plugins": {"demo-config": {"enabled": true}}}),
        json!({
            "version": "project02.config.v2",
            "plugins": {"demo-config": {"enabled": true, "config": {"tone": "warm"}}},
        }),
        json!({"version": "project02.config.v2", "plugins": {"demo-config": {"enabled": true}}}),
        json!({"version": "project02.config.v2"}),
    ];

    for (operation, document) in operations.into_iter().zip(after) {
        let before = fingerprint(&world.view(&home()));
        let outcome = world.change(&home(), operation.clone());
        let now = fingerprint(&world.view(&home()));

        assert_eq!(
            outcome,
            ChangeOutcome::Applied {
                fingerprint: p02_shared::Fingerprint::parse(&now).unwrap()
            },
            "{operation}"
        );
        assert_ne!(now, before, "{operation}");
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(world.home_document()).unwrap())
                .unwrap(),
            document,
            "{operation}"
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
fn a_change_bound_to_a_fingerprint_the_documents_moved_past_is_a_conflict_and_writes_nothing() {
    let world = World::new();
    let stale = fingerprint(&world.view(&home()));

    world.save(
        &home(),
        json!({"kind": "set", "path": "project02.userDisplayName", "value": "Robin"}),
    );

    let written = std::fs::read(world.home_document()).unwrap();

    assert_eq!(
        refusal(&world.change_bound(
            &home(),
            &stale,
            json!({"kind": "set", "path": "project02.userDisplayName", "value": "Sam"}),
        )),
        Some(ChangeRefusal::Conflict)
    );
    assert_eq!(std::fs::read(world.home_document()).unwrap(), written);
}

#[test]
fn a_change_to_one_section_may_present_that_sections_fingerprint() {
    let world = World::new();
    let read = world.view(&of("mira"));
    let demo = fingerprint(section(&read, "plugins", "demo-config").unwrap());
    let tone = |value: &str| {
        json!({
            "kind": "section_field_set", "namespace": "plugins", "id": "demo-config",
            "field": "tone", "value": value,
        })
    };

    world.save(
        &home(),
        json!({"kind": "set", "path": "project02.userDisplayName", "value": "Robin"}),
    );

    assert!(matches!(
        world.change_bound(&of("mira"), &demo, tone("warm")),
        ChangeOutcome::Applied { .. }
    ));
    assert_eq!(
        refusal(&world.change_bound(&of("mira"), &demo, tone("formal"))),
        Some(ChangeRefusal::Conflict)
    );
    assert_eq!(
        refusal(&world.change_bound(
            &of("mira"),
            &demo,
            json!({"kind": "set", "path": "project02.userDisplayName", "value": "Sam"}),
        )),
        Some(ChangeRefusal::Conflict)
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
fn a_change_on_her_screen_is_written_into_her_overlay_alone_secrets_too() {
    let world = World::new();

    for operation in [
        json!({"kind": "set", "path": "project02.userDisplayName", "value": "Sam"}),
        json!({"kind": "set", "path": "project02.nvidiaApiKey", "value": "nvapi-mira"}),
        json!({
            "kind": "section_field_set", "namespace": "connectors", "id": "telegram",
            "field": "botToken", "value": "987654:mira",
        }),
    ] {
        world.save(&of("mira"), operation);
    }

    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(world.overlay("mira")).unwrap()).unwrap(),
        json!({
            "version": "project02.config.v2",
            "plugins": {"character-state": {"enabled": true}},
            "project02": {"userDisplayName": "Sam", "nvidiaApiKey": "nvapi-mira"},
            "connectors": {"telegram": {"config": {"botToken": "987654:mira"}}},
        })
    );
    assert!(!world.home_document().exists());
    assert!(
        world
            .root()
            .join("character-data/mira/schema.json")
            .exists()
    );
}

#[test]
fn while_the_homes_document_does_not_load_a_change_of_hers_is_refused_and_makes_no_overlay() {
    let world = World::new();
    let read = fingerprint(&world.view(&of("mira")));

    std::fs::write(world.home_document(), "{not json").unwrap();

    let outcome = world.change_bound(
        &of("mira"),
        &read,
        json!({"kind": "set", "path": "project02.userDisplayName", "value": "Sam"}),
    );

    assert_eq!(refusal(&outcome), Some(ChangeRefusal::Invalid));
    assert!(
        format!("{outcome:?}").contains("failed to load"),
        "{outcome:?}"
    );
    assert!(!world.overlay("mira").exists());
}

#[test]
fn an_edit_to_one_of_her_section_values_leaves_her_section_valid_or_is_refused() {
    let world = World::new();

    world.write_overlay(
        "mira",
        &document(json!({"plugins": {"demo-config": {"enabled": true, "config": {"nope": 1}}}})),
    );

    let tone = json!({
        "kind": "section_field_set", "namespace": "plugins", "id": "demo-config",
        "field": "tone", "value": "warm",
    });

    assert_eq!(
        refusal(&world.change(&of("mira"), tone.clone())),
        Some(ChangeRefusal::Invalid)
    );

    world.write_overlay(
        "mira",
        &document(json!({"plugins": {"demo-config": {"enabled": true}}})),
    );
    world.save(&of("mira"), tone);

    let view = world.view(&of("mira"));

    assert_eq!(
        field(section(&view, "plugins", "demo-config").unwrap(), "tone").unwrap()["authored"],
        json!({"configured": true, "value": "warm"})
    );
}

#[cfg(unix)]
#[test]
fn a_change_to_a_home_that_cannot_be_written_fails_and_the_fingerprint_stays() {
    use std::os::unix::fs::PermissionsExt as _;

    let world = World::new();
    let before = fingerprint(&world.view(&home()));
    let mode = |mode| {
        std::fs::set_permissions(world.root(), std::fs::Permissions::from_mode(mode)).unwrap();
    };

    mode(0o555);

    // Permissions do not bind root, who writes the document anyway.
    let bound = std::fs::write(world.root().join("probe"), "").is_err();
    let outcome = world.change_bound(
        &home(),
        &before,
        json!({"kind": "set", "path": "project02.userDisplayName", "value": "Robin"}),
    );

    mode(0o755);

    if bound {
        assert!(
            matches!(outcome, ChangeOutcome::Failed { .. }),
            "{outcome:?}"
        );
        assert_eq!(fingerprint(&world.view(&home())), before);
    }
}

/// config.lock-order: a home write and a character write racing each other serialize, each character's ending in conflict when the home's write landed first, instead of deadlocking
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
