//! The home: a folder the daemon serves from, marked by its `schema.json`.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use p02_characters::HOME_PACKAGES;
use p02_core::Timestamp;
use p02_shared::{
    DAEMON_RECORD_FILE, Identifier, PathEntry, create_directories, describe_entry, list_directory,
    temporary_target,
};

use crate::daemon::DaemonLease;
use crate::error::StorageError;
use crate::layout::{
    CHARACTER_DATA_DIRECTORY, CONFIG_FILE, CONVERSATIONS_DIRECTORY, EntryKind, LOCKS_DIRECTORY,
    SCHEMA_FILE,
};
use crate::lock::{Lease, Resource, acquire};
use crate::marker::{self, Marker, Scope};

/// A home, spelled from its canonical root: every path below it is made
/// from that one spelling, so one file has one name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Home {
    root: PathBuf,
}

/// One of a home's settings documents: its own `config.json`, or the
/// overlay `config.json` in a character's data directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsDocument<'a> {
    Home,
    Overlay(&'a Identifier),
}

impl Home {
    /// The home at `root`, which the caller has made canonical.
    #[must_use]
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn locks_root(&self) -> PathBuf {
        self.root.join(LOCKS_DIRECTORY)
    }

    pub(crate) fn character_data_root(&self) -> PathBuf {
        self.root.join(CHARACTER_DATA_DIRECTORY)
    }

    pub(crate) fn conversations_root(&self) -> PathBuf {
        self.root.join(CONVERSATIONS_DIRECTORY)
    }

    pub(crate) fn data_root(&self, character: &Identifier) -> PathBuf {
        self.character_data_root().join(character.as_str())
    }

    /// Where `document` is, whether or not it exists yet.
    #[must_use]
    pub fn settings_path(&self, document: SettingsDocument<'_>) -> PathBuf {
        match document {
            SettingsDocument::Home => self.root.join(CONFIG_FILE),
            SettingsDocument::Overlay(character) => self.data_root(character).join(CONFIG_FILE),
        }
    }

    /// Holds `documents` for their holder to read and replace: every writer
    /// of a settings document holds its lock, and one that reads a document
    /// to write another holds both. The locks live in the home's own
    /// `.locks`, so a character's overlay is held before her data directory
    /// exists. A lock another holds is waited for while it changes hands,
    /// and given up after `wait` without a change.
    ///
    /// # Errors
    ///
    /// [`StorageError::Busy`] when a lock is not had in time, or
    /// [`StorageError::Write`] when the lock file cannot be made.
    pub fn lock_settings(
        &self,
        documents: &[SettingsDocument<'_>],
        wait: Duration,
    ) -> Result<Lease, StorageError> {
        let paths: Vec<PathBuf> = documents
            .iter()
            .map(|document| self.settings_path(*document))
            .collect();
        let resources: Vec<Resource<'_>> = paths
            .iter()
            .map(|path| Resource::SettingsDocument { path, wait })
            .collect();
        let root = self.locks_root();
        let targets: Vec<(&Path, &Resource<'_>)> = resources
            .iter()
            .map(|resource| (root.as_path(), resource))
            .collect();

        acquire(&targets)
    }

    /// Refuses, writing nothing, a folder that is no home and could not be
    /// made one: one marked as something else; one with no marker that lies
    /// inside a character's data, or holds history or anything else a home
    /// does not hold before its marker; or one whose control entries are not
    /// the real files and directories a home's state lives in, since a link
    /// would carry that state outside it. Every way into a home asks this
    /// first. The folder is judged from one listing of it: by its marker
    /// when the listing holds one, else by what lies there, so a marker
    /// written as the folder is judged, by a character's first data, never
    /// reads as a foreign file.
    ///
    /// # Errors
    ///
    /// [`StorageError`] naming the first refusal.
    pub fn check(&self) -> Result<(), StorageError> {
        let entries = match list_directory(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(source) => {
                return Err(StorageError::Read {
                    path: self.root.clone(),
                    source,
                });
            }
        };

        if entries
            .iter()
            .any(|(name, _)| name.as_os_str() == OsStr::new(SCHEMA_FILE))
        {
            return match marker::read(&self.root)? {
                Some(Marker::Home { .. }) => self.check_control_entries(),
                Some(Marker::CharacterData { .. }) => Err(StorageError::WrongScope {
                    path: self.root.clone(),
                    found: Scope::CharacterData,
                }),
                // Listed and gone since: judged again by what is there now.
                None => self.check(),
            };
        }

        self.check_outside_character_data()?;
        self.check_unmarked(entries)
    }

    /// Makes the folder a home, or adopts the home it is: the refusals of
    /// [`Home::check`], then the marker, written under its lock, and the
    /// character data directory every character's data lives in.
    ///
    /// # Errors
    ///
    /// [`StorageError`] for a refusal, or for a write that failed.
    pub fn ensure(&self) -> Result<(), StorageError> {
        self.check()?;

        let data_root = self.character_data_root();

        create_directories(&data_root).map_err(StorageError::write(&data_root))?;

        match marker::ensure(
            &self.root,
            Marker::Home {
                created_at: Timestamp::now(),
            },
            || self.check(),
        )? {
            Marker::Home { .. } => Ok(()),
            Marker::CharacterData { .. } => Err(StorageError::WrongScope {
                path: self.root.clone(),
                found: Scope::CharacterData,
            }),
        }
    }

    /// The one daemon's lease on the home, refused at once while another
    /// process serves it: its holder alone writes the daemon record.
    ///
    /// # Errors
    ///
    /// [`StorageError::Busy`] while another daemon holds it, or another
    /// refusal of [`Home::check`].
    pub fn daemon_lease(&self) -> Result<DaemonLease, StorageError> {
        self.check()?;

        let lease = acquire(&[(&self.locks_root(), &Resource::Daemon)])?;

        Ok(DaemonLease::new(self.clone(), lease))
    }

    /// A folder inside a character's data is hers, whatever it holds: the
    /// nearest marker above it says so, hers, or a home's whose character
    /// data it lies in. A path that merely runs through a folder named
    /// `character-data` is no such folder.
    fn check_outside_character_data(&self) -> Result<(), StorageError> {
        for above in self.root.ancestors().skip(1) {
            let data = match marker::read(above) {
                Ok(Some(Marker::CharacterData { .. })) => above.to_path_buf(),
                Ok(Some(Marker::Home { .. })) => above.join(CHARACTER_DATA_DIRECTORY),
                // A folder above that is no store, or whose marker cannot be
                // read, says nothing of this one.
                Ok(None) | Err(_) => continue,
            };

            return if self.root.starts_with(&data) {
                Err(StorageError::InsideCharacterData {
                    path: self.root.clone(),
                    data,
                })
            } else {
                Ok(())
            };
        }

        Ok(())
    }

    fn check_unmarked(&self, entries: Vec<(OsString, PathEntry)>) -> Result<(), StorageError> {
        for (name, entry) in entries {
            if !self.belongs_before_its_marker(&name, &entry)? {
                return Err(StorageError::UnmarkedHome {
                    path: self.root.clone(),
                    entry: name.to_string_lossy().into_owned(),
                });
            }
        }

        Ok(())
    }

    /// What a home holds before its marker is written: its settings, the
    /// daemon's record, its locks, the character packages its person added,
    /// which may be linked in, its characters' data, each of whose
    /// directories is vouched for by a marker of its own and judged when she
    /// is reached, so that damage there fails her alone, the directory its
    /// conversations go in while it is still empty, and what a writer of a
    /// control file left when it died.
    fn belongs_before_its_marker(
        &self,
        name: &OsStr,
        entry: &PathEntry,
    ) -> Result<bool, StorageError> {
        let Some(name) = name.to_str() else {
            return Ok(false);
        };

        Ok(match name {
            LOCKS_DIRECTORY | CHARACTER_DATA_DIRECTORY => matches!(entry, PathEntry::Directory),
            CONVERSATIONS_DIRECTORY => {
                let path = self.root.join(name);

                matches!(entry, PathEntry::Directory)
                    && list_directory(&path)
                        .map_err(StorageError::read(&path))?
                        .is_empty()
            }
            HOME_PACKAGES => matches!(entry, PathEntry::Directory | PathEntry::Link),
            CONFIG_FILE | DAEMON_RECORD_FILE => matches!(entry, PathEntry::File),
            _ => {
                matches!(entry, PathEntry::File)
                    && temporary_target(name.as_ref()).is_some_and(|target| {
                        [SCHEMA_FILE, CONFIG_FILE, DAEMON_RECORD_FILE].contains(&target)
                    })
            }
        })
    }

    fn check_control_entries(&self) -> Result<(), StorageError> {
        for (name, expected) in [
            (CHARACTER_DATA_DIRECTORY, EntryKind::Directory),
            (CONVERSATIONS_DIRECTORY, EntryKind::Directory),
            (LOCKS_DIRECTORY, EntryKind::Directory),
            (CONFIG_FILE, EntryKind::File),
            (DAEMON_RECORD_FILE, EntryKind::File),
        ] {
            check_real(&self.root.join(name), expected)?;
        }

        Ok(())
    }
}

/// Refuses an entry that is there but is not a real file or directory, as
/// `expected` says; one that is absent is not refused.
pub(crate) fn check_real(path: &Path, expected: EntryKind) -> Result<(), StorageError> {
    let real = match describe_entry(path) {
        PathEntry::Absent => true,
        PathEntry::Directory => expected == EntryKind::Directory,
        PathEntry::File => expected == EntryKind::File,
        PathEntry::Link | PathEntry::Other => false,
        PathEntry::Unreadable(source) => {
            return Err(StorageError::Read {
                path: path.to_path_buf(),
                source,
            });
        }
    };

    if real {
        Ok(())
    } else {
        Err(StorageError::NotReal {
            path: path.to_path_buf(),
            expected,
        })
    }
}
