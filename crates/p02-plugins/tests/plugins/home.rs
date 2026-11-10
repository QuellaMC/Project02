//! A home of the tests' own with the bundled Mira in it: her data and her
//! settings as her daemon keeps them, hosts of the listed plugins over
//! them, and her settings handed to her host as her daemon hands them.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;

use p02_characters::discover;
use p02_config::{Resolution, Sections, apply_change, check_change, materialize};
use p02_contracts::{Manifest, PluginFactory, SetupCheck};
use p02_plugins::{
    ConfigControl, ConfirmationDecision, ConfirmationRequest, Confirmer, FieldChange,
    FieldChangeOutcome, PluginHost, PluginSettings, ReadConfigError, list,
};
use p02_shared::{
    DanglingLinks, Identifier, canonical_path, create_directories, read_file, remove_file,
    write_file_atomically,
};
use p02_store::{CharacterData, Home, SettingsDocument};
use p02_wire::{
    ActivationStatus, ChangeOutcome, ChangeRefusal, ConfigChange, ConfigTarget, Namespace,
    Operation,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::Notify;

use crate::support::{builder, id};

/// How long a test waits for a settings document's lock.
const SETTINGS_WAIT: Duration = Duration::from_secs(5);

/// A canonical temporary home, the directory going with it, and the
/// sections its settings are judged against: the listed plugins'.
pub(crate) struct MiraHome {
    _directory: TempDir,
    home: Home,
    sections: Arc<Sections>,
}

impl MiraHome {
    pub(crate) fn new() -> Self {
        Self::judged_by(
            list::plugins()
                .unwrap()
                .iter()
                .map(|(manifest, check, _)| (manifest.clone(), *check)),
        )
    }

    /// A home whose settings are judged against `plugins`, each a manifest
    /// and its check, in place of the listed plugins' own.
    pub(crate) fn judged_by(plugins: impl IntoIterator<Item = (Manifest, SetupCheck)>) -> Self {
        let directory = TempDir::new().unwrap();
        let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());

        Self {
            _directory: directory,
            home,
            sections: Arc::new(Sections::new(plugins)),
        }
    }

    /// Writes the home's settings as `document` says them.
    pub(crate) fn settings(&self, document: &Value) {
        let mut document = document.clone();

        document["version"] = json!("project02.config.v2");
        write_file_atomically(
            &self.path(SettingsDocument::Home),
            serde_json::to_string_pretty(&document).unwrap().as_bytes(),
        )
        .unwrap();
    }

    pub(crate) fn path(&self, document: SettingsDocument<'_>) -> PathBuf {
        self.home.settings_path(document)
    }

    /// Mira's own settings, as her overlay's file holds them.
    pub(crate) fn overlay(&self) -> Value {
        let path = self.path(SettingsDocument::Overlay(&id("mira")));

        serde_json::from_slice(&read_file(&path).unwrap()).unwrap()
    }

    /// File `name` of the files plugin `plugin` keeps of Mira's.
    pub(crate) fn plugin_file(&self, plugin: &str, name: &str) -> PathBuf {
        self.home
            .root()
            .join("character-data/mira/plugin-data")
            .join(plugin)
            .join(name)
    }

    /// Mira's data directory, made the first time.
    pub(crate) fn data(&self) -> CharacterData {
        CharacterData::ensure(&self.home, &id("mira")).unwrap()
    }

    /// A host over Mira's data of the listed plugins `plugins`, each with
    /// the values its settings would give it.
    pub(crate) fn host(&self, plugins: &[(&str, Value)]) -> PluginHost {
        plugins
            .iter()
            .fold(
                builder(Arc::new(self.data())),
                |builder, (plugin, values)| {
                    let (manifest, _, factory) = bundled(plugin);

                    builder.plugin(
                        manifest.clone(),
                        values.as_object().unwrap().clone(),
                        *factory,
                    )
                },
            )
            .activate()
            .unwrap()
    }

    /// Mira's host as her daemon builds it once her start merged her
    /// package's settings into hers: every listed plugin her settings run,
    /// with the values they give it, `asking` asking the person, and her
    /// settings handed to the host's own plugin.
    pub(crate) fn mira(&self, asking: Arc<dyn Confirmer>) -> PluginHost {
        let discovery = discover(self.home.root());
        let mira = discovery.find("mira").unwrap();
        let data = materialize(&self.home, &self.sections, mira, SETTINGS_WAIT).unwrap();
        let settings = Resolution::character(&self.home, &self.sections, mira)
            .unwrap()
            .settings();

        settings
            .plugins()
            .fold(
                PluginHost::builder(
                    Arc::new(data),
                    asking,
                    Arc::new(MiraSettings {
                        home: self.home.clone(),
                        sections: Arc::clone(&self.sections),
                    }),
                ),
                |builder, (plugin, values)| {
                    let (manifest, _, factory) = bundled(plugin.as_str());

                    builder.plugin(manifest.clone(), values.clone(), *factory)
                },
            )
            .activate()
            .unwrap()
    }

    /// The fingerprint of Mira's settings now, which a change presents.
    pub(crate) fn fingerprint(&self) -> String {
        let discovery = discover(self.home.root());

        Resolution::character(&self.home, &self.sections, discovery.find("mira").unwrap())
            .unwrap()
            .fingerprint()
            .as_str()
            .to_owned()
    }

    /// Changes Mira's settings as her settings page would: sets field
    /// `field` of plugin `plugin` in her overlay.
    pub(crate) fn change(&self, plugin: &str, field: &str, value: Value) {
        let outcome = apply_change(
            &self.home,
            &self.sections,
            &discover(self.home.root()),
            &ConfigChange {
                target: ConfigTarget::Character {
                    character_id: "mira".to_owned(),
                },
                expected_fingerprint: self.fingerprint(),
                operation: Operation::SectionFieldSet {
                    namespace: Namespace::Plugins,
                    id: plugin.to_owned(),
                    field: field.to_owned(),
                    value,
                },
            },
            SETTINGS_WAIT,
        );

        assert!(
            matches!(outcome, ChangeOutcome::Applied { .. }),
            "{outcome:?}"
        );
    }
}

/// The person, saying yes to every question, at once or once a test lets
/// her, and keeping what she was asked.
#[derive(Debug)]
pub(crate) struct Person {
    held: bool,
    asked: Mutex<Vec<ConfirmationRequest>>,
    asking: Notify,
    answering: Notify,
}

impl Person {
    pub(crate) fn approving() -> Arc<Self> {
        Self::new(false)
    }

    /// Says yes only once [`Person::answer`] lets her.
    pub(crate) fn holding() -> Arc<Self> {
        Self::new(true)
    }

    fn new(held: bool) -> Arc<Self> {
        Arc::new(Self {
            held,
            asked: Mutex::new(Vec::new()),
            asking: Notify::new(),
            answering: Notify::new(),
        })
    }

    pub(crate) fn asked(&self) -> Vec<ConfirmationRequest> {
        self.asked.lock().unwrap().clone()
    }

    /// Answered once she is asked.
    pub(crate) async fn being_asked(&self) {
        self.asking.notified().await;
    }

    pub(crate) fn answer(&self) {
        self.answering.notify_one();
    }
}

#[async_trait]
impl Confirmer for Person {
    async fn confirm(&self, request: ConfirmationRequest) -> ConfirmationDecision {
        self.asked.lock().unwrap().push(request);
        self.asking.notify_one();

        if self.held {
            self.answering.notified().await;
        }

        ConfirmationDecision::Approved
    }
}

/// The text of `file`, none while there is no such file.
pub(crate) fn text_of(file: &Path) -> Option<String> {
    read_file(file)
        .ok()
        .map(|bytes| String::from_utf8(bytes).unwrap())
}

/// Replaces `file` with `text`, as a person editing it would.
pub(crate) fn rewrite(file: &Path, text: &str) {
    create_directories(file.parent().unwrap()).unwrap();
    write_file_atomically(file, text.as_bytes()).unwrap();
}

pub(crate) fn delete(file: &Path) {
    remove_file(file).unwrap();
}

/// The plugin of the daemon's list under `id`.
pub(crate) fn bundled(id: &str) -> &'static (Manifest, SetupCheck, PluginFactory) {
    list::plugins()
        .unwrap()
        .iter()
        .find(|(manifest, ..)| manifest.id().as_str() == id)
        .unwrap()
}

/// `change` as a change of Mira's own settings.
fn config_change(change: &FieldChange) -> ConfigChange {
    let (id, field) = (change.plugin.to_string(), change.field.to_string());

    ConfigChange {
        target: ConfigTarget::Character {
            character_id: "mira".to_owned(),
        },
        expected_fingerprint: change.expected_fingerprint.clone(),
        operation: match &change.value {
            Some(value) => Operation::SectionFieldSet {
                namespace: Namespace::Plugins,
                id,
                field,
                value: value.clone(),
            },
            None => Operation::SectionFieldUnset {
                namespace: Namespace::Plugins,
                id,
                field,
            },
        },
    }
}

/// Mira's settings as her daemon hands them to her host.
#[derive(Debug)]
struct MiraSettings {
    home: Home,
    sections: Arc<Sections>,
}

impl MiraSettings {
    fn read<T>(&self, work: impl FnOnce(&Resolution<'_>) -> T) -> Result<T, ReadConfigError> {
        let discovery = discover(self.home.root());
        let resolution =
            Resolution::character(&self.home, &self.sections, discovery.find("mira").unwrap())
                .map_err(|error| ReadConfigError {
                    sentence: error.to_string(),
                })?;

        Ok(work(&resolution))
    }
}

impl ConfigControl for MiraSettings {
    fn inspect(&self, plugin: &Identifier) -> Result<PluginSettings, ReadConfigError> {
        self.read(|resolution| {
            let section = resolution
                .section_view(Namespace::Plugins, plugin.as_str())
                .unwrap();
            let Value::Object(section) = serde_json::to_value(&section).unwrap() else {
                panic!("a section is an object");
            };

            PluginSettings {
                fingerprint: resolution.fingerprint().clone(),
                section,
            }
        })
    }

    fn check(&self, change: &FieldChange) -> Result<(), String> {
        match check_change(
            &self.sections,
            &discover(self.home.root()),
            &config_change(change),
        ) {
            Some(ChangeOutcome::Refused { message, .. } | ChangeOutcome::Failed { message }) => {
                Err(message)
            }
            Some(ChangeOutcome::Applied { .. }) | None => Ok(()),
        }
    }

    fn change(&self, change: &FieldChange) -> FieldChangeOutcome {
        let outcome = apply_change(
            &self.home,
            &self.sections,
            &discover(self.home.root()),
            &config_change(change),
            SETTINGS_WAIT,
        );

        match outcome {
            ChangeOutcome::Applied { fingerprint } => FieldChangeOutcome::Applied { fingerprint },
            ChangeOutcome::Refused {
                reason: ChangeRefusal::Conflict,
                ..
            } => FieldChangeOutcome::Conflict,
            ChangeOutcome::Refused { message, .. } => FieldChangeOutcome::Refused { message },
            ChangeOutcome::Failed { message } => FieldChangeOutcome::Failed { message },
        }
    }

    fn activations(&self) -> Result<Vec<(Identifier, ActivationStatus)>, ReadConfigError> {
        self.read(|resolution| {
            list::plugins()
                .unwrap()
                .iter()
                .map(|(manifest, ..)| {
                    let view = resolution
                        .section_view(Namespace::Plugins, manifest.id().as_str())
                        .unwrap();
                    (manifest.id().clone(), view.activation.status)
                })
                .collect()
        })
    }
}
