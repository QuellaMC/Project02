//! The one daemon's lease on its home, and the record it keeps there for
//! its clients, `daemon.json`, which nothing else writes.

use p02_shared::{DAEMON_RECORD_FILE, DaemonRecord, write_file_atomically};

use crate::error::StorageError;
use crate::home::Home;
use crate::lock::Lease;

/// The lease of the one daemon serving a home, refused at once to every
/// other while it is held. Its holder alone writes the home's record.
#[derive(Debug)]
#[must_use = "a daemon lease holds its home until it is released"]
pub struct DaemonLease {
    home: Home,
    lease: Lease,
}

impl DaemonLease {
    pub(crate) fn new(home: Home, lease: Lease) -> Self {
        Self { home, lease }
    }

    /// Replaces the home's record with `record`, pretty-printed with a
    /// trailing newline, owner-only and whole. A temporary a writer that
    /// died left beside it goes first.
    ///
    /// # Errors
    ///
    /// [`StorageError::Write`] when the write fails, which leaves the record
    /// as it was.
    #[expect(
        clippy::missing_panics_doc,
        reason = "a record of plain fields always serializes"
    )]
    pub fn write_record(&self, record: &DaemonRecord) -> Result<(), StorageError> {
        let path = self.home.root().join(DAEMON_RECORD_FILE);
        let mut content =
            serde_json::to_vec_pretty(record).expect("a record of plain fields always serializes");

        content.push(b'\n');
        write_file_atomically(&path, &content).map_err(StorageError::write(&path))
    }

    /// Releases the home.
    pub fn release(self) {
        self.lease.release();
    }
}
