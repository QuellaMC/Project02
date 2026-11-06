//! A character's sessions catalog, `sessions.jsonl`: one row per session,
//! rewritten whole under its lock, beside one directory per session. The
//! two must agree: a directory holding evidence that the catalog does not
//! list is a session lost, never one to read past.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::io;
use std::num::NonZeroU64;
use std::path::Path;

use p02_core::{ConversationId, SessionId, Timestamp};
use p02_shared::{
    PathEntry, create_directories, create_directory, describe_entry, list_directory,
    remove_directory, remove_file, write_file_atomically,
};
use serde::{Deserialize, Serialize};

use crate::character_data::CharacterData;
use crate::conversations::ConversationWriter;
use crate::error::StorageError;
use crate::jsonl::{committed_lines, holds_a_line, read_coherently, read_lines};
use crate::layout::{EntryKind, FINDER_METADATA, RAW_EVENTS_FILE};
use crate::lock::{Resource, with_lock};
use crate::log::{SessionLog, SessionWriter};

/// A session the catalog lists.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionEntry {
    session_id: SessionId,
    created_at: Timestamp,
}

impl SessionEntry {
    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    #[must_use]
    pub fn created_at(&self) -> &Timestamp {
        &self.created_at
    }
}

type Catalog = BTreeMap<SessionId, SessionEntry>;

impl CharacterData {
    /// Every session the catalog lists, oldest first: by when each was
    /// made, then by id, both in code-point order.
    ///
    /// # Errors
    ///
    /// [`StorageError`] when the catalog cannot be read or does not agree
    /// with the session directories: a damaged row, a session it lists
    /// whose directory is missing or not real, or a directory holding
    /// evidence that it does not list.
    pub fn sessions(&self) -> Result<Vec<SessionEntry>, StorageError> {
        let mut sessions: Vec<SessionEntry> = self.read_catalog()?.into_values().collect();

        sessions.sort_by(by_age);
        Ok(sessions)
    }

    /// The session `id`, as its row says: found even when rows of other
    /// sessions are damaged, so one bad row costs only its own session.
    ///
    /// # Errors
    ///
    /// [`StorageError::SessionNotFound`] when no row names it,
    /// [`StorageError::UncataloguedSession`] when none does but its directory
    /// holds evidence, and an error when its own row is damaged or its
    /// directory is missing or not real.
    pub fn session(&self, id: &SessionId) -> Result<SessionEntry, StorageError> {
        let path = self.catalog_path();

        read_coherently(&path, || self.agreeing_row(&path, id)).map(|(_, entry)| entry)
    }

    /// The newest segment of `conversation`, if it has one.
    ///
    /// # Errors
    ///
    /// An error of [`CharacterData::sessions`].
    pub fn latest_segment(
        &self,
        conversation: &ConversationId,
    ) -> Result<Option<SessionEntry>, StorageError> {
        Ok(newest(&self.read_catalog()?, conversation).cloned())
    }

    /// Makes the first segment, `<conversation>.1`, of the conversation
    /// `holder` holds, and hands back its writer: only its holder makes a
    /// conversation's segments, and each is listed and its writer taken
    /// under one lock. When the writer cannot be taken, the row and the
    /// directory it made are taken back before the error leaves.
    ///
    /// # Errors
    ///
    /// [`StorageError::SessionExists`] when it was made before,
    /// [`StorageError::NotAParticipant`] when the conversation is not
    /// between this character and the person, or an error of
    /// [`CharacterData::sessions`], of the writes or of
    /// [`SessionLog::writer`].
    pub fn create_session(
        &self,
        holder: &ConversationWriter,
    ) -> Result<SessionWriter, StorageError> {
        let log = self.session_log(holder.conversation(), NonZeroU64::MIN)?;

        self.with_catalog(|catalog| {
            if catalog.contains_key(log.session_id()) {
                return Err(StorageError::SessionExists(log.session_id().clone()));
            }

            self.insert(catalog, log, &write_file_atomically)
        })
    }

    /// Makes the segment after `from`, which must be the newest of the
    /// conversation `holder` holds, and hands back its writer: only its
    /// holder makes a conversation's segments, so none comes after one it
    /// is still writing, and the number is chosen, the segment listed and
    /// its writer taken under one lock. When the writer cannot be taken,
    /// the row and the directory it made are taken back before the error
    /// leaves.
    ///
    /// # Errors
    ///
    /// [`StorageError::NotLatestSegment`] when `from` is not the newest
    /// segment of the conversation `holder` holds,
    /// [`StorageError::NotAParticipant`] when that conversation is not
    /// between this character and the person, or an error of
    /// [`CharacterData::sessions`], of the writes or of
    /// [`SessionLog::writer`].
    pub fn continue_session(
        &self,
        holder: &ConversationWriter,
        from: &SessionId,
    ) -> Result<SessionWriter, StorageError> {
        let conversation = holder.conversation();
        let log = self.session_log(conversation, from.segment().saturating_add(1))?;

        self.with_catalog(|catalog| {
            if newest(catalog, conversation.id()).map(SessionEntry::session_id) != Some(from) {
                return Err(StorageError::NotLatestSegment(from.clone()));
            }

            self.insert(catalog, log, &write_file_atomically)
        })
    }

    /// Removes session `id`, which must hold no evidence and be its
    /// conversation's newest segment, so the segments left run unbroken
    /// from the first; for its writer, whose lease keeps every append out
    /// while it goes. The catalog row goes first; a directory left behind
    /// reads as an interrupted start.
    pub(crate) fn discard_empty_session(&self, id: &SessionId) -> Result<(), StorageError> {
        self.with_catalog(|catalog| {
            if newest(catalog, id.conversation_id()).map(SessionEntry::session_id) != Some(id) {
                return Err(StorageError::NotLatestSegment(id.clone()));
            }

            catalog.remove(id);

            let directory = self.sessions_root().join(id.to_string());

            if holds_evidence(&directory)? {
                return Err(StorageError::SessionNotEmpty(id.clone()));
            }

            self.rewrite(catalog, &write_file_atomically)?;

            for leftover in [RAW_EVENTS_FILE, FINDER_METADATA] {
                let path = directory.join(leftover);

                match remove_file(&path) {
                    Err(error) if error.kind() != io::ErrorKind::NotFound => {
                        return Err(StorageError::Write {
                            path,
                            source: error,
                        });
                    }
                    _ => {}
                }
            }

            remove_directory(&directory).map_err(StorageError::write(&directory))
        })
    }

    fn with_catalog<T>(
        &self,
        work: impl FnOnce(&mut Catalog) -> Result<T, StorageError>,
    ) -> Result<T, StorageError> {
        let locks = self.locks_root();

        with_lock(&locks, &Resource::SessionCatalog, || {
            let mut catalog = self.read_catalog()?;

            work(&mut catalog)
        })
    }

    /// The catalog as the directories agree with it, both as they were at
    /// one moment, so a session made or discarded while they are read is
    /// never taken for damage.
    fn read_catalog(&self) -> Result<Catalog, StorageError> {
        let path = self.catalog_path();

        read_coherently(&path, || self.agreeing_catalog(&path)).map(|(_, catalog)| catalog)
    }

    /// Row `id` of the catalog at `path` as its directory agrees with it,
    /// read once.
    fn agreeing_row(&self, path: &Path, id: &SessionId) -> Result<SessionEntry, StorageError> {
        let content = read_lines(path)?;
        let mut found = None;

        for (line, bytes) in committed_lines(&content) {
            let names_it = serde_json::from_slice::<serde_json::Value>(bytes)
                .ok()
                .and_then(|row| row.get("sessionId").cloned())
                .is_some_and(|named| named == id.to_string());

            if names_it {
                if found.is_some() {
                    return Err(StorageError::RepeatedCatalogRow {
                        path: path.to_path_buf(),
                        line,
                        session: id.clone(),
                    });
                }

                found = Some(decode_row(path, line, bytes)?);
            }
        }

        let directory = self.sessions_root().join(id.to_string());

        let Some(entry) = found else {
            return Err(if holds_evidence(&directory)? {
                StorageError::UncataloguedSession { path: directory }
            } else {
                StorageError::SessionNotFound(id.clone())
            });
        };

        check_session_directory(&directory)?;
        Ok(entry)
    }

    /// The catalog at `path` as the directories agree with it, read once.
    /// A catalog that is missing or empty while directories hold evidence
    /// is a catalog lost.
    fn agreeing_catalog(&self, path: &Path) -> Result<Catalog, StorageError> {
        let content = read_lines(path)?;
        let mut catalog = Catalog::new();

        for (line, bytes) in committed_lines(&content) {
            let entry = decode_row(path, line, bytes)?;
            let session = entry.session_id.clone();

            if catalog.insert(session.clone(), entry).is_some() {
                return Err(StorageError::RepeatedCatalogRow {
                    path: path.to_path_buf(),
                    line,
                    session,
                });
            }
        }

        let sessions_root = self.sessions_root();
        let entries = match list_directory(&sessions_root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(source) => {
                return Err(StorageError::Read {
                    path: sessions_root,
                    source,
                });
            }
        };

        for (name, entry) in entries {
            if name == FINDER_METADATA {
                continue;
            }

            let directory = sessions_root.join(&name);
            let listed = name
                .to_str()
                .and_then(|name| SessionId::parse(name).ok())
                .is_some_and(|id| catalog.contains_key(&id));

            if !matches!(entry, PathEntry::Directory) {
                return Err(if listed {
                    StorageError::NotReal {
                        path: directory,
                        expected: EntryKind::Directory,
                    }
                } else {
                    StorageError::UnsupportedEntry { path: directory }
                });
            }

            if !listed && holds_evidence(&directory)? {
                return Err(if catalog.is_empty() {
                    StorageError::MissingCatalog {
                        path: path.to_path_buf(),
                    }
                } else {
                    StorageError::UncataloguedSession { path: directory }
                });
            }
        }

        for id in catalog.keys() {
            check_session_directory(&sessions_root.join(id.to_string()))?;
        }

        Ok(catalog)
    }

    /// Lists the session of `log` and makes its directory, or takes over one
    /// an interrupted start left empty, then takes its writer. When the
    /// rewrite fails, the directory it made is taken back; when the writer
    /// cannot be taken, the row is taken back too, then that directory. No
    /// session is left listed that nobody writes, unless taking its row back
    /// fails as well, which leaves it listed and empty, as a crash before its
    /// first record would.
    fn insert(
        &self,
        catalog: &mut Catalog,
        log: SessionLog,
        replace: &dyn Fn(&Path, &[u8]) -> io::Result<()>,
    ) -> Result<SessionWriter, StorageError> {
        let id = log.session_id().clone();
        let sessions_root = self.sessions_root();
        let directory = sessions_root.join(id.to_string());

        if holds_evidence(&directory)? {
            return Err(StorageError::UncataloguedSession { path: directory });
        }

        create_directories(&sessions_root).map_err(StorageError::write(&sessions_root))?;

        let made = match create_directory(&directory) {
            Ok(()) => true,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                check_session_directory(&directory)?;
                false
            }
            Err(source) => {
                return Err(StorageError::Write {
                    path: directory,
                    source,
                });
            }
        };
        let entry = SessionEntry {
            session_id: id.clone(),
            created_at: Timestamp::now(),
        };

        catalog.insert(id.clone(), entry);

        let failure = match self.rewrite(catalog, replace) {
            Err(error) => error,
            Ok(()) => match log.writer() {
                Ok(writer) => return Ok(writer),
                Err(error) => {
                    catalog.remove(&id);
                    self.rewrite(catalog, replace)?;
                    error
                }
            },
        };

        if made {
            remove_directory(&directory).map_err(StorageError::write(&directory))?;
        }

        Err(failure)
    }

    fn rewrite(
        &self,
        catalog: &Catalog,
        replace: &dyn Fn(&Path, &[u8]) -> io::Result<()>,
    ) -> Result<(), StorageError> {
        let mut rows: Vec<&SessionEntry> = catalog.values().collect();

        rows.sort_by(|left, right| by_age(left, right));

        let mut content = Vec::new();

        for row in rows {
            serde_json::to_writer(&mut content, row)
                .expect("a row of plain fields always serializes");
            content.push(b'\n');
        }

        let path = self.catalog_path();

        replace(&path, &content).map_err(StorageError::write(&path))
    }
}

/// The newest segment of `conversation` the catalog lists.
fn newest<'a>(catalog: &'a Catalog, conversation: &ConversationId) -> Option<&'a SessionEntry> {
    catalog
        .values()
        .filter(|entry| entry.session_id.conversation_id() == conversation)
        .max_by_key(|entry| entry.session_id.segment())
}

/// Oldest first: by when each session was made, then by its id, both in
/// code-point order, whatever the locale.
fn by_age(left: &SessionEntry, right: &SessionEntry) -> Ordering {
    (left.created_at.as_str(), left.session_id.to_string())
        .cmp(&(right.created_at.as_str(), right.session_id.to_string()))
}

fn decode_row(path: &Path, line: usize, bytes: &[u8]) -> Result<SessionEntry, StorageError> {
    serde_json::from_slice(bytes).map_err(|source| StorageError::MalformedCatalogRow {
        path: path.to_path_buf(),
        line,
        source,
    })
}

fn check_session_directory(directory: &Path) -> Result<(), StorageError> {
    match describe_entry(directory) {
        PathEntry::Directory => Ok(()),
        PathEntry::Absent => Err(StorageError::MissingSessionDirectory {
            path: directory.to_path_buf(),
        }),
        PathEntry::Unreadable(source) => Err(StorageError::Read {
            path: directory.to_path_buf(),
            source,
        }),
        PathEntry::File | PathEntry::Link | PathEntry::Other => Err(StorageError::NotReal {
            path: directory.to_path_buf(),
            expected: EntryKind::Directory,
        }),
    }
}

/// Whether a session directory holds what a session leaves: anything but
/// Finder's metadata and a log that never committed a line, which is what
/// a start or a discard a crash interrupted leaves.
pub(crate) fn holds_evidence(directory: &Path) -> Result<bool, StorageError> {
    let entries = match list_directory(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(source) => {
            return Err(StorageError::Read {
                path: directory.to_path_buf(),
                source,
            });
        }
    };

    for (name, entry) in entries {
        if name == FINDER_METADATA {
            continue;
        }

        if name != RAW_EVENTS_FILE || !matches!(entry, PathEntry::File) {
            return Ok(true);
        }

        if holds_a_line(&read_lines(&directory.join(RAW_EVENTS_FILE))?) {
            return Ok(true);
        }
    }

    Ok(false)
}

#[cfg(test)]
#[expect(
    clippy::disallowed_methods,
    reason = "a test reads the files the store wrote, and puts a directory where one must fail"
)]
mod tests {
    use p02_core::{CharacterProfile, Conversation, Participant, SpeakerName};
    use p02_shared::{DanglingLinks, Identifier, canonical_path, temporary_target};

    use super::*;
    use crate::home::Home;
    use crate::taken_lines::TakenLines;

    fn names_in(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();

        names.sort();
        names
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt as _;

        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    /// storage.atomic-writes: the files the store replaces appear whole and owner-only with no temporary left beside them, also when a write fails, and a failed catalog rewrite, like a conversation's failed make, takes back the directory it made
    #[test]
    fn replaced_files_appear_whole_owner_only_and_a_failed_make_takes_its_directory_back() {
        let directory = tempfile::tempdir().unwrap();
        let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());
        let mira = CharacterProfile {
            id: Identifier::new("mira").unwrap(),
            display_name: SpeakerName::new("Mira").unwrap(),
        };
        let data = CharacterData::ensure(&home, &mira.id).unwrap();
        let participants = vec![
            Participant::character(mira),
            Participant::local_user(SpeakerName::new("Sam").unwrap()),
        ];
        let conversation = home.ensure_conversation(participants.clone()).unwrap();
        let holder = home.conversation_writer(conversation.clone()).unwrap();
        let first = data.create_session(&holder).unwrap();
        let conversation_directory = home.conversations_root().join(conversation.id().as_str());
        let replaced = [
            home.root().join("schema.json"),
            data.root().join("schema.json"),
            data.catalog_path(),
            conversation_directory.join("conversation.json"),
        ];

        assert_eq!(
            std::fs::read_to_string(data.catalog_path()).unwrap(),
            format!(
                "{}\n",
                serde_json::to_string(&data.session(first.session_id()).unwrap()).unwrap()
            )
        );
        for path in &replaced {
            assert!(
                std::fs::read(path).unwrap().ends_with(b"}\n"),
                "{}",
                path.display()
            );
            #[cfg(unix)]
            assert_eq!(mode_of(path), 0o600, "{}", path.display());
        }
        for directory in [home.root(), data.root(), &conversation_directory] {
            assert!(
                names_in(directory)
                    .iter()
                    .all(|name| temporary_target(name.as_ref()).is_none()),
                "{}",
                directory.display()
            );
        }

        let catalog = std::fs::read(data.catalog_path()).unwrap();
        let next = data
            .session_log(&conversation, NonZeroU64::new(2).unwrap())
            .unwrap();
        let failed = data.with_catalog(|catalog| {
            data.insert(catalog, next, &|_, _| {
                Err(io::Error::new(
                    io::ErrorKind::StorageFull,
                    "the disk is full",
                ))
            })
        });

        assert_eq!(failed.unwrap_err().code(), "write_failed");
        assert_eq!(std::fs::read(data.catalog_path()).unwrap(), catalog);
        assert_eq!(
            names_in(&data.sessions_root()),
            [first.session_id().to_string()]
        );

        let unmade = Conversation::new(
            ConversationId::new("conv_unmade").unwrap(),
            participants,
            Timestamp::now(),
        )
        .unwrap();
        let refused = home.write_conversation(&unmade, &|_, _| {
            Err(io::Error::new(
                io::ErrorKind::StorageFull,
                "the disk is full",
            ))
        });

        assert_eq!(refused.unwrap_err().code(), "write_failed");
        assert_eq!(
            names_in(&home.conversations_root()),
            [conversation.id().to_string()]
        );

        let record = data
            .taken_lines_root()
            .join(format!("{}.json", conversation.id()));

        std::fs::create_dir_all(&record).unwrap();
        assert_eq!(
            TakenLines::default()
                .write(&data, &holder)
                .unwrap_err()
                .code(),
            "write_failed"
        );
        assert_eq!(
            names_in(&data.taken_lines_root()),
            [format!("{}.json", conversation.id())]
        );
        first.release();
        holder.release();
    }
}
