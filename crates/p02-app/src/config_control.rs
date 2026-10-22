//! The settings of the character a host serves, as the host's own plugin
//! reads and changes them: read as her settings screen reads them, and
//! changed in her own overlay through the daemon's one change of settings.

use std::sync::Arc;

use p02_characters::discover;
use p02_config::{
    ChangeOutcome, ChangeRefusal, ConfigChange, ConfigTarget, Namespace, Operation, Resolution,
};
use p02_plugins::{
    ActivationStatus, ConfigControl, FieldChange, FieldChangeOutcome, PluginSettings,
    ReadConfigError, Rebuild,
};
use p02_shared::{Identifier, error_sentence};
use serde_json::{Map, Value};

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

    fn change(&self, change: &FieldChange, rebuild: Option<Rebuild<'_>>) -> FieldChangeOutcome {
        let FieldChange {
            plugin,
            field,
            value,
            expected_fingerprint,
        } = change;
        let (id, field) = (plugin.to_string(), field.to_string());
        let operation = match value {
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
        };
        let Some(daemon) = self.daemon.upgrade() else {
            return FieldChangeOutcome::Failed {
                message: "The daemon is stopped.".to_owned(),
            };
        };
        let mut rebuild_outcome = None;
        let outcome = daemon.change_settings(
            &ConfigChange {
                target: ConfigTarget::Character {
                    character_id: self.character.to_string(),
                },
                expected_fingerprint: expected_fingerprint.clone(),
                operation,
            },
            || {
                // Her plugin runs what her settings now say before the
                // change is announced and judged, so the pass that follows
                // finds nothing of hers to reload.
                if let Some(rebuild) = rebuild {
                    rebuild_outcome = match self.read(|resolution| running(resolution, plugin)) {
                        Ok(Some(values)) => Some(rebuild(&values)),
                        Ok(None) => None,
                        Err(error) => Some(Err(error.sentence)),
                    };
                }
            },
        );

        match outcome {
            ChangeOutcome::Applied { fingerprint } => FieldChangeOutcome::Applied {
                fingerprint,
                rebuilt: rebuild_outcome,
            },
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

/// The values her settings give `plugin` while they run it.
fn running(resolution: &Resolution<'_>, plugin: &Identifier) -> Option<Map<String, Value>> {
    resolution
        .settings()
        .plugins()
        .find(|(running, _)| *running == plugin)
        .map(|(_, values)| values.clone())
}

fn unreadable(sentence: String) -> ReadConfigError {
    ReadConfigError { sentence }
}
