//! A plugin's databases in a character's data,
//! `plugin-data/<plugin>/<name>.sqlite` beside SQLite's `-wal` and `-shm`:
//! the one place the daemon opens a database. A database is a view its
//! plugin can build again, so one that holds another schema version, or
//! that SQLite finds damaged, is deleted with its companions and made anew,
//! never migrated; one another program holds, and every other failure, is
//! reported and left as it is.

use std::ffi::OsString;
use std::io;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::time::Duration;

use p02_contracts::{DatabaseError, DatabaseOpener};
use p02_shared::{Identifier, create_directories, create_new_file, remove_file};
use rusqlite::{Connection, ErrorCode, OpenFlags, TransactionBehavior};

use crate::character_data::CharacterData;
use crate::error::StorageError;
use crate::layout::{DATABASE_COMPANIONS, DATABASE_SUFFIX};

/// How long a connection waits for a lock another holds before it is
/// reported busy.
const BUSY_TIMEOUT: Duration = Duration::from_secs(2);

/// One plugin's databases in one character's data.
#[derive(Clone, Debug)]
pub(crate) struct PluginDatabases {
    data: CharacterData,
    plugin: Identifier,
}

/// Why a database did not open at the version its plugin asked for.
#[derive(Debug, thiserror::Error)]
pub enum OpenDatabaseError {
    #[error("it holds schema version {found}, not {expected}")]
    Version { found: i64, expected: NonZeroU32 },
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

type Initialize<'a> = &'a dyn Fn(&Connection) -> rusqlite::Result<()>;

impl PluginDatabases {
    pub(crate) fn new(data: CharacterData, plugin: Identifier) -> Self {
        Self { data, plugin }
    }

    fn open_database(
        &self,
        name: &Identifier,
        version: NonZeroU32,
        initialize: Initialize<'_>,
    ) -> Result<Connection, StorageError> {
        let root = self.data.checked_plugin_root(&self.plugin)?;
        let path = root.join(format!("{name}{DATABASE_SUFFIX}"));
        let failed = |source| StorageError::Database {
            path: path.clone(),
            source,
        };

        create_directories(&root).map_err(StorageError::write(&root))?;
        create_owner_only(&path)?;

        match open_at_version(&path, version, initialize) {
            Ok(connection) => return Ok(connection),
            Err(error) if error.is_rebuildable() => {}
            Err(error) => return Err(failed(error)),
        }

        remove_database(&path)?;
        create_owner_only(&path)?;
        open_at_version(&path, version, initialize).map_err(failed)
    }
}

impl DatabaseOpener for PluginDatabases {
    fn open(
        &self,
        name: &Identifier,
        schema_version: NonZeroU32,
        initialize: Initialize<'_>,
    ) -> Result<Connection, DatabaseError> {
        self.open_database(name, schema_version, initialize)
            .map_err(|error| DatabaseError::Open(Box::new(error)))
    }
}

impl OpenDatabaseError {
    /// Whether the file is positively unusable as the view: another version,
    /// or damage SQLite itself found. A lock, a full disk or anything else
    /// may pass, and the file may hold what nothing else does.
    fn is_rebuildable(&self) -> bool {
        match self {
            Self::Version { .. } => true,
            Self::Sqlite(error) => matches!(
                error.sqlite_error_code(),
                Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
            ),
        }
    }
}

/// Makes the database's file owner-only and empty when it is absent, before
/// SQLite opens it: SQLite gives the files it keeps beside it the database's
/// own mode.
fn create_owner_only(path: &Path) -> Result<(), StorageError> {
    match create_new_file(path, b"") {
        Err(error) if error.kind() != io::ErrorKind::AlreadyExists => Err(StorageError::Write {
            path: path.to_path_buf(),
            source: error,
        }),
        _ => Ok(()),
    }
}

/// The database at `path` at `version`, set up as every plugin database is,
/// and initialized when empty.
fn open_at_version(
    path: &Path,
    version: NonZeroU32,
    initialize: Initialize<'_>,
) -> Result<Connection, OpenDatabaseError> {
    let mut connection = connect(path)?;

    // The wait comes first: the switch to a write-ahead log takes a lock
    // another connection may hold for a moment.
    connection.busy_timeout(BUSY_TIMEOUT)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;

    let expected = i64::from(version.get());
    let found = match user_version(&connection)? {
        0 => initialize_if_empty(&mut connection, version, initialize)?,
        found => found,
    };

    if found == expected {
        Ok(connection)
    } else {
        Err(OpenDatabaseError::Version {
            found,
            expected: version,
        })
    }
}

#[expect(
    clippy::disallowed_methods,
    reason = "the store crate is the one place a database is opened"
)]
fn connect(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
}

/// Initializes the database when it is still empty, in one transaction
/// that keeps every other writer out, unless another opener did first; the
/// version it holds after.
fn initialize_if_empty(
    connection: &mut Connection,
    version: NonZeroU32,
    initialize: Initialize<'_>,
) -> Result<i64, OpenDatabaseError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let found = user_version(&transaction)?;
    let objects: i64 =
        transaction.query_row("SELECT count(*) FROM sqlite_master", [], |row| row.get(0))?;

    if found != 0 || objects != 0 {
        return Ok(found);
    }

    initialize(&transaction)?;
    transaction.pragma_update(None, "user_version", version.get())?;
    transaction.commit()?;
    Ok(i64::from(version.get()))
}

fn user_version(connection: &Connection) -> rusqlite::Result<i64> {
    connection.pragma_query_value(None, "user_version", |row| row.get(0))
}

/// Deletes the database at `path`, its companions first: SQLite would
/// replay a write-ahead log it found beside a new file into it.
fn remove_database(path: &Path) -> Result<(), StorageError> {
    let companions = DATABASE_COMPANIONS.iter().map(|suffix| {
        let mut name = OsString::from(path.as_os_str());

        name.push(suffix);
        PathBuf::from(name)
    });

    for file in companions.chain([path.to_path_buf()]) {
        remove_file(&file).map_err(StorageError::write(&file))?;
    }

    Ok(())
}
