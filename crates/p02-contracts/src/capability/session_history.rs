use std::error::Error;
use std::fmt;
use std::num::NonZeroUsize;
use std::sync::Arc;

use p02_core::{SessionId, Timestamp, VisibleMessage};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

/// One character's committed visible messages, read a batch at a time;
/// never the raw events. A torn tail is invisible, a damaged record is
/// counted and skipped, and every batch agrees with a prefix of the log.
/// The store crate implements it.
pub trait SessionHistoryFeed: Send + Sync + fmt::Debug {
    /// # Errors
    ///
    /// [`SessionHistoryError::Feed`] when the catalog cannot be read.
    fn list_sessions(&self) -> Result<SessionListing, SessionHistoryError>;

    /// # Errors
    ///
    /// [`SessionHistoryError::Feed`] when the session cannot be read.
    fn read_messages(&self, request: &ReadMessages) -> Result<MessageBatch, SessionHistoryError>;
}

/// The history a hook may read. Every call is checked before it acts: none
/// once the hook is cancelled.
#[derive(Clone, Debug)]
pub struct SessionHistory {
    feed: Arc<dyn SessionHistoryFeed>,
    cancellation: CancellationToken,
}

/// Why history was not read.
#[derive(Debug, thiserror::Error)]
pub enum SessionHistoryError {
    #[error("the hook was cancelled, so it reads no more history")]
    Cancelled,
    #[error("the session history could not be read")]
    Feed(#[source] Box<dyn Error + Send + Sync>),
}

impl SessionHistory {
    pub(crate) fn new(feed: Arc<dyn SessionHistoryFeed>, cancellation: CancellationToken) -> Self {
        Self { feed, cancellation }
    }

    /// # Errors
    ///
    /// [`SessionHistoryError::Cancelled`] when the hook was cancelled, or
    /// the feed's error.
    pub fn list_sessions(&self) -> Result<SessionListing, SessionHistoryError> {
        self.check_open()?;
        self.feed.list_sessions()
    }

    /// # Errors
    ///
    /// [`SessionHistoryError::Cancelled`] when the hook was cancelled, or
    /// the feed's error.
    pub fn read_messages(
        &self,
        request: &ReadMessages,
    ) -> Result<MessageBatch, SessionHistoryError> {
        self.check_open()?;
        self.feed.read_messages(request)
    }

    fn check_open(&self) -> Result<(), SessionHistoryError> {
        if self.cancellation.is_cancelled() {
            Err(SessionHistoryError::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// The sessions a character has, and how many catalog entries were damaged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionListing {
    pub sessions: Vec<SessionSummary>,
    pub damaged_entry_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionSummary {
    pub session_id: SessionId,
    pub created_at: Timestamp,
}

/// Which messages of a session to read next.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadMessages {
    session_id: SessionId,
    cursor: Option<HistoryCursor>,
    max_bytes: Option<NonZeroUsize>,
}

impl ReadMessages {
    #[must_use]
    pub fn from_start(session_id: SessionId) -> Self {
        Self {
            session_id,
            cursor: None,
            max_bytes: None,
        }
    }

    /// Continues where an earlier batch's cursor left off.
    #[must_use]
    pub fn after(mut self, cursor: HistoryCursor) -> Self {
        self.cursor = Some(cursor);
        self
    }

    /// Reads no more than `max_bytes` of the log in one call; the rest
    /// stays for the next.
    #[must_use]
    pub fn within(mut self, max_bytes: NonZeroUsize) -> Self {
        self.max_bytes = Some(max_bytes);
        self
    }

    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    #[must_use]
    pub fn cursor(&self) -> Option<&HistoryCursor> {
        self.cursor.as_ref()
    }

    #[must_use]
    pub fn max_bytes(&self) -> Option<NonZeroUsize> {
        self.max_bytes
    }
}

/// The messages read, and where to continue.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageBatch {
    pub messages: Vec<HistoryMessage>,
    pub next_cursor: HistoryCursor,
    pub damaged_record_count: u64,
    /// The session no longer matches the cursor: it shrank, was replaced,
    /// or the cursor is unreadable. Everything consumed for it before is
    /// stale and is discarded before this batch, which starts at the top.
    pub reset: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryMessage {
    pub message: VisibleMessage,
    pub committed_at: Timestamp,
}

/// A place in a session's history that only the feed reads; a plugin keeps
/// it to continue from.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct HistoryCursor(String);

impl HistoryCursor {
    #[must_use]
    pub fn new(position: impl Into<String>) -> Self {
        Self(position.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
