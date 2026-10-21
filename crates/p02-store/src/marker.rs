//! `schema.json`, the marker that makes a directory a home or a
//! character's data directory: what it vouches for, at which version of the
//! store, since when. Without it nothing below is read or written; with any
//! other version, nothing is either.

use std::path::Path;

use p02_characters::CharacterVersion;
use p02_core::Timestamp;
use p02_shared::{Identifier, PathEntry, describe_entry, read_file, write_file_atomically};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::StorageError;
use crate::layout::{LOCKS_DIRECTORY, SCHEMA_FILE};
use crate::lock::{Resource, with_lock};

/// The version of the store this build reads and writes, and no other.
pub(crate) const SCHEMA_VERSION: u64 = 15;

/// What a marker vouches its directory is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    Home,
    CharacterData,
}

impl Scope {
    pub(crate) fn article(self) -> &'static str {
        match self {
            Self::Home => "a Project02 home",
            Self::CharacterData => "a character data directory",
        }
    }

    pub(crate) fn other(self) -> Self {
        match self {
            Self::Home => Self::CharacterData,
            Self::CharacterData => Self::Home,
        }
    }
}

/// Why a marker is not one.
#[derive(Debug, thiserror::Error)]
pub enum MarkerProblem {
    #[error("is not valid JSON")]
    NotJson(#[source] serde_json::Error),
    #[error("is a symbolic link; the marker must be a regular file inside its storage directory")]
    Link,
    #[error("must be a regular file inside its storage directory")]
    NotAFile,
    #[error("has no whole-number schemaVersion")]
    NoVersion,
    #[error("is malformed")]
    Shape(#[source] serde_json::Error),
    #[error("must name a character exactly when it marks character data")]
    ScopeFields,
}

/// A marker as this build reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Marker {
    Home {
        created_at: Timestamp,
    },
    CharacterData {
        character: Identifier,
        created_at: Timestamp,
        /// The version of her package whose settings were last merged into
        /// her overlay.
        package_version: Option<CharacterVersion>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireMarker {
    schema_version: u64,
    scope: Scope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    character_id: Option<Identifier>,
    created_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    materialized_character_package_version: Option<CharacterVersion>,
}

impl Marker {
    fn encode(&self) -> Vec<u8> {
        let wire = match self.clone() {
            Self::Home { created_at } => WireMarker {
                schema_version: SCHEMA_VERSION,
                scope: Scope::Home,
                character_id: None,
                created_at,
                materialized_character_package_version: None,
            },
            Self::CharacterData {
                character,
                created_at,
                package_version,
            } => WireMarker {
                schema_version: SCHEMA_VERSION,
                scope: Scope::CharacterData,
                character_id: Some(character),
                created_at,
                materialized_character_package_version: package_version,
            },
        };
        let mut bytes =
            serde_json::to_vec(&wire).expect("a marker of plain fields always serializes");

        bytes.push(b'\n');
        bytes
    }

    /// The version is read first, so a marker of another version is refused
    /// as that, whatever else it holds.
    fn decode(bytes: &[u8], path: &Path) -> Result<Self, StorageError> {
        let malformed = |problem| StorageError::MalformedMarker {
            path: path.to_path_buf(),
            problem,
        };
        let value: Value = serde_json::from_slice(bytes)
            .map_err(|error| malformed(MarkerProblem::NotJson(error)))?;

        match value.get("schemaVersion").and_then(Value::as_u64) {
            Some(SCHEMA_VERSION) => {}
            Some(found) => {
                return Err(StorageError::UnsupportedSchemaVersion {
                    path: path.to_path_buf(),
                    found,
                });
            }
            None => return Err(malformed(MarkerProblem::NoVersion)),
        }

        let wire: WireMarker = serde_json::from_value(value)
            .map_err(|error| malformed(MarkerProblem::Shape(error)))?;

        match (
            wire.scope,
            wire.character_id,
            wire.materialized_character_package_version,
        ) {
            (Scope::Home, None, None) => Ok(Self::Home {
                created_at: wire.created_at,
            }),
            (Scope::CharacterData, Some(character), package_version) => Ok(Self::CharacterData {
                character,
                created_at: wire.created_at,
                package_version,
            }),
            _ => Err(malformed(MarkerProblem::ScopeFields)),
        }
    }
}

/// The marker of the directory at `directory`, `None` when it has none.
pub(crate) fn read(directory: &Path) -> Result<Option<Marker>, StorageError> {
    let path = directory.join(SCHEMA_FILE);
    let malformed = |problem| StorageError::MalformedMarker {
        path: path.clone(),
        problem,
    };

    match describe_entry(&path) {
        PathEntry::Absent => Ok(None),
        PathEntry::File => {
            let bytes = read_file(&path).map_err(StorageError::read(&path))?;

            Marker::decode(&bytes, &path).map(Some)
        }
        PathEntry::Link => Err(malformed(MarkerProblem::Link)),
        PathEntry::Directory | PathEntry::Other => Err(malformed(MarkerProblem::NotAFile)),
        PathEntry::Unreadable(source) => Err(StorageError::Read { path, source }),
    }
}

/// The directory's marker, written as `proposed` when it has none. The lock
/// file lives inside the directory under claim, so whether it may be
/// claimed is asked again under the lock, just before the write.
pub(crate) fn ensure(
    directory: &Path,
    proposed: Marker,
    adoptable: impl Fn() -> Result<(), StorageError>,
) -> Result<Marker, StorageError> {
    if let Some(existing) = read(directory)? {
        return Ok(existing);
    }

    with_lock(
        &directory.join(LOCKS_DIRECTORY),
        &Resource::StorageSchema,
        || {
            if let Some(existing) = read(directory)? {
                return Ok(existing);
            }

            adoptable()?;
            write(directory, &proposed)?;
            Ok(proposed)
        },
    )
}

/// Replaces the directory's marker with what `update` makes of it.
pub(crate) fn update(
    directory: &Path,
    update: impl FnOnce(Marker) -> Marker,
    adoptable: impl Fn() -> Result<(), StorageError>,
) -> Result<Marker, StorageError> {
    adoptable()?;

    with_lock(
        &directory.join(LOCKS_DIRECTORY),
        &Resource::StorageSchema,
        || {
            let current = read(directory)?.ok_or_else(|| StorageError::NoMarker {
                path: directory.to_path_buf(),
            })?;
            let next = update(current.clone());

            if next != current {
                adoptable()?;
                write(directory, &next)?;
            }

            Ok(next)
        },
    )
}

fn write(directory: &Path, marker: &Marker) -> Result<(), StorageError> {
    let path = directory.join(SCHEMA_FILE);

    write_file_atomically(&path, &marker.encode()).map_err(StorageError::write(&path))
}
