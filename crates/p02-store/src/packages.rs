//! A character's package in the home, `characters/<id>/`, as a person adds,
//! updates or removes her: her descriptor written whole or removed while
//! the locks a settings write for her takes are held, and never through a
//! link.

use std::ffi::OsStr;
use std::path::PathBuf;
use std::time::Duration;

use p02_characters::{HOME_PACKAGES, PACKAGE_DESCRIPTOR};
use p02_shared::{
    Identifier, PathEntry, create_directories, describe_entry, list_directory, remove_directory,
    remove_file, temporary_target, write_file_atomically,
};

use crate::error::StorageError;
use crate::home::{Home, SettingsDocument, check_real};
use crate::layout::{EntryKind, FINDER_METADATA};

/// A character's package in the home while the locks of her settings are
/// held: the one way to write or remove it.
#[derive(Debug)]
pub struct HeldPackage {
    packages: PathBuf,
    folder: PathBuf,
    descriptor: PathBuf,
}

impl Home {
    /// Runs `work` on `character`'s package in the home, holding the locks
    /// a settings write for her takes, the home's document's and her
    /// overlay's, and releases them whatever `work` comes to: two windows,
    /// or an add and a removal, take turns, and what `work` reads of the
    /// home's packages stays so while it writes. A lock another holds is
    /// waited for as [`Home::lock_settings`] waits for it.
    ///
    /// # Errors
    ///
    /// [`StorageError`] when the home is refused or a lock is not had.
    pub fn with_package<T>(
        &self,
        character: &Identifier,
        wait: Duration,
        work: impl FnOnce(&HeldPackage) -> T,
    ) -> Result<T, StorageError> {
        self.check()?;

        let lease = self.lock_settings(
            &[SettingsDocument::Home, SettingsDocument::Overlay(character)],
            wait,
        )?;
        let packages = self.root().join(HOME_PACKAGES);
        let folder = packages.join(character.as_str());
        let done = work(&HeldPackage {
            descriptor: folder.join(PACKAGE_DESCRIPTOR),
            folder,
            packages,
        });

        lease.release();
        Ok(done)
    }
}

impl HeldPackage {
    /// Replaces her descriptor with `descriptor`, whole and owner-only,
    /// making her folder, and the home's folder of packages, where they are
    /// absent. A folder or a descriptor that is there but is no real one, a
    /// link among them, is refused, and nothing is written through it; her
    /// folder, made for a write that fails, is taken back.
    ///
    /// # Errors
    ///
    /// [`StorageError`] for an entry refused or a write that failed, her
    /// package as it was.
    pub fn write(&self, descriptor: &[u8]) -> Result<(), StorageError> {
        self.check_real()?;

        let made = matches!(describe_entry(&self.folder), PathEntry::Absent);

        create_directories(&self.folder).map_err(StorageError::write(&self.folder))?;

        if let Err(source) = write_file_atomically(&self.descriptor, descriptor) {
            if made {
                remove_directory(&self.folder).map_err(StorageError::write(&self.folder))?;
            }

            return Err(StorageError::Write {
                path: self.descriptor.clone(),
                source,
            });
        }

        Ok(())
    }

    /// Removes her descriptor, which removes her, and then her folder,
    /// unless it holds anything but what Finder, or a writer of her
    /// descriptor that died, left there: a folder holding anything else is
    /// left as it is. A link is refused as a write refuses it, so nothing
    /// outside her folder is touched.
    ///
    /// # Errors
    ///
    /// [`StorageError`] for an entry refused or a descriptor that could not
    /// be removed, her package as it was.
    pub fn remove(&self) -> Result<(), StorageError> {
        self.check_real()?;

        remove_file(&self.descriptor).map_err(StorageError::write(&self.descriptor))?;

        // She is gone with her descriptor. A folder that cannot be taken is
        // left, and discovery reports it as a package without one, so the
        // person sees it.
        if let Ok(entries) = list_directory(&self.folder)
            && entries.iter().all(|(name, entry)| leftover(name, entry))
        {
            for (name, _) in entries {
                let _ = remove_file(&self.folder.join(name));
            }

            let _ = remove_directory(&self.folder);
        }

        Ok(())
    }

    /// Refuses each entry from the home's folder of packages down to her
    /// descriptor that is there but is not the real directory or file it
    /// must be: a link would carry a write, or a removal, outside her
    /// folder.
    fn check_real(&self) -> Result<(), StorageError> {
        check_real(&self.packages, EntryKind::Directory)?;
        check_real(&self.folder, EntryKind::Directory)?;
        check_real(&self.descriptor, EntryKind::File)
    }
}

/// What a package folder may hold that is no part of the package: what
/// Finder leaves in every folder it shows, and the temporary a writer of
/// her descriptor that died left.
fn leftover(name: &OsStr, entry: &PathEntry) -> bool {
    matches!(entry, PathEntry::File)
        && (name == FINDER_METADATA || temporary_target(name) == Some(PACKAGE_DESCRIPTOR))
}
