//! The daemon's claim on its home, held from before its socket is bound
//! until after it is closed: the lease that makes it the one daemon
//! serving the home, and the record that tells clients where it listens.
//! The token and the port belong to the home, so a later run finds them
//! in the record and answers on the same address.

use std::num::{NonZeroU16, NonZeroU32};
use std::process;

use p02_app::PROTOCOL_VERSION;
use p02_core::Timestamp;
use p02_shared::{DaemonRecord, DaemonRun, DaemonToken, ReadDaemonRecordError, read_daemon_record};
use p02_store::{DaemonLease, Home, StorageError};

/// What came of claiming a home.
#[derive(Debug)]
pub enum ClaimOutcome {
    Claimed(Claim),
    /// Another process serves the home; its record, when one can be read.
    Held {
        record: Option<DaemonRecord>,
    },
}

/// A daemon's claim on its home.
#[derive(Debug)]
#[must_use = "a claim holds its home until it is released"]
pub struct Claim {
    lease: DaemonLease,
    token: DaemonToken,
    /// The port the home's last run bound, for this one to bind again.
    port: Option<NonZeroU16>,
    unreadable: Option<ReadDaemonRecordError>,
    /// The port the record says this run listens on, once it does.
    published: Option<NonZeroU16>,
}

impl Claim {
    /// Takes the home's daemon lease at once or not at all, and reads what
    /// the last run left: its token, kept, and its port, to bind again. A
    /// home without a record, or with one that cannot be read, is given a
    /// fresh token. Nothing is written until [`Claim::publish`].
    ///
    /// # Errors
    ///
    /// [`StorageError`] when the store refuses the home.
    pub fn take(home: &Home) -> Result<ClaimOutcome, StorageError> {
        let lease = match home.daemon_lease() {
            Ok(lease) => lease,
            Err(StorageError::Busy { .. }) => {
                return Ok(ClaimOutcome::Held {
                    record: read_daemon_record(home.root()).ok().flatten(),
                });
            }
            Err(error) => return Err(error),
        };
        let (previous, unreadable) = match read_daemon_record(home.root()) {
            Ok(previous) => (previous, None),
            Err(error) => (None, Some(error)),
        };

        Ok(ClaimOutcome::Claimed(Self {
            lease,
            token: previous.as_ref().map_or_else(
                || DaemonToken::from_random(rand::random()),
                |record| record.token.clone(),
            ),
            port: previous.map(|record| record.port),
            unreadable,
            published: None,
        }))
    }

    /// The token every client presents.
    #[must_use]
    pub fn token(&self) -> &DaemonToken {
        &self.token
    }

    /// The port the home's last run bound; none on a first run, or once
    /// its record could not be read.
    #[must_use]
    pub fn port(&self) -> Option<NonZeroU16> {
        self.port
    }

    /// The record that was there and could not be read, which this claim
    /// replaces, with a fresh token.
    #[must_use]
    pub fn unreadable_record(&self) -> Option<&ReadDaemonRecordError> {
        self.unreadable.as_ref()
    }

    /// Says where the daemon listens: the record is written with the
    /// protocol, the token, `port` and this run, owner-only and whole, a
    /// temporary a dead writer left beside it removed first. Answers the
    /// port the record held when `port` is another: the home's port was
    /// taken, and the address moved.
    ///
    /// # Errors
    ///
    /// [`StorageError`] when the record cannot be written, which leaves it
    /// as it was.
    pub fn publish(&mut self, port: NonZeroU16) -> Result<Option<NonZeroU16>, StorageError> {
        self.lease.write_record(&DaemonRecord {
            protocol_version: PROTOCOL_VERSION,
            token: self.token.clone(),
            port,
            // The system gives no process of its own the pid 0; a record
            // without a run says less, and nothing false.
            running: NonZeroU32::new(process::id()).map(|pid| DaemonRun {
                pid,
                started_at: Timestamp::now().to_string(),
            }),
        })?;
        self.published = Some(port);

        Ok(self.port.filter(|previous| *previous != port))
    }

    /// Rewrites the record without this run, then lets the home go. The
    /// rewrite is best effort: a record that keeps naming the run names a
    /// process that is gone, which every reader handles, as after a crash.
    /// The lease is the kernel's lock and always goes.
    pub fn release(self) {
        if let Some(port) = self.published {
            let _ = self.lease.write_record(&DaemonRecord {
                protocol_version: PROTOCOL_VERSION,
                token: self.token,
                port,
                running: None,
            });
        }

        self.lease.release();
    }
}
