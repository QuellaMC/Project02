use std::error::Error;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

/// One plugin's durable files, under a lease that shuts out every other
/// holder, in this process or another. The store crate implements it.
pub trait FileStoreBackend: Send + Sync + fmt::Debug {
    /// Takes the lease, waiting no later than `deadline`; the lease is held
    /// until the returned files are dropped.
    ///
    /// # Errors
    ///
    /// [`StoreError::Store`] when the lease cannot be had in time or the
    /// store cannot be read.
    fn lease(&self, deadline: std::time::Instant) -> Result<Box<dyn LeasedFiles + '_>, StoreError>;
}

/// The store's files while its lease is held. Paths are relative to the
/// store, and the store refuses one that leaves it or names its own files.
pub trait LeasedFiles: fmt::Debug {
    /// # Errors
    ///
    /// [`StoreError::Store`] for an unsafe path or a document that is not JSON.
    fn read_json(&self, path: &str) -> Result<Option<Value>, StoreError>;

    /// # Errors
    ///
    /// [`StoreError::Store`] for an unsafe path or a damaged log.
    fn read_jsonl(&self, path: &str) -> Result<Vec<Value>, StoreError>;

    /// Replaces a document whole, so a crash leaves the old one or the new.
    ///
    /// # Errors
    ///
    /// [`StoreError::Store`] for an unsafe path or a failed write.
    fn write_json(&mut self, path: &str, value: &Value) -> Result<(), StoreError>;

    /// # Errors
    ///
    /// [`StoreError::Store`] for an unsafe path or a failed write.
    fn append_jsonl(&mut self, path: &str, value: &Value) -> Result<(), StoreError>;

    /// How many writes the store has committed.
    ///
    /// # Errors
    ///
    /// [`StoreError::Store`] when the count cannot be read.
    fn revision(&self) -> Result<u64, StoreError>;
}

/// Whether a hook may change the store it reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreAccess {
    ReadOnly,
    ReadWrite,
}

/// A plugin's store as one hook holds it. Every call is checked before it
/// acts: none once the hook is cancelled, and no write once the hook has
/// settled or when it may only read.
#[derive(Clone, Debug)]
pub struct FileStore {
    backend: Arc<dyn FileStoreBackend>,
    access: StoreAccess,
    deadline: Instant,
    cancellation: CancellationToken,
    writes_open: Arc<AtomicBool>,
}

/// The host's hold on a hook's writes, which it ends when the hook settles.
/// A plugin never has one.
#[derive(Debug)]
#[must_use = "a hook's writes end only when the host revokes them"]
pub struct WriteRevocation(Arc<AtomicBool>);

impl WriteRevocation {
    /// Ends every later write through any copy of the store.
    pub fn revoke(self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Why a store call did not happen or did not succeed.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("the hook was cancelled, so its plugin store takes no more calls")]
    Cancelled,
    #[error("plugin store writes are not allowed for this hook")]
    ReadOnly,
    #[error("plugin store writes are no longer allowed after hook completion")]
    WritesRevoked,
    #[error("the plugin store failed")]
    Store(#[source] Box<dyn Error + Send + Sync>),
}

impl FileStore {
    pub(crate) fn new(
        backend: Arc<dyn FileStoreBackend>,
        access: StoreAccess,
        deadline: Instant,
        cancellation: CancellationToken,
    ) -> (Self, WriteRevocation) {
        let writes_open = Arc::new(AtomicBool::new(true));

        (
            Self {
                backend,
                access,
                deadline,
                cancellation,
                writes_open: Arc::clone(&writes_open),
            },
            WriteRevocation(writes_open),
        )
    }

    /// Runs `operation` under the store's lease, so a read-modify-write
    /// sees only what it read itself. The operation is synchronous and does
    /// disk work, so a hook runs it on a blocking thread.
    ///
    /// # Errors
    ///
    /// [`StoreError::Cancelled`] when the hook was cancelled, the
    /// backend's error when the lease cannot be had, or what `operation`
    /// returns.
    pub fn with_lease<T>(
        &self,
        operation: impl FnOnce(&mut LeasedStore<'_>) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        self.check_open()?;

        let files = self.backend.lease(self.deadline.into_std())?;

        operation(&mut LeasedStore { files, store: self })
    }

    fn check_open(&self) -> Result<(), StoreError> {
        if self.cancellation.is_cancelled() {
            Err(StoreError::Cancelled)
        } else {
            Ok(())
        }
    }

    fn check_writable(&self) -> Result<(), StoreError> {
        self.check_open()?;

        if self.access == StoreAccess::ReadOnly {
            Err(StoreError::ReadOnly)
        } else if self.writes_open.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(StoreError::WritesRevoked)
        }
    }
}

/// The store while a hook holds its lease.
#[derive(Debug)]
pub struct LeasedStore<'a> {
    files: Box<dyn LeasedFiles + 'a>,
    store: &'a FileStore,
}

impl LeasedStore<'_> {
    /// A document, or `None` when there is none at `path`.
    ///
    /// # Errors
    ///
    /// [`StoreError::Cancelled`], or the store's own error.
    pub fn read_json(&self, path: &str) -> Result<Option<Value>, StoreError> {
        self.store.check_open()?;
        self.files.read_json(path)
    }

    /// # Errors
    ///
    /// [`StoreError::Cancelled`], or the store's own error.
    pub fn read_jsonl(&self, path: &str) -> Result<Vec<Value>, StoreError> {
        self.store.check_open()?;
        self.files.read_jsonl(path)
    }

    /// # Errors
    ///
    /// [`StoreError::Cancelled`], [`StoreError::ReadOnly`],
    /// [`StoreError::WritesRevoked`], or the store's own error.
    pub fn write_json(&mut self, path: &str, value: &Value) -> Result<(), StoreError> {
        self.store.check_writable()?;
        self.files.write_json(path, value)
    }

    /// # Errors
    ///
    /// [`StoreError::Cancelled`], [`StoreError::ReadOnly`],
    /// [`StoreError::WritesRevoked`], or the store's own error.
    pub fn append_jsonl(&mut self, path: &str, value: &Value) -> Result<(), StoreError> {
        self.store.check_writable()?;
        self.files.append_jsonl(path, value)
    }

    /// # Errors
    ///
    /// [`StoreError::Cancelled`], or the store's own error.
    pub fn revision(&self) -> Result<u64, StoreError> {
        self.store.check_open()?;
        self.files.revision()
    }
}
