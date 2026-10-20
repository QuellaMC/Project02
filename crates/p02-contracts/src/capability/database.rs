use std::error::Error;
use std::fmt;
use std::num::NonZeroU32;
use std::sync::Arc;

use p02_shared::Identifier;
use rusqlite::Connection;
use tokio_util::sync::CancellationToken;

/// Opens one plugin's databases inside its own data directory. Only the
/// store crate implements it: nothing else in the daemon opens a database.
pub trait DatabaseOpener: Send + Sync + fmt::Debug {
    /// Opens `name` at `schema_version`, running `initialize` in one
    /// transaction when the file is new. A database is a view the plugin
    /// can rebuild, so a file at another version, or a damaged one, is
    /// rebuilt rather than migrated.
    ///
    /// # Errors
    ///
    /// [`DatabaseError::Open`] when the database cannot be opened even
    /// fresh.
    fn open(
        &self,
        name: &Identifier,
        schema_version: NonZeroU32,
        initialize: &dyn Fn(&Connection) -> rusqlite::Result<()>,
    ) -> Result<Connection, DatabaseError>;
}

/// The databases a hook may open: the plugin's own, through the store. The
/// connection is the plugin's to keep, beyond the hook that opened it, and
/// it is rusqlite's whole: a plugin is first-party code compiled into the
/// daemon, so what it runs on its connection is reviewed like the rest of
/// its code, not narrowed at run time.
#[derive(Clone, Debug)]
pub struct PluginDatabase {
    opener: Arc<dyn DatabaseOpener>,
    cancellation: CancellationToken,
}

/// Why a database did not open.
#[derive(Debug, thiserror::Error)]
pub enum DatabaseError {
    #[error("the hook was cancelled, so it opens no database")]
    Cancelled,
    #[error("the plugin database could not be opened")]
    Open(#[source] Box<dyn Error + Send + Sync>),
}

impl PluginDatabase {
    pub(crate) fn new(opener: Arc<dyn DatabaseOpener>, cancellation: CancellationToken) -> Self {
        Self {
            opener,
            cancellation,
        }
    }

    /// # Errors
    ///
    /// [`DatabaseError::Cancelled`] when the hook was cancelled, or the
    /// opener's error.
    pub fn open(
        &self,
        name: &Identifier,
        schema_version: NonZeroU32,
        initialize: impl Fn(&Connection) -> rusqlite::Result<()>,
    ) -> Result<Connection, DatabaseError> {
        if self.cancellation.is_cancelled() {
            return Err(DatabaseError::Cancelled);
        }

        self.opener.open(name, schema_version, &initialize)
    }
}
