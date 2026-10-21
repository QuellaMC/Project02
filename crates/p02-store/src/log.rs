//! A session's log, `sessions/<session>/raw-events.jsonl`: one record per
//! line, appended and never rewritten. Reading it replays every committed
//! line through the gate; writing it takes the session's writer lease,
//! which one writer holds at a time.
//!
//! A read that must have the whole session fails at the first line the gate
//! refuses. One that reads on past damage, as plugins read history, skips
//! each refused line instead: a refused record changes nothing, so the lines
//! after it are judged as if it were not there, by the same gate.

use std::num::NonZeroU64;
use std::path::{Path, PathBuf};

use p02_core::{
    CharacterProfile, Conversation, Session, SessionId, SpeakerName, VisibleMessageRole,
};
use p02_shared::{FileStamp, PathEntry, append_line, describe_entry, file_stamp};

use crate::character_data::CharacterData;
use crate::error::StorageError;
use crate::jsonl::{committed_lines, read_coherently, read_lines};
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

/// A log as the gate judged it: what the gate took, and each committed line,
/// where it ends and the record of it the gate took, if it took one.
#[derive(Debug)]
pub(crate) struct JudgedLog {
    replay: SessionReplay,
    lines: Vec<(usize, Option<usize>)>,
}

/// What a read does at a committed line the gate refuses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OnDamage {
    Fail,
    Skip,
}

impl CharacterData {
    /// The log of segment `segment` of `conversation`, as this character
    /// keeps it, its user the person, whoever else the conversation is
    /// between.
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
        let participants = conversation.participants();
        let character = participants.iter().find(|participant| {
            participant.kind == VisibleMessageRole::Character && participant.id == *self.character()
        });
        let person = participants
            .iter()
            .find(|participant| participant.is_local_user());
        let (Some(character), Some(person)) = (character, person) else {
            return Err(StorageError::NotAParticipant {
                conversation: conversation.id().clone(),
                participant: self.character().clone(),
            });
        };

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
        Ok(self.load(OnDamage::Fail)?.1.replay)
    }

    /// The log read on past its damage, each line the gate refuses skipped.
    ///
    /// # Errors
    ///
    /// An error of [`SessionLog::read`] but for damage.
    pub(crate) fn read_leniently(&self) -> Result<JudgedLog, StorageError> {
        self.data.session(&self.session)?;
        Ok(self.load(OnDamage::Skip)?.1)
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

        match self.data.session(&self.session).and_then(|_| self.cached()) {
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

    fn cached(&self) -> Result<Cached, StorageError> {
        let (stamp, judged) = self.load(OnDamage::Fail)?;

        Ok(Cached {
            stamp,
            replay: judged.replay,
        })
    }

    fn load(&self, on_damage: OnDamage) -> Result<(Option<FileStamp>, JudgedLog), StorageError> {
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

        let (stamp, content) = read_coherently(&path, || read_lines(&path))?;

        Ok((stamp, self.replay(&path, &content, on_damage)?))
    }

    fn replay(
        &self,
        path: &Path,
        content: &[u8],
        on_damage: OnDamage,
    ) -> Result<JudgedLog, StorageError> {
        let mut judged = JudgedLog {
            replay: SessionReplay::new(Session::new(
                self.session.clone(),
                self.character.clone(),
                self.user_name.clone(),
            )),
            lines: Vec::new(),
        };
        let mut end = 0;

        for (line, bytes) in committed_lines(content) {
            end += bytes.len() + 1;

            let taken = judged.replay.records().len();
            let applied = LogRecord::from_line(bytes)
                .map_err(|source| StorageError::MalformedRecord {
                    path: path.to_path_buf(),
                    line,
                    source,
                })
                .and_then(|record| {
                    judged
                        .replay
                        .apply(record)
                        .map_err(|source| StorageError::BrokenLog {
                            path: path.to_path_buf(),
                            line,
                            source,
                        })
                });

            match (applied, on_damage) {
                (Ok(()), _) => judged.lines.push((end, Some(taken))),
                (Err(_), OnDamage::Skip) => judged.lines.push((end, None)),
                (Err(error), OnDamage::Fail) => return Err(error),
            }
        }

        Ok(judged)
    }
}

impl JudgedLog {
    /// Each committed line, oldest first: where it ends, just past its
    /// newline, and the record of it the gate took, none when it refused it.
    pub(crate) fn lines(&self) -> impl Iterator<Item = (usize, Option<&LogRecord>)> {
        // A taken line's index is the count of records before it was taken.
        self.lines
            .iter()
            .map(|(end, taken)| (*end, taken.map(|index| &self.replay.records()[index])))
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

    /// Discards the session, which must hold no evidence and be its
    /// conversation's newest segment: the rollback of a continuation whose
    /// first record never landed, or the segment an interrupted one left.
    /// Only its writer discards a session, so nothing is appended while it
    /// goes; the lease is released after, whatever the discard came to.
    ///
    /// # Errors
    ///
    /// [`StorageError::SessionNotEmpty`] when the session holds evidence,
    /// [`StorageError::NotLatestSegment`] when a later segment follows it,
    /// or an error of [`CharacterData::sessions`] or of the writes.
    pub fn discard(self) -> Result<(), StorageError> {
        let discarded = self.log.data.discard_empty_session(&self.log.session);

        self.lease.release();
        discarded
    }

    fn fresh(&mut self) -> Result<&mut Cached, StorageError> {
        let path = self.log.path();
        let current = file_stamp(&path).map_err(StorageError::read(&path))?;

        match self.cache.take() {
            Some(cached) if cached.stamp == current => Ok(self.cache.insert(cached)),
            _ => Ok(self.cache.insert(self.log.cached()?)),
        }
    }
}

fn cached_stamp(cache: &mut Option<Cached>, stamp: Option<FileStamp>) {
    if let Some(cached) = cache {
        cached.stamp = stamp;
    }
}
