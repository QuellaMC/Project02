//! The settings of the character a host serves, as the host's own plugin
//! reads and changes them: read as her settings screen reads them, and
//! changed in her own overlay through the one transaction of p02-config.

use std::sync::Arc;

use p02_characters::discover;
use p02_config::{
    ChangeOutcome, ChangeRefusal, ConfigChange, ConfigTarget, Namespace, Operation, Resolution,
    apply_change,
};
use p02_plugins::{
    ActivationStatus, ConfigControl, FieldChange, FieldChangeOutcome, PluginSettings,
    ReadConfigError,
};
use p02_shared::Identifier;
use serde_json::{Map, Value};

use crate::character::unresolved;
use crate::daemon::World;
use crate::outcome::sentence;

#[derive(Debug)]
pub(crate) struct CharacterConfig {
    world: Arc<World>,
    character: Identifier,
}

impl CharacterConfig {
    pub(crate) fn new(world: Arc<World>, character: Identifier) -> Self {
        Self { world, character }
    }

    /// What `work` makes of her settings as the disk holds them now.
    fn read<T>(&self, work: impl FnOnce(&Resolution<'_>) -> T) -> Result<T, ReadConfigError> {
        let discovery = discover(self.world.home.root());
        let definition = discovery
            .find(self.character.as_str())
            .map_err(|error| unreadable(sentence(&error)))?;
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

    fn change(&self, change: &FieldChange) -> FieldChangeOutcome {
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
        let outcome = apply_change(
            &self.world.home,
            &self.world.sections,
            &discover(self.world.home.root()),
            &ConfigChange {
                target: ConfigTarget::Character {
                    character_id: self.character.to_string(),
                },
                expected_fingerprint: expected_fingerprint.clone(),
                operation,
            },
            self.world.durations.settings_lock,
        );

        match outcome {
            ChangeOutcome::Applied { fingerprint } => FieldChangeOutcome::Applied {
                fingerprint,
                running: self
                    .read(|resolution| running(resolution, plugin))
                    .ok()
                    .flatten(),
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
