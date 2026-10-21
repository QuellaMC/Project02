//! A session's log, `sessions/<session>/raw-events.jsonl`: one record per
//! line, appended and never rewritten. Reading it replays every committed
//! line through the gate; writing it takes the session's writer lease,
//! which one writer holds at a time.

use std::io;
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};

use p02_core::{
    CharacterProfile, Conversation, Session, SessionId, SpeakerName, VisibleMessageRole,
};
use p02_shared::{FileStamp, PathEntry, append_line, describe_entry, file_stamp, read_file};

use crate::character_data::CharacterData;
use crate::error::StorageError;
use crate::jsonl::committed_lines;
use crate::layout::{EntryKind, RAW_EVENTS_FILE};
use crate::lock::{Lease, Resource, acquire};
use crate::record::LogRecord;
use crate::replay::SessionReplay;

/// One session's log, as one character keeps it, bound to the names its
/// conversation's participants had when it began: every record of it must
/// speak of that character and that person.
#[derive(Clone, Debug)]
pub struct SessionLog {
    data: CharacterData,
    session: SessionId,
    character: CharacterProfile,
    user_name: SpeakerName,
}

/// A session's log while its writer lease is held: what has replayed so
/// far, and the appends that follow it.
#[derive(Debug)]
#[must_use = "a writer holds its session's lease until it is released"]
pub struct SessionWriter {
    log: SessionLog,
    lease: Lease,
    /// The replay of the log as it was when last read or written, with the
    /// file's stamp then; a stamp the file no longer has means the file
    /// changed beneath the writer, and the log is read again.
    cache: Option<Cached>,
}

#[derive(Debug)]
struct Cached {
    stamp: Option<FileStamp>,
    replay: SessionReplay,
}

impl CharacterData {
    /// The log of segment `segment` of `conversation`, as this character
    /// keeps it.
    ///
    /// # Errors
    ///
    /// [`StorageError::NotAParticipant`] when the conversation is not
    /// between this character and the person.
    pub fn session_log(
        &self,
        conversation: &Conversation,
        segment: NonZeroU64,
    ) -> Result<SessionLog, StorageError> {
        let participant = |role: VisibleMessageRole| {
            conversation
                .participants()
                .iter()
                .find(|participant| {
                    participant.kind == role
                        && (role == VisibleMessageRole::User || participant.id == *self.character())
                })
                .ok_or_else(|| StorageError::NotAParticipant {
                    conversation: conversation.id().clone(),
                    participant: self.character().clone(),
                })
        };
        let character = participant(VisibleMessageRole::Character)?;
        let person = participant(VisibleMessageRole::User)?;

        Ok(SessionLog {
            data: self.clone(),
            session: SessionId::new(conversation.id().clone(), segment),
            character: CharacterProfile {
                id: character.id.clone(),
                display_name: character.display_name.clone(),
            },
            user_name: person.display_name.clone(),
        })
    }
}

impl SessionLog {
    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        &self.session
    }

    /// The session as its log has it, every committed record replayed.
    ///
    /// # Errors
    ///
    /// [`StorageError`] when the catalog does not list the session, its
    /// directory or log is missing or not real, the log changed while it
    /// was read twice over, or a committed line is damage: no record, or a
    /// record that does not follow the ones before it.
    pub fn read(&self) -> Result<SessionReplay, StorageError> {
        self.data.session(&self.session)?;
        Ok(self.load()?.replay)
    }

    /// The session's writer: its lease, refused at once while another
    /// writer holds it, and its log, read.
    ///
    /// # Errors
    ///
    /// [`StorageError::Busy`] while another writer holds the session, or an
    /// error of [`SessionLog::read`].
    pub fn writer(self) -> Result<SessionWriter, StorageError> {
        let lease = acquire(&[(
            &self.data.locks_root(),
            &Resource::SessionWriter(&self.session),
        )])?;

        match self.data.session(&self.session).and_then(|_| self.load()) {
            Ok(cached) => Ok(SessionWriter {
                log: self,
                lease,
                cache: Some(cached),
            }),
            Err(error) => {
                lease.release();
                Err(error)
            }
        }
    }

    fn directory(&self) -> PathBuf {
        self.data.sessions_root().join(self.session.to_string())
    }

    fn path(&self) -> PathBuf {
        self.directory().join(RAW_EVENTS_FILE)
    }

    fn load(&self) -> Result<Cached, StorageError> {
        let directory = self.directory();

        match describe_entry(&directory) {
            PathEntry::Directory => {}
            PathEntry::Absent => {
                return Err(StorageError::MissingSessionDirectory { path: directory });
            }
            PathEntry::Unreadable(source) => {
                return Err(StorageError::Read {
                    path: directory,
                    source,
                });
            }
            PathEntry::File | PathEntry::Link | PathEntry::Other => {
                return Err(StorageError::NotReal {
                    path: directory,
                    expected: EntryKind::Directory,
                });
            }
        }

        let path = self.path();

        match describe_entry(&path) {
            PathEntry::Absent | PathEntry::File => {}
            PathEntry::Unreadable(source) => return Err(StorageError::Read { path, source }),
            PathEntry::Directory | PathEntry::Link | PathEntry::Other => {
                return Err(StorageError::NotReal {
                    path,
                    expected: EntryKind::File,
                });
            }
        }

        let (stamp, content) = read_coherently(&path, read_file)?;

        Ok(Cached {
            stamp,
            replay: self.replay(&path, &content)?,
        })
    }

    fn replay(&self, path: &Path, content: &[u8]) -> Result<SessionReplay, StorageError> {
        let mut replay = SessionReplay::new(Session::new(
            self.session.clone(),
            self.character.clone(),
            self.user_name.clone(),
        ));

        for (line, bytes) in committed_lines(content) {
            let record =
                LogRecord::from_line(bytes).map_err(|source| StorageError::MalformedRecord {
                    path: path.to_path_buf(),
                    line,
                    source,
                })?;

            replay
                .apply(record)
                .map_err(|source| StorageError::BrokenLog {
                    path: path.to_path_buf(),
                    line,
                    source,
                })?;
        }

        Ok(replay)
    }
}

impl SessionWriter {
    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        self.log.session_id()
    }

    /// The session as its log now has it.
    ///
    /// # Errors
    ///
    /// An error of [`SessionLog::read`], when the log has changed beneath
    /// the writer and is read again.
    pub fn replay(&mut self) -> Result<&SessionReplay, StorageError> {
        Ok(&self.fresh()?.replay)
    }

    /// Appends `record` after the log's last whole line, once the gate takes
    /// it: what a crash left after the last line is cut first. The line is
    /// not flushed to disk; it counts once its newline is there.
    ///
    /// # Errors
    ///
    /// [`StorageError::Refused`] when the record does not follow the log,
    /// [`StorageError::Write`] when the append failed, which may have left
    /// part of the line for the next append to cut, or an error of reading
    /// the log again.
    pub fn append(&mut self, record: LogRecord) -> Result<(), StorageError> {
        let line = record.to_line();
        let path = self.log.path();
        let cached = self.fresh()?;

        cached.replay.apply(record).map_err(StorageError::Refused)?;

        // Taken in before it lands, so a failed write leaves memory ahead of
        // the file: the log is read again before anything else.
        if let Err(source) = append_line(&path, line.as_bytes()) {
            self.cache = None;
            return Err(StorageError::Write { path, source });
        }

        match file_stamp(&path) {
            Ok(stamp) => cached_stamp(&mut self.cache, stamp),
            Err(_) => self.cache = None,
        }

        Ok(())
    }

    /// Releases the session's lease.
    pub fn release(self) {
        self.lease.release();
    }

    fn fresh(&mut self) -> Result<&mut Cached, StorageError> {
        let path = self.log.path();
        let current = file_stamp(&path).map_err(StorageError::read(&path))?;

        match self.cache.take() {
            Some(cached) if cached.stamp == current => Ok(self.cache.insert(cached)),
            _ => Ok(self.cache.insert(self.log.load()?)),
        }
    }
}

fn cached_stamp(cache: &mut Option<Cached>, stamp: Option<FileStamp>) {
    if let Some(cached) = cache {
        cached.stamp = stamp;
    }
}

/// The file at `path` as it was at one moment: its stamp is taken before
/// and after it is read, and a read the two do not agree on is tried once
/// more before it is given up as raced.
fn read_coherently(
    path: &Path,
    read: impl Fn(&Path) -> io::Result<Vec<u8>>,
) -> Result<(Option<FileStamp>, Vec<u8>), StorageError> {
    for _ in 0..2 {
        let before = file_stamp(path).map_err(StorageError::read(path))?;
        let content = match &before {
            None => Vec::new(),
            Some(_) => match read(path) {
                Ok(content) => content,
                Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
                Err(source) => {
                    return Err(StorageError::Read {
                        path: path.to_path_buf(),
                        source,
                    });
                }
            },
        };
        let after = file_stamp(path).map_err(StorageError::read(path))?;

        if before == after {
            return Ok((after, content));
        }
    }

    Err(StorageError::ConcurrentWrite {
        path: path.to_path_buf(),
    })
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use p02_shared::{DanglingLinks, canonical_path};

    use super::*;

    /// storage.coherent-read: a read that meets a change to its file is tried once more, and one whose two attempts both race is refused `concurrent_write`
    #[test]
    fn a_read_the_file_changes_beneath_is_tried_again_once_then_refused() {
        let directory = tempfile::tempdir().unwrap();
        let root = canonical_path(directory.path(), DanglingLinks::Keep).unwrap();
        let path = root.join(RAW_EVENTS_FILE);
        let attempts = Cell::new(0);
        let changing = |changes: usize| {
            let attempts = &attempts;

            move |path: &Path| {
                attempts.set(attempts.get() + 1);

                let content = read_file(path);

                if attempts.get() <= changes {
                    append_line(path, b"{}").unwrap();
                }

                content
            }
        };

        append_line(&path, b"{}").unwrap();

        let (stamp, content) = read_coherently(&path, changing(1)).unwrap();

        assert_eq!(attempts.get(), 2);
        assert_eq!(content, b"{}\n{}\n");
        assert_eq!(stamp, file_stamp(&path).unwrap());

        attempts.set(0);

        let raced = read_coherently(&path, changing(2)).unwrap_err();

        assert_eq!(attempts.get(), 2);
        assert_eq!(raced.code(), "concurrent_write");
    }
}
