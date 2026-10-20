//! A character's storage as the store crate will serve it: the session
//! history, each plugin's files, and each plugin's databases.

use std::collections::BTreeMap;
use std::io;
use std::num::{NonZeroU32, NonZeroU64};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use p02_contracts::{
    CharacterStorage, DatabaseError, DatabaseOpener, FileStoreBackend, HistoryCursor,
    HistoryMessage, LeasedFiles, MessageBatch, ReadMessages, SessionHistoryError,
    SessionHistoryFeed, SessionListing, SessionSummary, StoreError,
};
use p02_core::{
    MessageId, SessionId, SpeakerName, Timestamp, VisibleMessage, VisibleMessageRole, VisibleText,
};
use p02_shared::{DanglingLinks, Identifier, canonical_path, write_file_atomically};
use rusqlite::Connection;
use serde_json::Value;
use tempfile::TempDir;

use crate::support::{Gate, id};

/// A character's storage, in memory but for the databases, which live in
/// a canonical temporary directory as the store crate keeps them on disk.
#[derive(Debug)]
pub(crate) struct Storage {
    _directory: TempDir,
    root: PathBuf,
    pub(crate) history: Arc<Feed>,
    files: Mutex<BTreeMap<Identifier, Arc<Files>>>,
    openers: Mutex<BTreeMap<Identifier, Arc<Opener>>>,
}

impl Storage {
    pub(crate) fn new() -> Arc<Self> {
        let directory = TempDir::new().unwrap();
        let root = canonical_path(directory.path(), DanglingLinks::Keep).unwrap();

        Arc::new(Self {
            _directory: directory,
            root,
            history: Arc::new(Feed::new()),
            files: Mutex::new(BTreeMap::new()),
            openers: Mutex::new(BTreeMap::new()),
        })
    }

    /// The plugin's store, as the host hands it out.
    pub(crate) fn files(&self, plugin_id: &str) -> Arc<Files> {
        Arc::clone(self.files.lock().unwrap().entry(id(plugin_id)).or_default())
    }

    /// The names of the files the databases left in the directory.
    #[expect(
        clippy::disallowed_methods,
        reason = "a test lists the directory the store crate will own"
    )]
    pub(crate) fn files_on_disk(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();

        names.sort();
        names
    }

    /// The plugin's databases, as the host hands them out.
    pub(crate) fn opener(&self, plugin_id: &str) -> Arc<Opener> {
        let plugin_id = id(plugin_id);

        Arc::clone(
            self.openers
                .lock()
                .unwrap()
                .entry(plugin_id.clone())
                .or_insert_with(|| {
                    Arc::new(Opener {
                        directory: self.root.clone(),
                        plugin_id,
                        opened: AtomicUsize::new(0),
                    })
                }),
        )
    }
}

impl CharacterStorage for Storage {
    fn session_history(&self) -> Arc<dyn SessionHistoryFeed> {
        Arc::clone(&self.history) as _
    }

    fn file_store(&self, plugin_id: &Identifier) -> Arc<dyn FileStoreBackend> {
        self.files(plugin_id.as_str()) as _
    }

    fn databases(&self, plugin_id: &Identifier) -> Arc<dyn DatabaseOpener> {
        self.opener(plugin_id.as_str()) as _
    }
}

/// A plugin's documents.
#[derive(Debug, Default)]
pub(crate) struct Files {
    documents: Mutex<BTreeMap<String, Value>>,
}

#[derive(Debug)]
struct Leased<'a>(MutexGuard<'a, BTreeMap<String, Value>>);

impl Files {
    pub(crate) fn get(&self, path: &str) -> Option<Value> {
        self.documents.lock().unwrap().get(path).cloned()
    }
}

impl FileStoreBackend for Files {
    fn lease(
        &self,
        _deadline: std::time::Instant,
    ) -> Result<Box<dyn LeasedFiles + '_>, StoreError> {
        Ok(Box::new(Leased(self.documents.lock().unwrap())))
    }
}

impl LeasedFiles for Leased<'_> {
    fn read_json(&self, path: &str) -> Result<Option<Value>, StoreError> {
        Ok(self.0.get(path).cloned())
    }

    fn read_jsonl(&self, _path: &str) -> Result<Vec<Value>, StoreError> {
        Ok(Vec::new())
    }

    fn write_json(&mut self, path: &str, value: &Value) -> Result<(), StoreError> {
        self.0.insert(path.to_owned(), value.clone());
        Ok(())
    }

    fn append_jsonl(&mut self, _path: &str, _value: &Value) -> Result<(), StoreError> {
        Ok(())
    }

    fn revision(&self) -> Result<u64, StoreError> {
        Ok(0)
    }
}

/// A plugin's databases, one SQLite file each, opened as the store crate
/// will: at the plugin's version, and rebuilt empty when the file holds
/// another version or is no database at all.
#[derive(Debug)]
pub(crate) struct Opener {
    directory: PathBuf,
    plugin_id: Identifier,
    opened: AtomicUsize,
}

impl Opener {
    pub(crate) fn path(&self, name: &str) -> PathBuf {
        self.directory
            .join(format!("{}.{name}.sqlite", self.plugin_id))
    }

    pub(crate) fn opened(&self) -> usize {
        self.opened.load(Ordering::SeqCst)
    }

    /// Marks the database as written by another version.
    pub(crate) fn stamp_version(&self, name: &str, version: u32) {
        connect(&self.path(name))
            .unwrap()
            .pragma_update(None, "user_version", version)
            .unwrap();
    }

    pub(crate) fn version(&self, name: &str) -> u32 {
        connect(&self.path(name))
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
    }

    pub(crate) fn corrupt(&self, name: &str) {
        write_file_atomically(&self.path(name), b"not a database").unwrap();
    }
}

impl DatabaseOpener for Opener {
    fn open(
        &self,
        name: &Identifier,
        schema_version: NonZeroU32,
        initialize: &dyn Fn(&Connection) -> rusqlite::Result<()>,
    ) -> Result<Connection, DatabaseError> {
        let path = self.path(name.as_str());
        let failed = |error: rusqlite::Error| DatabaseError::Open(Box::new(error));

        self.opened.fetch_add(1, Ordering::SeqCst);

        if let Ok(Some(connection)) = at_version(&path, schema_version, initialize) {
            return Ok(connection);
        }

        write_file_atomically(&path, b"").map_err(|error| DatabaseError::Open(Box::new(error)))?;
        at_version(&path, schema_version, initialize)
            .map_err(failed)?
            .ok_or_else(|| DatabaseError::Open("a rebuilt database kept another version".into()))
    }
}

/// The database at `version`, initialized when new; none when it holds
/// another version.
fn at_version(
    path: &Path,
    version: NonZeroU32,
    initialize: &dyn Fn(&Connection) -> rusqlite::Result<()>,
) -> rusqlite::Result<Option<Connection>> {
    let connection = connect(path)?;
    let found: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;

    if found == version.get() {
        return Ok(Some(connection));
    }

    if found != 0 {
        return Ok(None);
    }

    let transaction = connection.unchecked_transaction()?;

    initialize(&transaction)?;
    transaction.pragma_update(None, "user_version", version.get())?;
    transaction.commit()?;
    Ok(Some(connection))
}

#[expect(
    clippy::disallowed_methods,
    reason = "the store crate opens every database of the daemon; until it exists, the tests' \
              opener stands in for it"
)]
fn connect(path: &Path) -> rusqlite::Result<Connection> {
    let connection = Connection::open(path)?;

    // Opened as the store crate will open every plugin database: a
    // write-ahead log synced at checkpoints, not at each commit, which a
    // crash of the process survives and a slow disk does not stall.
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(connection)
}

/// One character's session history as the store crate serves it: a
/// catalog of sessions, each a log of records read from an opaque cursor.
#[derive(Debug)]
pub(crate) struct Feed {
    log: Mutex<Log>,
    reads: Mutex<Vec<(String, Option<String>)>>,
    held: Mutex<Option<(usize, Arc<Gate>)>>,
}

#[derive(Debug, Default)]
struct Log {
    said: u64,
    sessions: Vec<(SessionSummary, Vec<Record>)>,
    damaged_entries: u64,
    failure: Option<String>,
    records_per_read: Option<usize>,
}

#[derive(Debug)]
enum Record {
    Message(HistoryMessage),
    Damaged,
}

impl Feed {
    fn new() -> Self {
        Self {
            log: Mutex::new(Log::default()),
            reads: Mutex::new(Vec::new()),
            held: Mutex::new(None),
        }
    }

    /// Commits a message to the session, opening it if it is new. Every
    /// message is committed a second after the one before.
    pub(crate) fn say(&self, session: &str, role: VisibleMessageRole, text: &str) -> String {
        let speaker = match role {
            VisibleMessageRole::User => "You",
            VisibleMessageRole::Character => "Mira",
        };

        self.say_as(session, role, speaker, text)
    }

    pub(crate) fn say_as(
        &self,
        session: &str,
        role: VisibleMessageRole,
        speaker: &str,
        text: &str,
    ) -> String {
        let mut log = self.log.lock().unwrap();

        log.said += 1;

        let second = log.said;
        let records = log.session(session);
        let number = records
            .iter()
            .filter(|record| matches!(record, Record::Message(_)))
            .count()
            + 1;
        let speaker_id = match role {
            VisibleMessageRole::User => "local-user",
            VisibleMessageRole::Character => "mira",
        };
        let message_id = MessageId::new(
            SessionId::new(session).unwrap(),
            NonZeroU64::new(u64::try_from(number).unwrap()).unwrap(),
        );

        records.push(Record::Message(HistoryMessage {
            message: VisibleMessage {
                id: message_id.clone(),
                role,
                speaker_id: id(speaker_id),
                speaker_name: SpeakerName::new(speaker).unwrap(),
                text: VisibleText::normalize(text).unwrap(),
            },
            committed_at: Timestamp::new(&format!(
                "2026-10-18T{:02}:{:02}:{:02}.000Z",
                second / 3_600,
                second / 60 % 60,
                second % 60
            ))
            .unwrap(),
        }));
        message_id.to_string()
    }

    /// Commits a person's line and the character's answer.
    pub(crate) fn exchange(&self, session: &str, line: &str, answer: &str) {
        self.say(session, VisibleMessageRole::User, line);
        self.say(session, VisibleMessageRole::Character, answer);
    }

    /// A record of the session that does not read.
    pub(crate) fn damage(&self, session: &str) {
        self.log
            .lock()
            .unwrap()
            .session(session)
            .push(Record::Damaged);
    }

    /// A catalog entry that does not read.
    pub(crate) fn damage_catalog(&self) {
        self.log.lock().unwrap().damaged_entries += 1;
    }

    /// The catalog no longer lists the session.
    pub(crate) fn forget(&self, session: &str) {
        let session = SessionId::new(session).unwrap();

        self.log
            .lock()
            .unwrap()
            .sessions
            .retain(|(summary, _)| summary.session_id != session);
    }

    /// The session's log keeps only its first `records`: it shrank.
    pub(crate) fn shrink(&self, session: &str, records: usize) {
        self.log.lock().unwrap().session(session).truncate(records);
    }

    /// Every read fails, saying `why`.
    pub(crate) fn fail(&self, why: &str) {
        self.log.lock().unwrap().failure = Some(why.to_owned());
    }

    /// A read serves no more than `records` records.
    pub(crate) fn serve_at_most(&self, records: usize) {
        self.log.lock().unwrap().records_per_read = Some(records);
    }

    /// Reads after the first `reads` wait at `gate`.
    pub(crate) fn hold_after(&self, reads: usize, gate: Arc<Gate>) {
        *self.held.lock().unwrap() = Some((reads, gate));
    }

    /// Each read's session and cursor, in order.
    pub(crate) fn reads(&self) -> Vec<(String, Option<String>)> {
        self.reads.lock().unwrap().clone()
    }
}

impl Log {
    fn session(&mut self, session: &str) -> &mut Vec<Record> {
        let session_id = SessionId::new(session).unwrap();
        let at = self
            .sessions
            .iter()
            .position(|(summary, _)| summary.session_id == session_id)
            .unwrap_or_else(|| {
                self.sessions.push((
                    SessionSummary {
                        session_id,
                        created_at: Timestamp::new("2026-10-01T00:00:00.000Z").unwrap(),
                    },
                    Vec::new(),
                ));
                self.sessions.len() - 1
            });

        &mut self.sessions[at].1
    }
}

impl SessionHistoryFeed for Feed {
    fn list_sessions(&self) -> Result<SessionListing, SessionHistoryError> {
        let log = self.log.lock().unwrap();

        if let Some(why) = &log.failure {
            return Err(SessionHistoryError::Feed(Box::new(io::Error::other(
                why.clone(),
            ))));
        }

        Ok(SessionListing {
            sessions: log
                .sessions
                .iter()
                .map(|(summary, _)| summary.clone())
                .collect(),
            damaged_entry_count: log.damaged_entries,
        })
    }

    fn read_messages(&self, request: &ReadMessages) -> Result<MessageBatch, SessionHistoryError> {
        let read = {
            let mut reads = self.reads.lock().unwrap();

            reads.push((
                request.session_id().to_string(),
                request.cursor().map(|cursor| cursor.as_str().to_owned()),
            ));
            reads.len()
        };
        let held = self.held.lock().unwrap().clone();

        if let Some((after, gate)) = held
            && read > after
        {
            gate.wait();
        }

        let log = self.log.lock().unwrap();

        if let Some(why) = &log.failure {
            return Err(SessionHistoryError::Feed(Box::new(io::Error::other(
                why.clone(),
            ))));
        }

        let records = log
            .sessions
            .iter()
            .find(|(summary, _)| &summary.session_id == request.session_id())
            .map_or(&[][..], |(_, records)| records.as_slice());
        let cursor = request
            .cursor()
            .map(|cursor| cursor.as_str().parse::<usize>());
        let (start, reset) = match cursor {
            None => (0, false),
            Some(Ok(at)) if at <= records.len() => (at, false),
            Some(_) => (0, true),
        };
        let budget = request
            .max_bytes()
            .map_or(usize::MAX, std::num::NonZeroUsize::get);
        let mut end = start;
        let mut bytes = 0;

        while let Some(record) = records.get(end) {
            let size = match record {
                Record::Message(message) => message.message.text.as_str().len(),
                Record::Damaged => 1,
            };

            if end > start
                && (bytes + size > budget
                    || log.records_per_read.is_some_and(|most| end - start >= most))
            {
                break;
            }

            bytes += size;
            end += 1;
        }

        Ok(MessageBatch {
            messages: records[start..end]
                .iter()
                .filter_map(|record| match record {
                    Record::Message(message) => Some(message.clone()),
                    Record::Damaged => None,
                })
                .collect(),
            next_cursor: HistoryCursor::new(end.to_string()),
            damaged_record_count: records[start..end]
                .iter()
                .filter(|record| matches!(record, Record::Damaged))
                .count()
                .try_into()
                .unwrap(),
            reset,
        })
    }
}
