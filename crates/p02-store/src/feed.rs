//! A character's committed conversations as her plugins read them: the
//! sessions her catalog lists, and the visible messages each session's log
//! committed, from a cursor, a batch at a time. A line the log's read skips
//! is counted as damage, and a catalog row it skips as a damaged entry.
//!
//! A cursor is the place in the log just past a line, in bytes. A log is
//! only ever appended to, so a place once read stays where it was, and one
//! that is no line's end in the log as it is now is a cursor of a log that
//! shrank or was replaced: its reader starts again from the top.

use std::num::NonZeroUsize;

use p02_contracts::{
    HistoryCursor, HistoryMessage, MessageBatch, ReadMessages, SessionHistoryError,
    SessionHistoryFeed, SessionListing, SessionSummary,
};

use crate::character_data::CharacterData;
use crate::error::StorageError;
use crate::record::RecordBody;

/// One character's history, as her plugins read it.
#[derive(Clone, Debug)]
pub(crate) struct HistoryFeed {
    data: CharacterData,
}

impl HistoryFeed {
    pub(crate) fn new(data: CharacterData) -> Self {
        Self { data }
    }

    fn batch(&self, request: &ReadMessages) -> Result<MessageBatch, StorageError> {
        let session = request.session_id();
        let conversation = self.data.home().conversation(session.conversation_id())?;
        let log = self
            .data
            .session_log(&conversation, session.segment())?
            .read_log()?;
        let lines: Vec<_> = log.lines().collect();
        // The first line after the place the cursor names, and that place.
        let resume = |cursor: &HistoryCursor| {
            let at: usize = cursor.as_str().parse().ok()?;

            if at == 0 {
                return Some((0, 0));
            }

            lines
                .iter()
                .position(|(end, _)| *end == at)
                .map(|index| (index + 1, at))
        };
        let ((first, start), reset) = match request.cursor().map(resume) {
            None => ((0, 0), false),
            Some(Some(resumed)) => (resumed, false),
            Some(None) => ((0, 0), true),
        };
        let budget = request.max_bytes().map_or(usize::MAX, NonZeroUsize::get);
        let mut messages = Vec::new();
        let mut damaged_record_count = 0;
        let mut end = start;

        for (line_end, record) in &lines[first..] {
            // Whole lines only, the first however long, so a read always
            // moves on while the log has more.
            if end > start && line_end - start > budget {
                break;
            }

            end = *line_end;

            let Some(record) = record else {
                damaged_record_count += 1;
                continue;
            };

            if let RecordBody::MessageCommitted(commit) = record.body() {
                messages.push(HistoryMessage {
                    message: commit.message().clone(),
                    committed_at: record.identity().created_at().clone(),
                });
            }
        }

        Ok(MessageBatch {
            messages,
            next_cursor: HistoryCursor::new(end.to_string()),
            damaged_record_count,
            reset,
        })
    }
}

impl SessionHistoryFeed for HistoryFeed {
    /// Every session the catalog lists, oldest first, as every other reader
    /// reads the catalog.
    fn list_sessions(&self) -> Result<SessionListing, SessionHistoryError> {
        let catalog = self.data.sessions().map_err(feed_error)?;

        Ok(SessionListing {
            sessions: catalog
                .sessions
                .into_iter()
                .map(|entry| SessionSummary {
                    session_id: entry.session_id().clone(),
                    created_at: entry.created_at().clone(),
                })
                .collect(),
            damaged_entry_count: u64::try_from(catalog.skipped_lines.numbers().len())
                .unwrap_or(u64::MAX),
        })
    }

    fn read_messages(&self, request: &ReadMessages) -> Result<MessageBatch, SessionHistoryError> {
        self.batch(request).map_err(feed_error)
    }
}

fn feed_error(error: StorageError) -> SessionHistoryError {
    SessionHistoryError::Feed(Box::new(error))
}
