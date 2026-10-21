//! The home: a folder the daemon serves from, marked by its `schema.json`.

use std::io;
use std::path::{Path, PathBuf};

use p02_characters::HOME_PACKAGES;
use p02_core::Timestamp;
use p02_shared::{
    DAEMON_RECORD_FILE, PathEntry, create_directories, describe_entry, list_directory,
    temporary_target,
};

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

    /// Refuses, writing nothing, a folder that is no home and could not be
    /// made one: one marked as something else; one with no marker holding
    /// anything but what a home holds; or one whose control entries are
    /// not the real files and directories a home's state lives in, since a
    /// link would carry that state outside it.
    ///
    /// # Errors
    ///
    /// [`StorageError`] naming the first refusal.
    pub fn check(&self) -> Result<(), StorageError> {
        match marker::read(&self.root)? {
            None => self.check_unmarked(),
            Some(Marker::Home { .. }) => self.check_control_entries(),
            Some(Marker::CharacterData { .. }) => Err(StorageError::WrongScope {
                path: self.root.clone(),
                found: Scope::CharacterData,
            }),
        }
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
    /// process serves it.
    ///
    /// # Errors
    ///
    /// [`StorageError::Busy`] while another daemon holds it, or another
    /// refusal of [`Home::check`].
    pub fn daemon_lease(&self) -> Result<Lease, StorageError> {
        self.check()?;
        acquire(&[(&self.locks_root(), &Resource::Daemon)])
    }

    fn check_unmarked(&self) -> Result<(), StorageError> {
        let entries = match list_directory(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(source) => {
                return Err(StorageError::Read {
                    path: self.root.clone(),
                    source,
                });
            }
        };

        for (name, entry) in entries {
            let belongs = name
                .to_str()
                .is_some_and(|name| belongs_in_a_new_home(name, &entry));

            if !belongs {
                return Err(StorageError::UnmarkedHome {
                    path: self.root.clone(),
                    entry: name.to_string_lossy().into_owned(),
                });
            }
        }

        Ok(())
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

/// What a home without a marker may hold: its control entries, the
/// character packages its person added, which may be linked in, and what a
/// writer of a control file left when it died before its marker.
fn belongs_in_a_new_home(name: &str, entry: &PathEntry) -> bool {
    match name {
        CHARACTER_DATA_DIRECTORY | CONVERSATIONS_DIRECTORY | LOCKS_DIRECTORY => {
            matches!(entry, PathEntry::Directory)
        }
        HOME_PACKAGES => matches!(entry, PathEntry::Directory | PathEntry::Link),
        CONFIG_FILE | DAEMON_RECORD_FILE => matches!(entry, PathEntry::File),
        _ => {
            matches!(entry, PathEntry::File)
                && temporary_target(name.as_ref()).is_some_and(|target| {
                    [SCHEMA_FILE, CONFIG_FILE, DAEMON_RECORD_FILE].contains(&target)
                })
        }
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
