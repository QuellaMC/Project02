//! A character added from a file, updated or removed while the daemon runs:
//! her file judged as discovery would publish it, her package written or
//! removed in the home under the locks of her settings, and then the change
//! of the roster announced and reconciled as a settings change is.

use std::sync::Arc;

use p02_characters::{CharacterDefinition, PluginExpectations, Standing, discover, is_bundled};
use p02_shared::{Identifier, error_sentence};
use p02_store::CharacterData;
use p02_wire::{
    AddCharacterOutcome, AddCharacterRefusal, CharacterFeature, CharacterInstalled,
    CharacterPreviewOutcome, CharacterPreviewRefusal, RemoveCharacterOutcome,
    RemoveCharacterRefusal,
};

use crate::character::CharacterHandle;
use crate::daemon::{Daemon, Plugin, World, blocking};
use crate::outcome::storage_failure;

impl Daemon {
    /// Who the character file `descriptor` holds and what adding her would
    /// do, judged as an add judges it. Nothing is written.
    pub async fn preview_character(&self, descriptor: Vec<u8>) -> CharacterPreviewOutcome {
        let world = Arc::clone(self.world());

        blocking(move || preview(&world, &descriptor)).await
    }

    /// Adds the character the file `descriptor` holds, or updates her when
    /// her package is installed: judged afresh, never by an earlier
    /// preview, and written as the file holds it, so that the package on
    /// disk is one discovery publishes. Once it lands, health goes to every
    /// surface and a reconcile pass starts her as any enabled character, a
    /// running one updated stopped first, so she starts again from her new
    /// package. On the blocking pool, so a caller that stops waiting leaves
    /// nothing of it undone.
    pub async fn add_character(&self, descriptor: Vec<u8>) -> AddCharacterOutcome {
        let daemon = self.clone();

        blocking(move || daemon.add_now(&descriptor)).await
    }

    /// Removes the package of `character`, a character a person added: her
    /// descriptor, and her folder when nothing else is left in it. Her data
    /// stays, so adding her again brings back her chats, her memories and
    /// her settings. Once it lands, health goes to every surface and a
    /// reconcile pass stops her if she runs.
    pub async fn remove_character(&self, character: &str) -> RemoveCharacterOutcome {
        let daemon = self.clone();
        let character = character.to_owned();

        blocking(move || daemon.remove_now(&character)).await
    }

    fn add_now(&self, descriptor: &[u8]) -> AddCharacterOutcome {
        let refused = |reason, message| AddCharacterOutcome::Refused { reason, message };
        let world = self.world();
        let character = match offered(descriptor) {
            Ok(character) => character,
            Err(message) => return refused(AddCharacterRefusal::Invalid, message),
        };
        let id = character.profile.id.clone();
        let added = world
            .home
            .with_package(
                &id,
                world.durations.settings_lock,
                |package| match standing(world, &character) {
                    Err(message) => refused(AddCharacterRefusal::Invalid, message),
                    Ok(Standing::BuiltIn) => refused(
                        AddCharacterRefusal::BuiltIn,
                        "This character comes with the app, so a file cannot add or change her."
                            .to_owned(),
                    ),
                    Ok(standing) => match package.write(descriptor) {
                        Ok(()) if standing == Standing::New => AddCharacterOutcome::Added {
                            character_id: id.clone(),
                        },
                        Ok(()) => AddCharacterOutcome::Updated {
                            character_id: id.clone(),
                        },
                        Err(error) => AddCharacterOutcome::Failed(storage_failure(&error)),
                    },
                },
            )
            .unwrap_or_else(|error| AddCharacterOutcome::Failed(storage_failure(&error)));

        match added {
            AddCharacterOutcome::Added { .. } => self.roster_changed(None),
            AddCharacterOutcome::Updated { .. } => self.roster_changed(self.live(&id)),
            AddCharacterOutcome::Refused { .. } | AddCharacterOutcome::Failed(_) => {}
        }

        added
    }

    fn remove_now(&self, character: &str) -> RemoveCharacterOutcome {
        let refused = |reason, message| RemoveCharacterOutcome::Refused { reason, message };
        let unknown = || {
            refused(
                RemoveCharacterRefusal::UnknownCharacter,
                format!("No character \"{character}\" is here to remove."),
            )
        };
        let world = self.world();
        let Ok(id) = Identifier::new(character) else {
            return unknown();
        };
        let removed = world
            .home
            .with_package(&id, world.durations.settings_lock, |package| {
                if discover(world.home.root()).find(id.as_str()).is_err() {
                    unknown()
                } else if is_bundled(&id) {
                    refused(
                        RemoveCharacterRefusal::BuiltIn,
                        "This character comes with the app, so she cannot be removed. Switch \
                         her off in her settings instead."
                            .to_owned(),
                    )
                } else {
                    match package.remove() {
                        Ok(()) => RemoveCharacterOutcome::Removed,
                        Err(error) => RemoveCharacterOutcome::Failed(storage_failure(&error)),
                    }
                }
            })
            .unwrap_or_else(|error| RemoveCharacterOutcome::Failed(storage_failure(&error)));

        if matches!(removed, RemoveCharacterOutcome::Removed) {
            self.roster_changed(None);
        }

        removed
    }

    /// Health as it now stands to every surface, and a reconcile pass
    /// behind the answer, on a task of its own, `restarted` stopped first
    /// so that the pass starts her again: the turn in flight finishes, and
    /// the lines behind it wait for her new start. It waits on the disk.
    fn roster_changed(&self, restarted: Option<Arc<CharacterHandle>>) {
        let daemon = self.clone();

        self.announce_health();
        tokio::spawn(async move {
            if let Some(handle) = restarted {
                handle.stop().await;
            }

            daemon.reconcile().await;
        });
    }
}

fn preview(world: &World, descriptor: &[u8]) -> CharacterPreviewOutcome {
    let refused = |message| CharacterPreviewOutcome::Refused {
        reason: CharacterPreviewRefusal::Invalid,
        message,
    };
    let character = match offered(descriptor) {
        Ok(character) => character,
        Err(message) => return refused(message),
    };
    let installed = match standing(world, &character) {
        Ok(Standing::New) => CharacterInstalled::None,
        Ok(Standing::Same) => CharacterInstalled::Same,
        Ok(Standing::OtherVersion) => CharacterInstalled::OtherVersion,
        Ok(Standing::BuiltIn) => CharacterInstalled::BuiltIn,
        Err(message) => return refused(message),
    };

    CharacterPreviewOutcome::Ok {
        has_data: CharacterData::exists(&world.home, &character.profile.id),
        comes_with: comes_with(world, &character.plugins),
        id: character.profile.id,
        display_name: character.profile.display_name,
        version: character.version.to_string(),
        about: character.about,
        installed,
    }
}

/// The character the file `descriptor` holds, or the rule it breaks in
/// plain words.
fn offered(descriptor: &[u8]) -> Result<CharacterDefinition, String> {
    CharacterDefinition::from_descriptor(descriptor).map_err(|error| error.plainly().to_owned())
}

/// Where `character` would stand among the home's packages as the disk
/// holds them now, or why she would not be published from her folder.
fn standing(world: &World, character: &CharacterDefinition) -> Result<Standing, String> {
    discover(world.home.root())
        .standing(character)
        .map_err(|taken| error_sentence(&taken))
}

/// What a character expecting `expected` would start with: each plugin of
/// this build that is on by default or that her package asks for, in the
/// plugin list's order, by the name a page shows; then, by id, each one it
/// asks for that this build does not have.
fn comes_with(world: &World, expected: &PluginExpectations) -> Vec<CharacterFeature> {
    let asked: Vec<&Identifier> = expected
        .required()
        .iter()
        .chain(expected.recommended())
        .collect();
    let mut features: Vec<CharacterFeature> = world
        .plugins
        .iter()
        .map(Plugin::manifest)
        .filter(|manifest| {
            manifest.activation().default_enabled() || asked.contains(&manifest.id())
        })
        .map(|manifest| CharacterFeature::Plugin {
            id: manifest.id().clone(),
            display_name: manifest.display_name().to_owned(),
        })
        .collect();

    for id in asked {
        let unknown = CharacterFeature::Unknown { id: id.clone() };

        if world.plugin(id).is_none() && !features.contains(&unknown) {
            features.push(unknown);
        }
    }

    features
}
