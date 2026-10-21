//! The one way a settings document is written: under the locks of every
//! document its writer reads, read again once they are held, and replaced
//! whole.

use std::path::Path;
use std::time::Duration;

use p02_shared::{Identifier, write_file_atomically};
use p02_store::{CharacterData, Home, SettingsDocument, StorageError};
use serde_json::{Map, Value};

use crate::document::encode;
use crate::resolve::{Overlay, Written, WrittenOverlay};

/// Runs `work` on the home's document, holding its lock, and releases the
/// lock whatever `work` comes to. A lock another writer holds is waited for
/// while it changes hands, and given up after `wait` without a change.
pub(crate) fn with_home<T>(
    home: &Home,
    wait: Duration,
    work: impl FnOnce(Written) -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    locked(home, &[SettingsDocument::Home], wait, || {
        work(Written::read(home)?)
    })
}

/// Runs `work` on the home's document and `character`'s overlay, holding
/// the lock of each, since a change to her settings is judged over the
/// home's; as [`with_home`] otherwise.
pub(crate) fn with_character<T>(
    home: &Home,
    character: &Identifier,
    wait: Duration,
    work: impl FnOnce(Written, WrittenOverlay) -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    locked(
        home,
        &[SettingsDocument::Home, SettingsDocument::Overlay(character)],
        wait,
        || work(Written::read(home)?, WrittenOverlay::read(home, character)?),
    )
}

/// The locks are taken in one order, the store's, so two writers never
/// wait on each other.
fn locked<T>(
    home: &Home,
    documents: &[SettingsDocument<'_>],
    wait: Duration,
    work: impl FnOnce() -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    home.check()?;

    let lease = home.lock_settings(documents, wait)?;
    let result = work();

    lease.release();
    result
}

/// Replaces the document at `path` with `document`, owner-only and whole.
/// The caller holds its lock, and for a character's overlay has made her
/// data directory.
pub(crate) fn write(path: &Path, document: &Map<String, Value>) -> Result<(), StorageError> {
    write_file_atomically(path, &encode(document)).map_err(|source| StorageError::Write {
        path: path.to_path_buf(),
        source,
    })
}

/// Makes her overlay's file hold what her settings are read from, under
/// the locks of [`with_character`]: her data directory made first, as her
/// first start makes it; the file replaced unless it holds that already;
/// and then the version of her package whose settings it now holds
/// recorded, so a crash between the two merges again what is still
/// missing.
pub(crate) fn settle(home: &Home, overlay: &mut Overlay) -> Result<CharacterData, StorageError> {
    let mut data = CharacterData::ensure(home, &overlay.character)?;

    if overlay.read.raw() != overlay.written.raw() {
        write(&overlay.path, overlay.read.raw())?;
        overlay.written = overlay.read.clone();
    }

    if let Some(version) = overlay.merges.take()
        && data.package_version() != Some(&version)
    {
        data.record_package_version(version)?;
    }

    Ok(data)
}
