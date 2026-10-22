//! Homes generated at random from fixed seeds: valid settings in both
//! documents, with one fault planted in one of them or none, each read
//! back with exactly the findings planted, at their paths, and no others.

use std::collections::BTreeSet;

use p02_config::{Code, ConfigView, ReadSettingsError, Resolution};
use serde_json::{Map, Value, json};

use crate::support::{World, document, home, of};

/// A small generator of its own, so a failing seed is a seed to rerun.
struct Random(u64);

impl Random {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);

        let mut mixed = self.0;

        mixed = (mixed ^ (mixed >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        mixed = (mixed ^ (mixed >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        mixed ^ (mixed >> 31)
    }

    fn below(&mut self, bound: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(bound).unwrap()).unwrap()
    }

    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
}

/// Which document a fault is planted in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum In {
    Home,
    Overlay,
}

/// What a fault does to the targets that read its document.
#[derive(Debug)]
enum Planted {
    /// Nothing is wrong.
    Nothing,
    /// The document does not load, for this one reason.
    Unloadable(In, Code, &'static str),
    /// One finding at one path, which every target reading the document
    /// reports; an error blocks the section it names, a warning nothing.
    Finding(In, Code, &'static str),
    /// Her overlay is a link, which the store refuses.
    LinkedOverlay,
    /// Her overlay cannot be read.
    UnreadableOverlay,
}

struct Generated {
    home: Map<String, Value>,
    overlay: Map<String, Value>,
    /// What the home's document is found to say whichever target reads it.
    warnings: Vec<(Code, String)>,
}

fn stanza<'a>(document: &'a mut Map<String, Value>, path: &[&str]) -> &'a mut Map<String, Value> {
    path.iter().fold(document, |object, key| {
        object
            .entry(*key)
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .unwrap()
    })
}

/// Valid settings: every value one its field takes, set where its scope
/// lets it be set, and unknown sections the generator expects warnings of;
/// valid for Mira too, who runs the memory plugin her settings choose and
/// the plugin her package requires.
fn generate(random: &mut Random) -> Generated {
    let mut home = document(json!({})).as_object().unwrap().clone();
    let mut overlay = home.clone();
    let mut warnings = Vec::new();

    settings(random, &mut home);
    settings(random, &mut overlay);

    if [&home, &overlay]
        .iter()
        .any(|document| document["project02"].get("defaultMemoryProvider").is_some())
    {
        for document in [&mut home, &mut overlay] {
            stanza(document, &["plugins", "mem0"]).insert("enabled".to_owned(), json!(true));
        }
    }

    if random.chance(50) {
        let telegram = stanza(&mut home, &["connectors", "telegram", "config"]);

        telegram.insert("managementBotToken".to_owned(), json!("123456:home"));
        telegram.insert(
            "pairedUsers".to_owned(),
            json!({"381940562": "Alice (@alice)"}),
        );
    }

    if random.chance(50) {
        stanza(&mut overlay, &["connectors", "telegram", "config"])
            .insert("botToken".to_owned(), json!("987654:mira"));
    }

    if random.chance(50) {
        stanza(&mut overlay, &["plugins", "character-state"])
            .insert("enabled".to_owned(), json!(true));
    }

    if random.chance(40) {
        let on = random.chance(50);

        stanza(&mut home, &["plugins", "ghost"]).insert("enabled".to_owned(), json!(on));

        if on {
            warnings.push((Code::UnknownPlugin, "plugins.ghost".to_owned()));
        }
    }

    if random.chance(30) {
        let off = random.chance(50);
        let discord = stanza(&mut home, &["connectors", "discord"]);

        if off {
            discord.insert("enabled".to_owned(), json!(false));
        } else {
            warnings.push((Code::UnknownConnector, "connectors.discord".to_owned()));
        }
    }

    Generated {
        home,
        overlay,
        warnings,
    }
}

/// What either document may hold: host values, and the sections set for
/// the home and over it by a character.
fn settings(random: &mut Random, document: &mut Map<String, Value>) {
    let project02 = stanza(document, &["project02"]);
    let choices: [(&str, Value); 8] = [
        (
            "userDisplayName",
            json!(random.pick(&["Robin", "  Sam  ", "Zo\u{eb}", "\u{1f600} Emoji"])),
        ),
        ("roleModelProvider", json!("nvidia")),
        ("nvidiaApiKey", json!(format!("nvapi-{}", random.next()))),
        (
            "nvidiaModel",
            json!(random.pick(&["nvidia/nemotron", "meta/llama"])),
        ),
        (
            "nvidiaBaseUrl",
            json!(random.pick(&["http://127.0.0.1:1234/v1", "https://nim.example.test/v1/"])),
        ),
        ("contextWindowTokens", json!(1 + random.below(1_000_000))),
        ("defaultMemoryProvider", json!("mem0")),
        ("enabled", json!(random.chance(50))),
    ];

    for (name, value) in choices {
        if random.chance(50) {
            project02.insert(name.to_owned(), value);
        }
    }

    if random.chance(70) {
        let demo = stanza(document, &["plugins", "demo-config"]);

        if random.chance(50) {
            demo.insert("enabled".to_owned(), json!(random.chance(50)));
        }

        let config = stanza(demo, &["config"]);

        if random.chance(50) {
            config.insert(
                "tone".to_owned(),
                json!(random.pick(&["neutral", "warm", "formal", "playful", "pirate"])),
            );
        }
        if random.chance(50) {
            config.insert(
                "signoff".to_owned(),
                json!(random.pick(&["", "Yours.", "-R"])),
            );
        }
        if random.chance(30) {
            config.insert("apiKey".to_owned(), json!(format!("sk-{}", random.next())));
        }
    }

    if random.chance(40) {
        let mem0 = stanza(document, &["plugins", "mem0"]);

        mem0.insert("enabled".to_owned(), json!(random.chance(50)));
        stanza(mem0, &["config"]).insert(
            "backend".to_owned(),
            json!(random.pick(&["platform", "server", "oss"])),
        );
    }

    if random.chance(30) {
        stanza(document, &["plugins", "session-history"])
            .insert("enabled".to_owned(), json!(random.chance(50)));
    }

    if random.chance(50) {
        let telegram = stanza(document, &["connectors", "telegram"]);

        if random.chance(30) {
            telegram.insert("enabled".to_owned(), json!(random.chance(50)));
        }
        if random.chance(50) {
            stanza(telegram, &["config"]).insert("mirror".to_owned(), json!(random.chance(50)));
        }
    }
}

/// Switches a section on in both documents, so what is planted in it is
/// judged: the settings of a section that is off are not.
fn judged(generated: &mut Generated, path: &[&str]) {
    for document in [&mut generated.home, &mut generated.overlay] {
        stanza(document, path).insert("enabled".to_owned(), json!(true));
    }
}

/// Plants one fault, or none, and says what it is.
#[expect(
    clippy::too_many_lines,
    reason = "one table of every fault planted, read top to bottom"
)]
fn plant(random: &mut Random, generated: &mut Generated) -> Planted {
    let value = |document: &mut Map<String, Value>, path: &[&str], key: &str, value: Value| {
        stanza(document, path).insert(key.to_owned(), value);
    };
    let demo = ["plugins", "demo-config"];
    let telegram = ["connectors", "telegram"];

    match random.below(22) {
        0..=3 => Planted::Nothing,
        4 => {
            generated
                .home
                .insert("unknownField".to_owned(), json!(true));
            Planted::Unloadable(In::Home, Code::UnknownTopLevelField, "unknownField")
        }
        5 => {
            value(
                &mut generated.home,
                &["project02"],
                "storeRoot",
                json!("/elsewhere"),
            );
            Planted::Unloadable(In::Home, Code::UnknownProject02Field, "project02.storeRoot")
        }
        6 => {
            value(
                &mut generated.home,
                &["project02"],
                "nvidiaApiKey",
                json!({"$env": "NVIDIA_API_KEY"}),
            );
            Planted::Unloadable(In::Home, Code::SecretValueInvalid, "project02.nvidiaApiKey")
        }
        7 => {
            let tokens = [json!(0), json!(1.5), json!("4096"), json!(-5)][random.below(4)].clone();

            value(
                &mut generated.overlay,
                &["project02"],
                "contextWindowTokens",
                tokens,
            );
            Planted::Unloadable(
                In::Overlay,
                Code::ContextWindowTokensInvalid,
                "project02.contextWindowTokens",
            )
        }
        8 => {
            let name = [json!("Two\nlines"), json!("x".repeat(129)), json!("   ")][random.below(3)]
                .clone();

            value(&mut generated.home, &["project02"], "userDisplayName", name);
            Planted::Unloadable(In::Home, Code::StringInvalid, "project02.userDisplayName")
        }
        9 => {
            let base = random.pick(&[
                "ftp://nim.example.test/v1",
                "nim.example.test/v1",
                "https://user:secret@nim.example.test/v1",
                "https://nim.example.test/v1?key=secret",
            ]);

            value(
                &mut generated.overlay,
                &["project02"],
                "nvidiaBaseUrl",
                json!(base),
            );
            Planted::Unloadable(
                In::Overlay,
                Code::NvidiaBaseUrlInvalid,
                "project02.nvidiaBaseUrl",
            )
        }
        10 => {
            let provider = random.pick(&["local", "deterministic"]);

            value(
                &mut generated.home,
                &["project02"],
                "roleModelProvider",
                json!(provider),
            );
            Planted::Unloadable(
                In::Home,
                Code::RoleModelProviderInvalid,
                "project02.roleModelProvider",
            )
        }
        11 => {
            generated
                .overlay
                .insert("version".to_owned(), json!("project02.config.v1"));
            Planted::Unloadable(In::Overlay, Code::VersionUnsupported, "version")
        }
        12 => {
            generated.home.insert("plugins".to_owned(), json!([]));
            generated
                .warnings
                .retain(|(code, _)| *code != Code::UnknownPlugin);
            Planted::Unloadable(In::Home, Code::PluginsNotObject, "plugins")
        }
        13 => {
            judged(generated, &demo);
            value(&mut generated.home, &demo, "bogus", json!(1));
            Planted::Finding(
                In::Home,
                Code::UnknownPluginWrapperField,
                "plugins.demo-config.bogus",
            )
        }
        14 => {
            judged(generated, &demo);
            value(
                &mut generated.overlay,
                &["plugins", "demo-config", "config"],
                "nope",
                json!(1),
            );
            Planted::Finding(
                In::Overlay,
                Code::UnknownPluginConfigField,
                "plugins.demo-config.config.nope",
            )
        }
        15 => {
            judged(generated, &demo);
            stanza(
                &mut generated.overlay,
                &["plugins", "demo-config", "config"],
            )
            .remove("tone");
            value(
                &mut generated.home,
                &["plugins", "demo-config", "config"],
                "tone",
                json!("shouty"),
            );
            Planted::Finding(
                In::Home,
                Code::ValueTypeInvalid,
                "plugins.demo-config.config.tone",
            )
        }
        16 => {
            judged(generated, &demo);
            value(&mut generated.overlay, &demo, "config", json!("warm"));
            Planted::Finding(
                In::Overlay,
                Code::PluginConfigNotObject,
                "plugins.demo-config.config",
            )
        }
        17 => {
            judged(generated, &telegram);
            stanza(
                &mut generated.overlay,
                &["connectors", "telegram", "config"],
            )
            .remove("mirror");
            value(
                &mut generated.home,
                &["connectors", "telegram", "config"],
                "mirror",
                json!("yes"),
            );
            Planted::Finding(
                In::Home,
                Code::ValueTypeInvalid,
                "connectors.telegram.config.mirror",
            )
        }
        18 => {
            judged(generated, &telegram);
            value(
                &mut generated.overlay,
                &["connectors", "telegram", "config"],
                "botToken",
                json!("   "),
            );
            Planted::Finding(
                In::Overlay,
                Code::SecretValueInvalid,
                "connectors.telegram.config.botToken",
            )
        }
        19 => {
            value(
                &mut generated.home,
                &["plugins", "character-state"],
                "enabled",
                json!(true),
            );
            Planted::Finding(
                In::Home,
                Code::AuthoredOutsideScope,
                "plugins.character-state.enabled",
            )
        }
        20 => {
            value(
                &mut generated.overlay,
                &["connectors", "telegram", "config"],
                "managementBotToken",
                json!("222222:mira"),
            );
            Planted::Finding(
                In::Overlay,
                Code::AuthoredOutsideScope,
                "connectors.telegram.config.managementBotToken",
            )
        }
        _ if random.chance(50) => Planted::LinkedOverlay,
        _ => Planted::UnreadableOverlay,
    }
}

fn found(resolution: &Resolution<'_>) -> BTreeSet<(Code, String)> {
    resolution
        .diagnostics()
        .iter()
        .map(|diagnostic| {
            (
                diagnostic.code(),
                diagnostic.path().unwrap_or("").to_owned(),
            )
        })
        .collect()
}

fn unloadable(world: &World, target: &p02_config::ConfigTarget) -> Vec<(Code, String)> {
    match Resolution::read(&world.home, &world.sections, &world.discovery(), target) {
        Err(ReadSettingsError::Unloadable { diagnostics }) => diagnostics
            .iter()
            .map(|diagnostic| {
                (
                    diagnostic.code(),
                    diagnostic.path().unwrap_or("").to_owned(),
                )
            })
            .collect(),
        other => panic!("{other:?}"),
    }
}

fn refused(world: &World, target: &p02_config::ConfigTarget) -> bool {
    matches!(
        ConfigView::read(&world.home, &world.sections, &world.discovery(), target),
        ConfigView::Refused { .. }
    )
}

#[test]
fn every_generated_home_reads_back_with_exactly_the_findings_planted_in_it() {
    for seed in 0..96 {
        let mut random = Random(seed);
        let mut generated = generate(&mut random);
        let planted = plant(&mut random, &mut generated);
        let world = World::new();
        let elsewhere = World::new();
        let shared: BTreeSet<(Code, String)> = generated.warnings.iter().cloned().collect();

        world.write_home(&Value::Object(generated.home.clone()));

        match planted {
            Planted::LinkedOverlay => {
                elsewhere.write_home(&Value::Object(generated.overlay.clone()));
                std::fs::create_dir_all(world.overlay("mira").parent().unwrap()).unwrap();
                #[cfg(unix)]
                std::os::unix::fs::symlink(elsewhere.home_document(), world.overlay("mira"))
                    .unwrap();
                #[cfg(windows)]
                std::os::windows::fs::symlink_file(
                    elsewhere.home_document(),
                    world.overlay("mira"),
                )
                .unwrap();
            }
            _ => {
                world.write_overlay("mira", &Value::Object(generated.overlay.clone()));
            }
        }

        #[cfg(unix)]
        if matches!(planted, Planted::UnreadableOverlay) {
            use std::os::unix::fs::PermissionsExt as _;

            std::fs::set_permissions(
                world.overlay("mira"),
                std::fs::Permissions::from_mode(0o000),
            )
            .unwrap();
        }

        let mira = of("mira");

        match &planted {
            Planted::Nothing => {
                assert_eq!(found(&world.resolve(&home())), shared, "seed {seed}");
                assert_eq!(found(&world.resolve(&mira)), shared, "seed {seed}");
            }
            Planted::Unloadable(In::Home, code, path) => {
                for target in [home(), mira.clone()] {
                    assert_eq!(
                        unloadable(&world, &target),
                        [(*code, (*path).to_owned())],
                        "seed {seed}"
                    );
                    assert!(refused(&world, &target), "seed {seed}");
                }
            }
            Planted::Unloadable(In::Overlay, code, path) => {
                assert_eq!(found(&world.resolve(&home())), shared, "seed {seed}");
                assert_eq!(
                    unloadable(&world, &mira),
                    [(*code, (*path).to_owned())],
                    "seed {seed}"
                );
                assert!(refused(&world, &mira), "seed {seed}");
            }
            Planted::Finding(planted_in, code, path) => {
                let finding = (*code, (*path).to_owned());
                let mut expected = shared.clone();

                expected.insert(finding.clone());

                if *planted_in == In::Home {
                    assert_eq!(found(&world.resolve(&home())), expected, "seed {seed}");
                } else {
                    assert_eq!(found(&world.resolve(&home())), shared, "seed {seed}");
                }

                assert_eq!(found(&world.resolve(&mira)), expected, "seed {seed}");
                assert_blocks_as_it_stops_her(&world, &mira, *code, path, seed);
            }
            Planted::LinkedOverlay => {
                assert_eq!(found(&world.resolve(&home())), shared, "seed {seed}");
                assert!(matches!(
                    Resolution::read(&world.home, &world.sections, &world.discovery(), &mira),
                    Err(ReadSettingsError::Storage(_))
                ));
                assert!(refused(&world, &mira), "seed {seed}");
            }
            Planted::UnreadableOverlay => {
                // Permissions do not bind root, who reads the overlay anyway.
                #[cfg(unix)]
                {
                    if std::fs::read(world.overlay("mira")).is_err() {
                        assert_eq!(
                            unloadable(&world, &mira),
                            [(Code::ReadFailed, String::new())],
                            "seed {seed}"
                        );
                    }

                    std::fs::set_permissions(
                        world.overlay("mira"),
                        std::os::unix::fs::PermissionsExt::from_mode(0o600),
                    )
                    .unwrap();
                }
            }
        }
    }
}

/// What a finding in her settings blocks in her view: an error about what
/// she runs stops her, so no plugin of hers but the host's own is active
/// and the one in error is blocked; a connector's error blocks that
/// connector alone; a warning blocks nothing.
fn assert_blocks_as_it_stops_her(
    world: &World,
    target: &p02_config::ConfigTarget,
    code: Code,
    path: &str,
    seed: u64,
) {
    let view = world.view(target);
    let sections: Vec<(String, &str)> = view["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|section| {
            (
                format!(
                    "{}.{}",
                    section["namespace"].as_str().unwrap(),
                    section["id"].as_str().unwrap()
                ),
                section["activation"]["status"].as_str().unwrap(),
            )
        })
        .collect();
    let named = |status: &str| -> Vec<&str> {
        sections
            .iter()
            .filter(|(_, found)| *found == status)
            .map(|(section, _)| section.as_str())
            .collect()
    };
    let in_error = path.split('.').take(2).collect::<Vec<_>>().join(".");

    if code == Code::AuthoredOutsideScope {
        assert_eq!(named("blocked"), Vec::<&str>::new(), "seed {seed}: {view}");
    } else if in_error.starts_with("connectors.") {
        assert_eq!(named("blocked"), [in_error.as_str()], "seed {seed}: {view}");
    } else {
        let active_plugins: Vec<&str> = named("active")
            .into_iter()
            .filter(|section| section.starts_with("plugins."))
            .collect();

        assert!(
            named("blocked").contains(&in_error.as_str()),
            "seed {seed}: {view}"
        );
        assert!(
            active_plugins
                .iter()
                .all(|section| *section == "plugins.runtime.plugin"),
            "seed {seed}: {view}"
        );
    }
}
