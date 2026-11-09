//! A character's data directory, `<home>/character-data/<id>/`: her
//! sessions and their catalog, the record of the lines her conversations
//! took, her plugins' data, her locks, her settings overlay, and her
//! marker.

use std::path::{Path, PathBuf};

use p02_characters::CharacterVersion;
use p02_core::Timestamp;
use p02_shared::{Identifier, create_directories};

use crate::error::StorageError;
use crate::home::{Home, check_real};
use crate::layout::{
    CONFIG_FILE, EntryKind, LOCKS_DIRECTORY, PLUGIN_DATA_DIRECTORY, SESSION_CATALOG_FILE,
    SESSIONS_DIRECTORY, TAKEN_LINES_DIRECTORY,
};
use crate::marker::{self, Marker, Scope};

/// A character's data directory, marked as one.
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
        let root = home.data_root(character);

        home.check()?;

        if let Some(marker) = checked_marker(home, &root)? {
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
            || checked_marker(home, &root).map(drop),
        )?;

        Self::of_marker(home, character, root, marker)
    }

    /// The reader's way in: the character's data as it is, `None` while
    /// her directory has no marker yet, writing nothing. The home is judged
    /// first, as [`Home::check`] judges it.
    ///
    /// # Errors
    ///
    /// [`StorageError`] for a refused home, or a refused directory: one
    /// marked as a home, a control entry that is not a real file or
    /// directory, or a marker that is malformed or a newer build's.
    pub fn open(home: &Home, character: &Identifier) -> Result<Option<Self>, StorageError> {
        let root = home.data_root(character);

        home.check()?;
        checked_marker(home, &root)?
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
            || checked_marker(&self.home, &self.root).map(drop),
        )?;

        *self = Self::of_marker(&self.home, &self.character, self.root.clone(), marker)?;
        Ok(())
    }

    pub(crate) fn home(&self) -> &Home {
        &self.home
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

    /// Where a plugin's own data lives in hers, `plugin-data/<plugin>/`.
    pub(crate) fn plugin_root(&self, plugin: &Identifier) -> PathBuf {
        self.root.join(PLUGIN_DATA_DIRECTORY).join(plugin.as_str())
    }

    /// [`CharacterData::plugin_root`], once it and the directory above it
    /// are known to be real directories, or not there yet: a link would
    /// carry the plugin's data outside hers.
    pub(crate) fn checked_plugin_root(&self, plugin: &Identifier) -> Result<PathBuf, StorageError> {
        let root = self.plugin_root(plugin);

        check_real(&self.root.join(PLUGIN_DATA_DIRECTORY), EntryKind::Directory)?;
        check_real(&root, EntryKind::Directory)?;
        Ok(root)
    }

    fn of_marker(
        home: &Home,
        character: &Identifier,
        root: PathBuf,
        marker: Marker,
    ) -> Result<Self, StorageError> {
        match marker {
            Marker::CharacterData {
                package_version, ..
            } => Ok(Self {
                home: home.clone(),
                character: character.clone(),
                root,
                package_version,
            }),
            Marker::Home { .. } => Err(StorageError::WrongScope {
                path: root,
                found: Scope::Home,
            }),
        }
    }
}

/// The marker of the data directory at `root`, `None` while it has none,
/// once it and its control entries are known to be real: a link there
/// would carry her state outside it.
fn checked_marker(home: &Home, root: &Path) -> Result<Option<Marker>, StorageError> {
    check_real(&home.character_data_root(), EntryKind::Directory)?;
    check_real(root, EntryKind::Directory)?;

    for (name, expected) in [
        (LOCKS_DIRECTORY, EntryKind::Directory),
        (SESSIONS_DIRECTORY, EntryKind::Directory),
        (TAKEN_LINES_DIRECTORY, EntryKind::Directory),
        (PLUGIN_DATA_DIRECTORY, EntryKind::Directory),
        (SESSION_CATALOG_FILE, EntryKind::File),
        (CONFIG_FILE, EntryKind::File),
    ] {
        check_real(&root.join(name), expected)?;
    }

    marker::read(root)
}
