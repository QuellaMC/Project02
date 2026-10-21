//! A character's data directory, `<home>/character-data/<id>/`: her
//! sessions and their catalog, the record of the lines her conversations
//! took, her locks, her settings overlay. Its marker names her; nothing in it
//! is read or written for anyone else.

use std::path::{Path, PathBuf};

use p02_characters::CharacterVersion;
use p02_core::Timestamp;
use p02_shared::{Identifier, PathEntry, create_directories, describe_entry, list_directory};

use crate::error::StorageError;
use crate::home::{Home, check_real};
use crate::layout::{
    CONFIG_FILE, EntryKind, LOCKS_DIRECTORY, SCHEMA_FILE, SESSION_CATALOG_FILE, SESSIONS_DIRECTORY,
    TAKEN_LINES_DIRECTORY,
};
use crate::marker::{self, Marker, Scope};
use p02_shared::temporary_target;

/// A character's data directory whose marker names her.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CharacterData {
    home: Home,
    character: Identifier,
    root: PathBuf,
    package_version: Option<CharacterVersion>,
}

impl CharacterData {
    /// The writer's way in: the character's data directory, adopted or
    /// made, and the home above it. Nothing is written for a directory
    /// that is refused, not even the home's marker.
    ///
    /// # Errors
    ///
    /// [`StorageError`] when the directory or the home is refused, as
    /// [`CharacterData::open`] and [`Home::check`] refuse them, or when a
    /// write fails.
    pub fn ensure(home: &Home, character: &Identifier) -> Result<Self, StorageError> {
        let root = data_root(home, character);

        if let Some(marker) = adoptable_marker(home, &root)? {
            Self::of_marker(home, character, root.clone(), marker)?;
        }

        home.ensure()?;
        create_directories(&root).map_err(StorageError::write(&root))?;

        let marker = marker::ensure(
            &root,
            Marker::CharacterData {
                character: character.clone(),
                created_at: Timestamp::now(),
                package_version: None,
            },
            || adoptable_marker(home, &root).map(drop),
        )?;

        Self::of_marker(home, character, root, marker)
    }

    /// The reader's way in: the character's data as it is, `None` while she
    /// has none, writing nothing. A directory without a marker is never
    /// adopted when it holds history or anything foreign, and one marked
    /// for another character is refused, naming her.
    ///
    /// # Errors
    ///
    /// [`StorageError`] for a refused directory: one marked as another
    /// character's or as something else, an unmarked one holding more than
    /// control files, a control entry that is not a real file or directory,
    /// or a marker of another schema version.
    pub fn open(home: &Home, character: &Identifier) -> Result<Option<Self>, StorageError> {
        let root = data_root(home, character);

        adoptable_marker(home, &root)?
            .map(|marker| Self::of_marker(home, character, root, marker))
            .transpose()
    }

    #[must_use]
    pub fn character(&self) -> &Identifier {
        &self.character
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The version of her package whose settings were last merged into her
    /// overlay; none before the first merge.
    #[must_use]
    pub fn package_version(&self) -> Option<&CharacterVersion> {
        self.package_version.as_ref()
    }

    /// Records that her overlay now holds the settings of package
    /// `version`. It is written after the overlay, so a crash between the
    /// two repeats a merge that only adds what is missing.
    ///
    /// # Errors
    ///
    /// [`StorageError`] when the directory is refused or the write fails.
    pub fn record_package_version(
        &mut self,
        version: CharacterVersion,
    ) -> Result<(), StorageError> {
        let marker = marker::update(
            &self.root,
            |current| match current {
                Marker::CharacterData {
                    character,
                    created_at,
                    ..
                } => Marker::CharacterData {
                    character,
                    created_at,
                    package_version: Some(version),
                },
                home @ Marker::Home { .. } => home,
            },
            || adoptable_marker(&self.home, &self.root).map(drop),
        )?;

        *self = Self::of_marker(&self.home, &self.character, self.root.clone(), marker)?;
        Ok(())
    }

    pub(crate) fn locks_root(&self) -> PathBuf {
        self.root.join(LOCKS_DIRECTORY)
    }

    pub(crate) fn catalog_path(&self) -> PathBuf {
        self.root.join(SESSION_CATALOG_FILE)
    }

    pub(crate) fn sessions_root(&self) -> PathBuf {
        self.root.join(SESSIONS_DIRECTORY)
    }

    pub(crate) fn taken_lines_root(&self) -> PathBuf {
        self.root.join(TAKEN_LINES_DIRECTORY)
    }

    fn of_marker(
        home: &Home,
        character: &Identifier,
        root: PathBuf,
        marker: Marker,
    ) -> Result<Self, StorageError> {
        match marker {
            Marker::CharacterData {
                character: holds,
                package_version,
                ..
            } if holds == *character => Ok(Self {
                home: home.clone(),
                character: holds,
                root,
                package_version,
            }),
            Marker::CharacterData {
                character: holds, ..
            } => Err(StorageError::CharacterMismatch {
                path: root,
                holds,
                requested: character.clone(),
            }),
            Marker::Home { .. } => Err(StorageError::WrongScope {
                path: root,
                found: Scope::Home,
            }),
        }
    }
}

fn data_root(home: &Home, character: &Identifier) -> PathBuf {
    home.character_data_root().join(character.as_str())
}

/// The marker of the data directory at `root` once the directory is known
/// to be one this store may read and write: real, with real control
/// entries, and, while unmarked, holding nothing but control files. `None`
/// for a directory that is absent, or unmarked and holding no history yet.
fn adoptable_marker(home: &Home, root: &Path) -> Result<Option<Marker>, StorageError> {
    check_real(&home.character_data_root(), EntryKind::Directory)?;

    match describe_entry(root) {
        PathEntry::Absent => return Ok(None),
        PathEntry::Directory => {}
        PathEntry::Unreadable(source) => {
            return Err(StorageError::Read {
                path: root.to_path_buf(),
                source,
            });
        }
        PathEntry::File | PathEntry::Link | PathEntry::Other => {
            return Err(StorageError::NotReal {
                path: root.to_path_buf(),
                expected: EntryKind::Directory,
            });
        }
    }

    for (name, expected) in [
        (LOCKS_DIRECTORY, EntryKind::Directory),
        (SESSIONS_DIRECTORY, EntryKind::Directory),
        (TAKEN_LINES_DIRECTORY, EntryKind::Directory),
        (SESSION_CATALOG_FILE, EntryKind::File),
        (CONFIG_FILE, EntryKind::File),
    ] {
        check_real(&root.join(name), expected)?;
    }

    if let Some(marker) = marker::read(root)? {
        return Ok(Some(marker));
    }

    match foreign_entry(root)? {
        None => Ok(None),
        // A sibling making the same character's directory may have written
        // its marker and its first session since the marker was read.
        Some(entry) => marker::read(root)?
            .map(Some)
            .ok_or_else(|| StorageError::UnmarkedData {
                path: root.to_path_buf(),
                entry,
            }),
    }
}

/// The first entry of an unmarked data directory that is more than the
/// control state a directory holds before its first session: the overlay,
/// the locks, an empty sessions directory, and what a writer of the marker
/// or the overlay left when it died.
fn foreign_entry(root: &Path) -> Result<Option<String>, StorageError> {
    let entries = list_directory(root).map_err(StorageError::read(root))?;

    for (name, _) in entries {
        let control = match name.to_str() {
            Some(CONFIG_FILE | LOCKS_DIRECTORY) => true,
            Some(SESSIONS_DIRECTORY) => list_directory(&root.join(SESSIONS_DIRECTORY))
                .map_err(StorageError::read(root.join(SESSIONS_DIRECTORY)))?
                .is_empty(),
            Some(name) => temporary_target(name.as_ref())
                .is_some_and(|target| [SCHEMA_FILE, CONFIG_FILE].contains(&target)),
            None => false,
        };

        if !control {
            return Ok(Some(name.to_string_lossy().into_owned()));
        }
    }

    Ok(None)
}
