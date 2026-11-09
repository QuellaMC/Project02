//! A character's inbox, `inbox.jsonl`: every line sent to her that no turn
//! of hers has taken yet, oldest first, whichever surface it came from. A
//! line is queued once its newline is written, and leaves when the file is
//! rewritten without it, both under her inbox's lock. A line of the file
//! that is no line is skipped, and the read that meets it leaves it out of
//! the file, so it is said once.

use std::path::Path;

use p02_core::{ClientStamp, ConversationId, MessageId};
use p02_shared::{append_line, empty_file, write_file_atomically};
use serde::{Deserialize, Serialize};

use crate::character_data::CharacterData;
use crate::error::StorageError;
use crate::jsonl::{SkippedLines, committed_lines, read_lines};
use crate::lock::{Resource, with_lock};

/// A line for her as its client sent it: the conversation it is for, the
/// stamps its client put on it, and its text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedLine {
    pub conversation_id: ConversationId,
    /// The surface the line came from.
    pub source: ClientStamp,
    /// The id the client submitted the line under, which a repeat reuses.
    pub client_message_id: ClientStamp,
    pub text: String,
}

impl QueuedLine {
    /// Whether the two are one line: the same id on the same conversation.
    fn same(&self, other: &Self) -> bool {
        self.conversation_id == other.conversation_id
            && self.client_message_id == other.client_message_id
    }

    /// The line as the file holds it.
    fn encoded(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("a line of plain fields always serializes")
    }
}

/// What became of a line given to her inbox.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Queueing {
    /// Queued, behind every line before it.
    Queued,
    /// The line is queued already.
    AlreadyQueued,
    /// A turn of hers took the line, and committed it as this message.
    Taken(MessageId),
}

/// Her inbox as it was read: the lines queued, oldest first, and the lines
/// of the file the read skipped.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Inbox {
    pub lines: Vec<QueuedLine>,
    pub skipped: SkippedLines,
}

impl CharacterData {
    /// Queues `line` behind every line before it, unless it was sent
    /// before: one queued, or one a turn of hers took.
    ///
    /// # Errors
    ///
    /// [`StorageError`] when her inbox cannot be read or written, or its
    /// lock stays busy.
    pub fn queue(&self, line: &QueuedLine) -> Result<Queueing, StorageError> {
        let path = self.inbox_path();

        with_lock(&self.locks_root(), &Resource::Inbox, || {
            if let Some(sent) = self.sent(&path, line)? {
                return Ok(sent);
            }

            append_line(&path, &line.encoded()).map_err(StorageError::write(&path))?;
            Ok(Queueing::Queued)
        })
    }

    /// What became of `line` if it was sent before: queued already, or
    /// taken as the message it became; none for a line never sent.
    ///
    /// # Errors
    ///
    /// [`StorageError`] when her inbox cannot be read, or its lock stays
    /// busy.
    pub fn sent_before(&self, line: &QueuedLine) -> Result<Option<Queueing>, StorageError> {
        let path = self.inbox_path();

        with_lock(&self.locks_root(), &Resource::Inbox, || {
            self.sent(&path, line)
        })
    }

    /// Her inbox as the file holds it now; what the read skipped is left
    /// out of the file from now on.
    ///
    /// # Errors
    ///
    /// [`StorageError`] when her inbox cannot be read or rewritten, or its
    /// lock stays busy.
    pub fn inbox(&self) -> Result<Inbox, StorageError> {
        let path = self.inbox_path();

        with_lock(&self.locks_root(), &Resource::Inbox, || {
            let inbox = read(&path)?;

            if !inbox.skipped.is_empty() {
                rewrite(&path, &inbox.lines)?;
            }

            Ok(inbox)
        })
    }

    /// What became of `line` if it was sent before, read under her inbox's
    /// lock. A line this read cannot tell taken counts as never sent: her
    /// thread refuses a line it took when its turn comes.
    fn sent(&self, path: &Path, line: &QueuedLine) -> Result<Option<Queueing>, StorageError> {
        if read(path)?.lines.iter().any(|queued| queued.same(line)) {
            return Ok(Some(Queueing::AlreadyQueued));
        }

        let taken = self
            .home()
            .conversation(&line.conversation_id)
            .and_then(|conversation| self.taken_line(&conversation, &line.client_message_id));

        Ok(match taken {
            Ok(Some(message)) => Some(Queueing::Taken(message)),
            _ => None,
        })
    }

    /// Lets `line` go from her inbox.
    ///
    /// # Errors
    ///
    /// [`StorageError`] when her inbox cannot be read or rewritten, or its
    /// lock stays busy.
    pub fn unqueue(&self, line: &QueuedLine) -> Result<(), StorageError> {
        let path = self.inbox_path();

        with_lock(&self.locks_root(), &Resource::Inbox, || {
            let lines = read(&path)?.lines;
            let kept: Vec<QueuedLine> = lines
                .iter()
                .filter(|queued| !queued.same(line))
                .cloned()
                .collect();

            if kept.len() == lines.len() {
                return Ok(());
            }

            rewrite(&path, &kept)
        })
    }
}

/// The inbox at `path` as its committed lines read.
fn read(path: &Path) -> Result<Inbox, StorageError> {
    let content = read_lines(path)?;
    let mut inbox = Inbox::default();

    for (number, bytes) in committed_lines(&content) {
        match serde_json::from_slice(bytes) {
            Ok(line) => inbox.lines.push(line),
            Err(_) => inbox.skipped.push(number),
        }
    }

    Ok(inbox)
}

/// Makes the inbox at `path` hold `lines`: rewritten whole, or, when none
/// is left, emptied in place, which takes no new file, so her inbox drains
/// on a full disk too.
fn rewrite(path: &Path, lines: &[QueuedLine]) -> Result<(), StorageError> {
    if lines.is_empty() {
        return empty_file(path).map_err(StorageError::write(path));
    }

    let content: Vec<u8> = lines
        .iter()
        .flat_map(|line| {
            let mut bytes = line.encoded();

            bytes.push(b'\n');
            bytes
        })
        .collect();

    write_file_atomically(path, &content).map_err(StorageError::write(path))
}
