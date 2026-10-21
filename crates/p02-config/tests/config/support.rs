//! A home of the test's own, the plugins it is judged against, and the
//! ways a person, a page or a crash reaches its settings.

use std::path::{Path, PathBuf};
use std::time::Duration;

use p02_characters::{CharacterDefinition, Discovery, discover};
use p02_config::{
    ChangeOutcome, ConfigChange, ConfigTarget, ConfigView, ConnectorConfigView, Resolution,
    Sections, apply_change,
};
use p02_contracts::Manifest;
use p02_shared::{DanglingLinks, Identifier, canonical_path};
use p02_store::Home;
use serde_json::{Map, Value, json};
use tempfile::TempDir;

pub(crate) const VERSION: &str = "project02.config.v2";

/// Long enough that a test's own writers never give up on each other.
pub(crate) const WAIT: Duration = Duration::from_secs(10);

pub(crate) fn id(text: &str) -> Identifier {
    Identifier::new(text).unwrap()
}

/// `stanzas` as a document of this version.
pub(crate) fn document(stanzas: Value) -> Value {
    let Value::Object(stanzas) = stanzas else {
        panic!("a document's stanzas are an object");
    };
    let mut document = Map::new();

    document.insert("version".to_owned(), json!(VERSION));
    document.extend(stanzas);
    Value::Object(document)
}

/// A plugin's manifest with the config section given.
pub(crate) fn manifest(id: &str, kind: &str, scope: &str, on: bool, fields: &Value) -> Manifest {
    Manifest::from_value(&json!({
        "id": id,
        "displayName": id,
        "version": "1.0.0",
        "kind": kind,
        "description": "A plugin of the test's.",
        "contractVersion": "mvp-008.runtime_plugin.v2",
        "compatibility": {"hostContractVersions": ["mvp-008.runtime_plugin.v2"]},
        "declaredPlugins": ["before_role_model_call"],
        "config": {"scope": scope, "fields": fields},
        "firstParty": true,
        "runtimePolicy": {
            "timeoutMs": 1000,
            "redactionLabels": [],
            "failureBehavior": {
                "beforeRoleModelCall": "degrade",
                "handleToolCall": "reject_tool_call",
                "health": "degrade",
            },
        },
        "activation": {"defaultEnabled": on, "reasons": [format!("bundled_{id}")]},
        "requestedAccess": {"model_input": "write"},
    }))
    .unwrap()
}

/// The plugins this build compiles in, their settings as theirs are.
pub(crate) fn plugins() -> Vec<Manifest> {
    vec![
        manifest(
            "demo-config",
            "context_provider",
            "global_with_character_overrides",
            false,
            &json!([
                {
                    "name": "tone", "description": "The tone.", "required": false,
                    "secret": false, "valueType": "string",
                    "allowedValues": ["neutral", "warm", "formal", "playful", "pirate"],
                    "agentMutable": true, "reloadRequired": false, "redactionLabels": [],
                },
                {
                    "name": "signoff", "description": "The signoff.", "required": false,
                    "secret": false, "valueType": "string", "agentMutable": true,
                    "reloadRequired": false, "redactionLabels": [],
                },
                {
                    "name": "operatorNote", "description": "A note.", "required": false,
                    "secret": false, "valueType": "string", "redactionLabels": [],
                },
                {
                    "name": "apiKey", "description": "A key.", "required": false,
                    "secret": true, "valueType": "string", "redactionLabels": [],
                },
            ]),
        ),
        manifest(
            "character-state",
            "first_party",
            "character_only",
            false,
            &json!([]),
        ),
        manifest(
            "mem0",
            "memory_provider",
            "global_with_character_overrides",
            false,
            &json!([
                {
                    "name": "backend", "description": "Where memories are kept.",
                    "required": false, "secret": false, "valueType": "string",
                    "allowedValues": ["platform", "server", "oss"], "defaultValue": "platform",
                    "redactionLabels": [],
                },
                {
                    "name": "apiKey", "description": "The key.", "required": false,
                    "secret": true, "valueType": "string", "redactionLabels": ["memory"],
                },
            ]),
        ),
        manifest(
            "session-history",
            "first_party",
            "global_with_character_overrides",
            true,
            &json!([]),
        ),
    ]
}

/// A home of the test's own, spelled canonically as the daemon spells its
/// home, made a home as `serve` makes it; the directory goes with it.
pub(crate) struct World {
    _directory: TempDir,
    pub(crate) home: Home,
    pub(crate) sections: Sections,
}

impl World {
    pub(crate) fn new() -> Self {
        Self::with_plugins(plugins())
    }

    pub(crate) fn with_plugins(plugins: Vec<Manifest>) -> Self {
        let directory = TempDir::new().unwrap();
        let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());

        home.ensure().unwrap();

        Self {
            _directory: directory,
            home,
            sections: Sections::new(plugins),
        }
    }

    pub(crate) fn root(&self) -> &Path {
        self.home.root()
    }

    pub(crate) fn home_document(&self) -> PathBuf {
        self.root().join("config.json")
    }

    pub(crate) fn overlay(&self, character: &str) -> PathBuf {
        self.root()
            .join("character-data")
            .join(character)
            .join("config.json")
    }

    /// Writes the home's document by hand, as a person would.
    pub(crate) fn write_home(&self, content: &Value) -> &Self {
        std::fs::write(self.home_document(), content.to_string()).unwrap();
        self
    }

    /// Writes her overlay by hand, before her first start if need be.
    pub(crate) fn write_overlay(&self, character: &str, content: &Value) -> &Self {
        let path = self.overlay(character);

        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content.to_string()).unwrap();
        self
    }

    /// Adds a character package to the home.
    pub(crate) fn package(&self, character: &str, plugins: &Value, version: &str) -> &Self {
        let folder = self.root().join("characters").join(character);

        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join("project02.character.json"),
            json!({
                "format": "project02.character.v1",
                "identity": {"id": character, "displayName": character},
                "persona": {"system": [format!("You are {character}.")]},
                "meta": {"version": version},
                "plugins": plugins,
            })
            .to_string(),
        )
        .unwrap();
        self
    }

    pub(crate) fn discovery(&self) -> Discovery {
        discover(self.root())
    }

    pub(crate) fn character(&self, character: &str) -> CharacterDefinition {
        self.discovery().find(character).unwrap().clone()
    }

    pub(crate) fn resolve(&self, target: &ConfigTarget) -> Resolution<'_> {
        Resolution::read(&self.home, &self.sections, &self.discovery(), target).unwrap()
    }

    /// The view of `target` as a page receives it.
    pub(crate) fn view(&self, target: &ConfigTarget) -> Value {
        serde_json::to_value(ConfigView::read(
            &self.home,
            &self.sections,
            &self.discovery(),
            target,
        ))
        .unwrap()
    }

    pub(crate) fn connector(&self, connector: &str) -> Value {
        serde_json::to_value(ConnectorConfigView::read(
            &self.home,
            &self.sections,
            &self.discovery(),
            connector,
        ))
        .unwrap()
    }

    /// `operation` as a page sends it, bound to the fingerprint `expected`.
    pub(crate) fn change_bound(
        &self,
        target: &ConfigTarget,
        expected: &str,
        operation: Value,
    ) -> ChangeOutcome {
        let mut change = Map::new();

        change.insert("target".to_owned(), target_json(target));
        change.insert("expectedFingerprint".to_owned(), json!(expected));
        change.insert("operation".to_owned(), operation);

        let change: ConfigChange = serde_json::from_value(Value::Object(change)).unwrap();

        apply_change(&self.home, &self.sections, &self.discovery(), &change, WAIT)
    }

    /// `operation` as a page sends it from a fresh view of `target`.
    pub(crate) fn change(&self, target: &ConfigTarget, operation: Value) -> ChangeOutcome {
        let fingerprint = self.view(target)["fingerprint"]
            .as_str()
            .unwrap_or("sha256:none")
            .to_owned();

        self.change_bound(target, &fingerprint, operation)
    }

    /// As [`World::change`], failing the test unless it applied.
    pub(crate) fn save(&self, target: &ConfigTarget, operation: Value) -> &Self {
        let outcome = self.change(target, operation);

        assert!(
            matches!(outcome, ChangeOutcome::Applied { .. }),
            "{outcome:?}"
        );
        self
    }
}

pub(crate) fn home() -> ConfigTarget {
    ConfigTarget::Global
}

pub(crate) fn of(character: &str) -> ConfigTarget {
    ConfigTarget::Character {
        character_id: character.to_owned(),
    }
}

fn target_json(target: &ConfigTarget) -> Value {
    match target {
        ConfigTarget::Global => json!({"scope": "global"}),
        ConfigTarget::Character { character_id } => {
            json!({"scope": "character", "characterId": character_id})
        }
    }
}

/// The host field `name` of a view.
pub(crate) fn host_field<'a>(view: &'a Value, name: &str) -> &'a Value {
    view["project02"]
        .as_array()
        .unwrap()
        .iter()
        .find(|field| field["name"] == name)
        .unwrap_or_else(|| panic!("no host field {name} in {view}"))
}

/// The section `id` of `namespace` in a view, if the view shows it.
pub(crate) fn section<'a>(view: &'a Value, namespace: &str, id: &str) -> Option<&'a Value> {
    view["sections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|section| section["namespace"] == namespace && section["id"] == id)
}

pub(crate) fn field<'a>(section: &'a Value, name: &str) -> Option<&'a Value> {
    section["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|field| field["name"] == name)
}

/// Each diagnostic of `diagnostics` as its code and its path.
pub(crate) fn findings(diagnostics: &Value) -> Vec<(String, String)> {
    diagnostics
        .as_array()
        .unwrap()
        .iter()
        .map(|diagnostic| {
            (
                diagnostic["code"].as_str().unwrap().to_owned(),
                diagnostic["path"].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect()
}

/// The names of the files under `root`, as a person listing it sees them,
/// spelled with `/` on every platform; a link is listed, never followed.
pub(crate) fn tree(root: &Path) -> Vec<String> {
    let mut names = Vec::new();

    for entry in std::fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().into_string().unwrap();

        if entry.file_type().unwrap().is_dir() {
            names.extend(
                tree(&entry.path())
                    .into_iter()
                    .map(|inner| format!("{name}/{inner}")),
            );
        }

        names.push(name);
    }

    names.sort();
    names
}
