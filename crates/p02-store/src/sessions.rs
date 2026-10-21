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
    PathEntry, create_directories, create_directory, describe_entry, list_directory, read_file,
    remove_directory, remove_file, write_file_atomically,
};
use serde::{Deserialize, Serialize};

use crate::character_data::CharacterData;
use crate::error::StorageError;
use crate::jsonl::{committed_lines, holds_a_line};
use crate::layout::{EntryKind, FINDER_METADATA, RAW_EVENTS_FILE};
use crate::lock::{Resource, with_lock};

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
        let content = match read_file(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(source) => return Err(StorageError::Read { path, source }),
        };
        let mut found = None;

        for (line, bytes) in committed_lines(&content) {
            let names_it = serde_json::from_slice::<serde_json::Value>(bytes)
                .ok()
                .and_then(|row| row.get("sessionId").cloned())
                .is_some_and(|named| named == id.to_string());

            if names_it {
                found = Some(decode_row(&path, line, bytes)?);
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

    /// The newest segment of `conversation`, if it has one.
    ///
    /// # Errors
    ///
    /// An error of [`CharacterData::sessions`].
    pub fn latest_segment(
        &self,
        conversation: &ConversationId,
    ) -> Result<Option<SessionEntry>, StorageError> {
        Ok(self
            .read_catalog()?
            .into_values()
            .filter(|entry| entry.session_id.conversation_id() == conversation)
            .max_by_key(|entry| entry.session_id.segment()))
    }

    /// Makes the first segment of `conversation`, `<conversation>.1`.
    ///
    /// # Errors
    ///
    /// [`StorageError::SessionExists`] when it was made before, or an error
    /// of [`CharacterData::sessions`] or of the writes.
    pub fn create_session(
        &self,
        conversation: &ConversationId,
    ) -> Result<SessionEntry, StorageError> {
        let id = SessionId::new(conversation.clone(), NonZeroU64::MIN);

        self.with_catalog(|catalog| {
            if catalog.contains_key(&id) {
                return Err(StorageError::SessionExists(id.clone()));
            }

            self.insert(catalog, id.clone(), &write_file_atomically)
        })
    }

    /// Makes the segment after `from`, which must be its conversation's
    /// newest: the number is chosen and written under one lock, so two
    /// continuations of one segment cannot name one session twice.
    ///
    /// # Errors
    ///
    /// [`StorageError::NotLatestSegment`] when `from` is not the newest, or
    /// an error of [`CharacterData::sessions`] or of the writes.
    pub fn continue_session(&self, from: &SessionId) -> Result<SessionEntry, StorageError> {
        self.with_catalog(|catalog| {
            let latest = catalog
                .keys()
                .filter(|id| id.conversation_id() == from.conversation_id())
                .max_by_key(|id| id.segment());

            if latest != Some(from) {
                return Err(StorageError::NotLatestSegment(from.clone()));
            }

            let next = SessionId::new(
                from.conversation_id().clone(),
                from.segment().saturating_add(1),
            );

            self.insert(catalog, next, &write_file_atomically)
        })
    }

    /// Removes session `id`, which must hold no evidence, for its writer,
    /// whose lease keeps every append out while it goes. The catalog row
    /// goes first; a directory left behind reads as an interrupted start.
    pub(crate) fn discard_empty_session(&self, id: &SessionId) -> Result<(), StorageError> {
        self.with_catalog(|catalog| {
            if catalog.remove(id).is_none() {
                return Ok(());
            }

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

    /// The catalog as the directories agree with it. A catalog that is
    /// missing or empty while directories hold evidence is a catalog lost.
    fn read_catalog(&self) -> Result<Catalog, StorageError> {
        let path = self.catalog_path();
        let content = match read_file(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(source) => return Err(StorageError::Read { path, source }),
        };
        let mut catalog = Catalog::new();

        for (line, bytes) in committed_lines(&content) {
            let entry = decode_row(&path, line, bytes)?;

            catalog.insert(entry.session_id.clone(), entry);
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
                    StorageError::MissingCatalog { path }
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

    /// Adds session `id` to the catalog and makes its directory, or takes
    /// over one an interrupted start left empty. A failed rewrite takes
    /// back the directory it made.
    fn insert(
        &self,
        catalog: &mut Catalog,
        id: SessionId,
        replace: &dyn Fn(&Path, &[u8]) -> io::Result<()>,
    ) -> Result<SessionEntry, StorageError> {
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

        catalog.insert(id, entry.clone());

        if let Err(error) = self.rewrite(catalog, replace) {
            if made {
                remove_directory(&directory).map_err(StorageError::write(&directory))?;
            }

            return Err(error);
        }

        Ok(entry)
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

        let log = directory.join(RAW_EVENTS_FILE);

        if holds_a_line(&read_file(&log).map_err(StorageError::read(&log))?) {
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
    use p02_core::{CharacterProfile, Participant, SpeakerName};
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

    /// storage.atomic-writes: the files the store replaces appear whole and owner-only with no temporary left beside them, also when a write fails, and a failed catalog rewrite takes back the session directory it made
    #[test]
    fn replaced_files_appear_whole_owner_only_and_a_failed_catalog_rewrite_takes_its_directory_back()
     {
        let directory = tempfile::tempdir().unwrap();
        let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());
        let mira = CharacterProfile {
            id: Identifier::new("mira").unwrap(),
            display_name: SpeakerName::new("Mira").unwrap(),
        };
        let data = CharacterData::ensure(&home, &mira.id).unwrap();
        let conversation = home
            .ensure_conversation(vec![
                Participant::character(mira),
                Participant::local_user(SpeakerName::new("Sam").unwrap()),
            ])
            .unwrap();
        let first = data.create_session(conversation.id()).unwrap();
        let conversation_directory = home.conversations_root().join(conversation.id().as_str());
        let replaced = [
            home.root().join("schema.json"),
            data.root().join("schema.json"),
            data.catalog_path(),
            conversation_directory.join("conversation.json"),
        ];

        assert_eq!(
            std::fs::read_to_string(data.catalog_path()).unwrap(),
            format!("{}\n", serde_json::to_string(&first).unwrap())
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
        let next = SessionId::parse(&format!("{}.2", conversation.id())).unwrap();
        let failed = data.with_catalog(|catalog| {
            data.insert(catalog, next.clone(), &|_, _| {
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

        let writer = home.conversation_writer(conversation.id()).unwrap();
        let record = data
            .taken_lines_root()
            .join(format!("{}.json", conversation.id()));

        std::fs::create_dir_all(&record).unwrap();
        assert_eq!(
            TakenLines::default()
                .write(&data, &writer)
                .unwrap_err()
                .code(),
            "write_failed"
        );
        assert_eq!(
            names_in(&data.taken_lines_root()),
            [format!("{}.json", conversation.id())]
        );
        writer.release();
    }
}
