//! The settings of the character a host serves, as the host's own plugin
//! reads and changes them: read as her settings screen reads them, and
//! changed in her own overlay through the daemon's one change of settings.

use std::sync::Arc;

use p02_characters::discover;
use p02_config::{
    ChangeOutcome, ChangeRefusal, ConfigChange, ConfigTarget, Namespace, Operation, Resolution,
    check_change,
};
use p02_plugins::{
    ActivationStatus, ConfigControl, FieldChange, FieldChangeOutcome, PluginSettings,
    ReadConfigError,
};
use p02_shared::{Identifier, error_sentence};
use serde_json::Value;

use crate::character::unresolved;
use crate::daemon::{WeakDaemon, World};

#[derive(Debug)]
pub(crate) struct CharacterConfig {
    world: Arc<World>,
    daemon: WeakDaemon,
    character: Identifier,
}

impl CharacterConfig {
    pub(crate) fn new(world: Arc<World>, daemon: WeakDaemon, character: Identifier) -> Self {
        Self {
            world,
            daemon,
            character,
        }
    }

    /// What `work` makes of her settings as the disk holds them now.
    fn read<T>(&self, work: impl FnOnce(&Resolution<'_>) -> T) -> Result<T, ReadConfigError> {
        let discovery = discover(self.world.home.root());
        let definition = discovery
            .find(self.character.as_str())
            .map_err(|error| unreadable(error_sentence(&error)))?;
        let resolution = Resolution::character(&self.world.home, &self.world.sections, definition)
            .map_err(|error| unreadable(unresolved(&self.character, error)))?;

        Ok(work(&resolution))
    }

    /// `change` as a change of her own settings.
    fn config_change(&self, change: &FieldChange) -> ConfigChange {
        let (id, field) = (change.plugin.to_string(), change.field.to_string());

        ConfigChange {
            target: ConfigTarget::Character {
                character_id: self.character.to_string(),
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
}

impl ConfigControl for CharacterConfig {
    fn inspect(&self, plugin: &Identifier) -> Result<PluginSettings, ReadConfigError> {
        self.read(|resolution| {
            let section = resolution
                .section_view(Namespace::Plugins, plugin.as_str())
                .map(|section| serde_json::to_value(&section));

            match section {
                Some(Ok(Value::Object(section))) => Ok(PluginSettings {
                    fingerprint: resolution.fingerprint().clone(),
                    section,
                }),
                _ => Err(unreadable(format!(
                    "Her settings show no section of plugin \"{plugin}\"."
                ))),
            }
        })?
    }

    fn check(&self, change: &FieldChange) -> Result<(), String> {
        match check_change(
            &self.world.sections,
            &discover(self.world.home.root()),
            &self.config_change(change),
        ) {
            Some(ChangeOutcome::Refused { message, .. } | ChangeOutcome::Failed { message }) => {
                Err(message)
            }
            Some(ChangeOutcome::Applied { .. }) | None => Ok(()),
        }
    }

    fn change(&self, change: &FieldChange) -> FieldChangeOutcome {
        let Some(daemon) = self.daemon.upgrade() else {
            return FieldChangeOutcome::Failed {
                message: "The daemon is stopped.".to_owned(),
            };
        };

        match daemon.change_settings(&self.config_change(change)) {
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
            self.world
                .plugins
                .iter()
                .filter_map(|plugin| {
                    let id = plugin.manifest().id();
                    let view = resolution.section_view(Namespace::Plugins, id.as_str())?;
                    let status = match view.activation_status() {
                        p02_config::ActivationStatus::Active => ActivationStatus::Active,
                        p02_config::ActivationStatus::Disabled => ActivationStatus::Disabled,
                        p02_config::ActivationStatus::Blocked => ActivationStatus::Blocked,
                    };

                    Some((id.clone(), status))
                })
                .collect()
        })
    }
}

fn unreadable(sentence: String) -> ReadConfigError {
    ReadConfigError { sentence }
}
