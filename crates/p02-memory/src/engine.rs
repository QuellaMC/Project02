use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use rusqlite::Connection;

use crate::extraction::{self, Extraction, SYSTEM_PROMPT};
use crate::record::{Hit, Memory, Scope, Turn};
use crate::store::{self, Commit, Generation, StoreError};
use crate::wire::{BuildClientError, Client, Endpoint, EndpointError};

/// How alike a memory and a query must be, by cosine similarity, for a
/// search to return the memory.
pub const RECALL_THRESHOLD: f64 = 0.1;

/// How many of the memories nearest to a turn its extraction is shown.
const NEARBY_MEMORIES: usize = 10;

/// Where the engine extracts and embeds.
#[derive(Clone, Debug)]
pub struct Settings {
    pub model: Endpoint,
    pub embedder: Endpoint,
}

/// The memory engine over one database, of which every clone is a handle.
/// Writes run one at a time, each in the order it was asked for. The
/// database work runs on the blocking pool; a caller that stops waiting
/// leaves a commit already started to finish, and starts nothing more.
#[derive(Clone, Debug)]
pub struct Engine {
    shared: Arc<Shared>,
}

#[derive(Debug)]
struct Shared {
    connection: Mutex<Connection>,
    client: Client,
    settings: Settings,
    generation: Generation,
    writes: tokio::sync::Mutex<()>,
    model_answered: AtomicBool,
    embedder_answered: AtomicBool,
}

/// What the engine can say of itself without contacting anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status {
    /// Whether the extraction model's last answer since the engine opened
    /// was one it could use.
    pub model_answered: bool,
    /// Whether the embedder's last answer since the engine opened was.
    pub embedder_answered: bool,
    /// Memories with no vector of the current embedder yet, which no
    /// search finds until re-embedding reaches them.
    pub unembedded: u64,
}

impl Status {
    /// Both endpoints answered, and every memory can be found.
    #[must_use]
    pub fn ready(self) -> bool {
        self.model_answered && self.embedder_answered && self.unembedded == 0
    }
}

/// Why the engine did not open.
#[derive(Debug, thiserror::Error)]
pub enum OpenEngineError {
    #[error(transparent)]
    Client(#[from] BuildClientError),
    #[error("the memory store could not be read")]
    Storage(#[source] rusqlite::Error),
}

/// Why an operation of the engine stored or found nothing.
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("the extraction model {0}")]
    Model(EndpointError),
    #[error("the embedder {0}")]
    Embedder(EndpointError),
    #[error("the extraction model's answer held no memory list")]
    UnreadableExtraction,
    #[error(
        "the embedder answered vectors of {found} dimensions where this store's have {expected}"
    )]
    WidthChanged { expected: usize, found: usize },
    #[error("the memory store failed")]
    Storage(#[source] rusqlite::Error),
    #[error("the memory store holds a vector of the wrong width")]
    Damaged,
    #[error("a newer embedder took over the memory store")]
    Superseded,
    #[error("the memory store's job stopped before it finished")]
    Interrupted,
}

impl Engine {
    /// The engine over `connection`, a database its opener initialized
    /// with [`crate::initialize`]. When the embedder is not the one the
    /// store's vectors came from, a new generation starts, and every
    /// memory waits for [`Engine::reembed`].
    ///
    /// # Errors
    ///
    /// [`OpenEngineError`] when the client cannot be built or the store
    /// cannot be read.
    pub fn open(mut connection: Connection, settings: Settings) -> Result<Self, OpenEngineError> {
        let client = Client::new()?;
        let generation = store::adopt_generation(
            &mut connection,
            settings.embedder.model(),
            settings.embedder.base_url().as_str(),
        )
        .map_err(OpenEngineError::Storage)?;

        Ok(Self {
            shared: Arc::new(Shared {
                connection: Mutex::new(connection),
                client,
                settings,
                generation,
                writes: tokio::sync::Mutex::new(()),
                model_answered: AtomicBool::new(false),
                embedder_answered: AtomicBool::new(false),
            }),
        })
    }

    /// The memories of `scope` most like `query`, at most `limit`, each at
    /// least [`RECALL_THRESHOLD`] alike; its score is the cosine.
    ///
    /// # Errors
    ///
    /// [`EngineError`] when the embedder or the store fails.
    pub async fn search(
        &self,
        scope: &Scope,
        query: &str,
        limit: usize,
    ) -> Result<Vec<Hit>, EngineError> {
        let query = self.embed(query).await?;
        let (scope, generation) = (scope.clone(), self.shared.generation);

        self.with_store(move |connection| {
            store::nearest(
                connection,
                generation,
                &scope,
                &query,
                limit,
                Some(RECALL_THRESHOLD),
            )
        })
        .await
    }

    /// Extracts what `turn` holds worth remembering, the session's last
    /// messages and the nearest memories shown with it, and commits the new
    /// memories with their vectors and the turn's messages together.
    /// Returns the memories stored, none when the model found nothing new.
    ///
    /// # Errors
    ///
    /// [`EngineError`] when an endpoint or the store fails, or the model's
    /// answer is unreadable; nothing of the turn is stored then.
    pub async fn capture(&self, scope: &Scope, turn: Turn) -> Result<Vec<Memory>, EngineError> {
        let _writing = self.shared.writes.lock().await;
        let new_messages = turn
            .messages
            .iter()
            .map(|message| format!("{}: {}", message.role.as_str(), message.content))
            .collect::<Vec<_>>()
            .join("\n");
        let conversation = self.embed(&new_messages).await?;
        let (owned_scope, session, generation) =
            (scope.clone(), turn.session.clone(), self.shared.generation);
        let (history, nearby) = self
            .with_store(move |connection| {
                Ok((
                    store::last_messages(connection, &owned_scope, &session)?,
                    store::nearest(
                        connection,
                        generation,
                        &owned_scope,
                        &conversation,
                        NEARBY_MEMORIES,
                        None,
                    )?,
                ))
            })
            .await?;
        let nearby: Vec<String> = nearby.into_iter().map(|hit| hit.memory.text).collect();
        let user_message = Extraction {
            history: &history,
            existing: &nearby,
            new_messages: &new_messages,
            observed_on: &turn.observed_on,
        }
        .user_message();
        let answer = self
            .shared
            .client
            .complete_json(&self.shared.settings.model, SYSTEM_PROMPT, &user_message)
            .await;
        let texts = answer.map_err(EngineError::Model).and_then(|answer| {
            extraction::extracted_memories(&answer).map_err(|_| EngineError::UnreadableExtraction)
        });

        self.shared
            .model_answered
            .store(texts.is_ok(), Ordering::SeqCst);

        let mut memories = Vec::new();

        for text in texts? {
            let vector = self.embed(&text).await?;

            memories.push((text, vector));
        }

        let scope = scope.clone();

        self.with_store(move |connection| {
            store::commit(
                connection,
                &Commit {
                    generation,
                    scope: &scope,
                    memories: &memories,
                    sources: &turn.sources,
                    turn: Some((&turn.session, &turn.messages)),
                },
            )
        })
        .await
    }

    /// Stores `text` as it is, without asking the model. Returns the
    /// memory, or none when the person and character already keep it.
    ///
    /// # Errors
    ///
    /// [`EngineError`] when the embedder or the store fails; nothing is
    /// stored then.
    pub async fn remember(
        &self,
        scope: &Scope,
        text: &str,
        sources: &[String],
    ) -> Result<Option<Memory>, EngineError> {
        let _writing = self.shared.writes.lock().await;
        let memories = [(text.to_owned(), self.embed(text).await?)];
        let (scope, sources, generation) =
            (scope.clone(), sources.to_vec(), self.shared.generation);
        let stored = self
            .with_store(move |connection| {
                store::commit(
                    connection,
                    &Commit {
                        generation,
                        scope: &scope,
                        memories: &memories,
                        sources: &sources,
                        turn: None,
                    },
                )
            })
            .await?;

        Ok(stored.into_iter().next())
    }

    /// Gives every memory without one a vector of the current embedder,
    /// oldest first and one request each, each committed as it comes, so
    /// work a crash or a newer embedder interrupted is never done twice.
    ///
    /// # Errors
    ///
    /// [`EngineError`] for the first memory the embedder or the store
    /// failed on; the memories before it keep their vectors.
    pub async fn reembed(&self) -> Result<(), EngineError> {
        let generation = self.shared.generation;

        while let Some((memory, text)) = self
            .with_store(move |connection| Ok(store::next_unembedded(connection, generation)?))
            .await?
        {
            let vector = self.embed(&text).await?;

            self.with_store(move |connection| {
                store::store_vector(connection, generation, memory, &vector)
            })
            .await?;
        }

        Ok(())
    }

    /// # Errors
    ///
    /// [`EngineError::Storage`] when the store cannot be read.
    pub async fn status(&self) -> Result<Status, EngineError> {
        let generation = self.shared.generation;
        let unembedded = self
            .with_store(move |connection| Ok(store::unembedded(connection, generation)?))
            .await?;

        Ok(Status {
            model_answered: self.shared.model_answered.load(Ordering::SeqCst),
            embedder_answered: self.shared.embedder_answered.load(Ordering::SeqCst),
            unembedded,
        })
    }

    async fn embed(&self, text: &str) -> Result<Vec<f32>, EngineError> {
        let vector = self
            .shared
            .client
            .embed(&self.shared.settings.embedder, text)
            .await;

        self.shared
            .embedder_answered
            .store(vector.is_ok(), Ordering::SeqCst);
        vector.map_err(EngineError::Embedder)
    }

    /// Runs `work` on the store on the blocking pool.
    async fn with_store<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Connection) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, EngineError> {
        let shared = Arc::clone(&self.shared);
        let done = tokio::task::spawn_blocking(move || {
            let mut connection = shared
                .connection
                .lock()
                .unwrap_or_else(PoisonError::into_inner);

            work(&mut connection)
        })
        .await
        .map_err(|_| EngineError::Interrupted)?;

        done.map_err(|error| match error {
            StoreError::Sqlite(error) => EngineError::Storage(error),
            StoreError::WidthChanged { expected, found } => {
                self.shared.embedder_answered.store(false, Ordering::SeqCst);
                EngineError::WidthChanged { expected, found }
            }
            StoreError::Damaged => EngineError::Damaged,
            StoreError::Superseded => EngineError::Superseded,
        })
    }
}
