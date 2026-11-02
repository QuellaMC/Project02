use std::sync::Arc;

use p02_core::{CharacterProfile, EventIdentity, MessageId, SessionId, VisibleText};
use p02_shared::Identifier;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::capability::{
    DatabaseOpener, FileStore, FileStoreBackend, PluginDatabase, SessionHistory,
    SessionHistoryFeed, StoreAccess, WriteHold,
};
use crate::label::RedactionLabel;

/// Which turn a hook serves. The host stamps it on everything the plugin
/// returns, so a plugin cannot write a record of another turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnIdentity {
    pub session_id: SessionId,
    pub event: EventIdentity,
    pub character: CharacterProfile,
}

/// What was said this turn, shown only to a plugin granted
/// `turn_context: read`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnText {
    pub current_user_message: VisibleText,
    /// The visible messages in the model's window as the hook was called.
    pub recent_visible_message_ids: Vec<MessageId>,
}

/// One hook call's view of its turn: who and when, the hook's cancellation,
/// and only the capabilities its plugin was granted.
///
/// Cancellation is cooperative. When the hook overruns its plugin's budget
/// the host cancels the token and hears the hook for a second more, so a
/// hook that stops at the token answers with what it gave up; when the
/// turn is abandoned the host cancels it and stops waiting. Async work
/// should watch it, and every capability handle refuses each later call,
/// so a hook past its deadline finishes the call it is in and starts no
/// other.
#[derive(Clone, Debug)]
pub struct HookContext {
    plugin_id: Identifier,
    turn: Arc<TurnIdentity>,
    deadline: Instant,
    cancellation: CancellationToken,
    turn_text: Option<Arc<TurnText>>,
    privacy_labels: Arc<[RedactionLabel]>,
    character_file_store: Option<FileStore>,
    session_history: Option<SessionHistory>,
    plugin_database: Option<PluginDatabase>,
}

impl HookContext {
    /// A context that grants nothing yet; the host adds what the plugin
    /// may see. `cancellation` is the hook's own token, a child of its
    /// turn's.
    #[must_use]
    pub fn new(
        plugin_id: Identifier,
        turn: Arc<TurnIdentity>,
        deadline: Instant,
        cancellation: CancellationToken,
    ) -> Self {
        Self {
            plugin_id,
            turn,
            deadline,
            cancellation,
            turn_text: None,
            privacy_labels: Arc::from([]),
            character_file_store: None,
            session_history: None,
            plugin_database: None,
        }
    }

    /// Shows the turn's text (`turn_context: read`).
    #[must_use]
    pub fn with_turn_text(mut self, turn_text: Arc<TurnText>) -> Self {
        self.turn_text = Some(turn_text);
        self
    }

    /// The privacy labels the runtime attached to the turn.
    #[must_use]
    pub fn with_privacy_labels(mut self, labels: Arc<[RedactionLabel]>) -> Self {
        self.privacy_labels = labels;
        self
    }

    /// Grants the plugin's character-scoped store (`character_file_store`),
    /// held to this hook's deadline and cancellation. The host keeps the
    /// hold until the hook settles, and no later than its deadline.
    pub fn with_character_file_store(
        mut self,
        backend: Arc<dyn FileStoreBackend>,
        access: StoreAccess,
    ) -> (Self, WriteHold) {
        let (store, hold) =
            FileStore::new(backend, access, self.deadline, self.cancellation.clone());

        self.character_file_store = Some(store);
        (self, hold)
    }

    /// Grants the session history of the turn's character
    /// (`session_history: read`); the turn alone says whose it is.
    #[must_use]
    pub fn with_session_history(mut self, feed: Arc<dyn SessionHistoryFeed>) -> Self {
        self.session_history = Some(SessionHistory::new(feed, self.cancellation.clone()));
        self
    }

    /// Grants the plugin's own databases (`plugin_database: write`).
    #[must_use]
    pub fn with_plugin_database(mut self, opener: Arc<dyn DatabaseOpener>) -> Self {
        self.plugin_database = Some(PluginDatabase::new(opener, self.cancellation.clone()));
        self
    }

    #[must_use]
    pub fn plugin_id(&self) -> &Identifier {
        &self.plugin_id
    }

    #[must_use]
    pub fn turn(&self) -> &TurnIdentity {
        &self.turn
    }

    /// Cancelled when the hook overruns its budget or its turn is
    /// abandoned.
    #[must_use]
    pub fn cancellation(&self) -> &CancellationToken {
        &self.cancellation
    }

    /// The turn's text: absent, never empty, for a plugin without
    /// `turn_context: read`, so a scrubbed message cannot pass for one.
    #[must_use]
    pub fn turn_text(&self) -> Option<&TurnText> {
        self.turn_text.as_deref()
    }

    #[must_use]
    pub fn privacy_labels(&self) -> &[RedactionLabel] {
        &self.privacy_labels
    }

    #[must_use]
    pub fn character_file_store(&self) -> Option<&FileStore> {
        self.character_file_store.as_ref()
    }

    #[must_use]
    pub fn session_history(&self) -> Option<&SessionHistory> {
        self.session_history.as_ref()
    }

    #[must_use]
    pub fn plugin_database(&self) -> Option<&PluginDatabase> {
        self.plugin_database.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::num::NonZeroU32;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Mutex, MutexGuard};
    use std::time::Duration;

    use p02_core::{EventId, SpeakerName, Timestamp, TraceId};
    use rusqlite::Connection;
    use serde_json::{Value, json};

    use super::*;
    use crate::capability::{
        DatabaseError, LeasedFiles, MessageBatch, ReadMessages, SessionHistoryError,
        SessionListing, StoreError,
    };

    #[derive(Debug, Default)]
    struct Memory {
        files: Mutex<BTreeMap<String, Value>>,
        leases: AtomicUsize,
    }

    #[derive(Debug)]
    struct MemoryFiles<'a>(MutexGuard<'a, BTreeMap<String, Value>>);

    impl FileStoreBackend for Memory {
        fn lease(
            &self,
            _deadline: std::time::Instant,
        ) -> Result<Box<dyn LeasedFiles + '_>, StoreError> {
            self.leases.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(MemoryFiles(self.files.lock().unwrap())))
        }
    }

    impl LeasedFiles for MemoryFiles<'_> {
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

    #[derive(Debug, Default)]
    struct Opener {
        opened: AtomicUsize,
    }

    impl DatabaseOpener for Opener {
        fn open(
            &self,
            _name: &Identifier,
            _schema_version: NonZeroU32,
            _initialize: &dyn Fn(&Connection) -> rusqlite::Result<()>,
        ) -> Result<Connection, DatabaseError> {
            self.opened.fetch_add(1, Ordering::SeqCst);
            Err(DatabaseError::Open("this test opens no database".into()))
        }
    }

    #[derive(Debug)]
    struct Feed {
        reads: AtomicUsize,
    }

    impl SessionHistoryFeed for Feed {
        fn list_sessions(&self) -> Result<SessionListing, SessionHistoryError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(SessionListing {
                sessions: Vec::new(),
                damaged_entry_count: 0,
            })
        }

        fn read_messages(
            &self,
            _request: &ReadMessages,
        ) -> Result<MessageBatch, SessionHistoryError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Err(SessionHistoryError::Feed(
                "this test reads no messages".into(),
            ))
        }
    }

    fn context(cancellation: CancellationToken) -> HookContext {
        let mira = Identifier::new("mira").unwrap();

        HookContext::new(
            Identifier::new("notes").unwrap(),
            Arc::new(TurnIdentity {
                session_id: SessionId::parse("chat.1").unwrap(),
                event: EventIdentity::new(
                    EventId::new("evt_1").unwrap(),
                    TraceId::new("trace_1").unwrap(),
                    Timestamp::new("2026-06-15T00:00:00.000Z").unwrap(),
                )
                .unwrap(),
                character: CharacterProfile {
                    id: mira,
                    display_name: SpeakerName::new("Mira").unwrap(),
                },
            }),
            Instant::now() + Duration::from_secs(10),
            cancellation,
        )
    }

    #[test]
    fn a_cancelled_hook_starts_no_more_capability_calls() {
        let cancellation = CancellationToken::new();
        let memory = Arc::new(Memory::default());
        let opener = Arc::new(Opener::default());
        let feed = Arc::new(Feed {
            reads: AtomicUsize::new(0),
        });
        let (granted, _hold) = context(cancellation.clone())
            .with_character_file_store(Arc::clone(&memory) as _, StoreAccess::ReadWrite);
        let granted = granted
            .with_session_history(Arc::clone(&feed) as _)
            .with_plugin_database(Arc::clone(&opener) as _);
        let store = granted.character_file_store().unwrap();

        let leased = store.with_lease(|leased| {
            leased.write_json("notes.json", &json!(["kept"]))?;
            cancellation.cancel();
            leased.read_json("notes.json")
        });

        assert!(matches!(leased, Err(StoreError::Cancelled)), "{leased:?}");
        assert!(matches!(
            store.with_lease(|leased| leased.revision()),
            Err(StoreError::Cancelled)
        ));
        assert!(matches!(
            granted.session_history().unwrap().list_sessions(),
            Err(SessionHistoryError::Cancelled)
        ));
        assert!(matches!(
            granted.plugin_database().unwrap().open(
                &Identifier::new("session-index").unwrap(),
                NonZeroU32::MIN,
                |_| Ok(())
            ),
            Err(DatabaseError::Cancelled)
        ));
        assert_eq!(memory.leases.load(Ordering::SeqCst), 1);
        assert_eq!(feed.reads.load(Ordering::SeqCst), 0);
        assert_eq!(opener.opened.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn writes_end_with_the_hook_and_a_reader_never_writes() {
        let memory = Arc::new(Memory::default());
        let (granted, hold) = context(CancellationToken::new())
            .with_character_file_store(Arc::clone(&memory) as _, StoreAccess::ReadWrite);
        let retained = granted.character_file_store().unwrap().clone();

        retained
            .with_lease(|leased| leased.write_json("notes.json", &json!("kept")))
            .unwrap();
        drop(hold);

        assert!(matches!(
            retained.with_lease(|leased| leased.write_json("notes.json", &json!("late"))),
            Err(StoreError::WritesRevoked)
        ));
        assert_eq!(
            retained
                .with_lease(|leased| leased.read_json("notes.json"))
                .unwrap(),
            Some(json!("kept"))
        );

        let (reader, _hold) = context(CancellationToken::new())
            .with_character_file_store(memory, StoreAccess::ReadOnly);

        assert!(matches!(
            reader
                .character_file_store()
                .unwrap()
                .with_lease(|leased| leased.append_jsonl("log.jsonl", &json!(1))),
            Err(StoreError::ReadOnly)
        ));
    }
}
