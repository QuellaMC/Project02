//! The embedded engine on this device, in the plugin's own database.

use std::sync::{LazyLock, Mutex, PoisonError};

use p02_contracts::PluginDatabase;
use p02_memory::{Engine, EngineError, SCHEMA_VERSION, Scope, Settings, initialize};
use p02_shared::{Identifier, error_chain};
use tokio::sync::OnceCell;
use tokio::task::JoinHandle;

use super::backend::{BackendError, Failure, Found, Operation, RECALL_LIMIT, Write, Written};

static DATABASE: LazyLock<Identifier> =
    LazyLock::new(|| Identifier::new("memory").expect("the name is an identifier"));

#[derive(Debug)]
pub(super) struct Embedded {
    settings: Settings,
    /// Opened by the first hook that needs it, and kept beyond it: the
    /// connection is the plugin's.
    engine: OnceCell<Engine>,
    /// Re-embedding, running or as it last ended, which ends with the
    /// backend.
    reembedding: Mutex<Option<JoinHandle<()>>>,
}

impl Embedded {
    pub(super) fn new(settings: Settings) -> Self {
        Self {
            settings,
            engine: OnceCell::new(),
            reembedding: Mutex::new(None),
        }
    }

    /// The engine, opened in the plugin's database when no hook has yet;
    /// each use of it starts re-embedding whatever waits for a vector,
    /// unless a run is under way, so a run that stopped on a failure goes
    /// on with the next recall or capture.
    pub(super) async fn engine(
        &self,
        databases: Option<&PluginDatabase>,
        operation: Operation,
    ) -> Result<Engine, BackendError> {
        if let Some(engine) = self.engine.get() {
            self.keep_reembedding(engine);
            return Ok(engine.clone());
        }

        let unopened = |words: String| BackendError::new(operation, Failure::StoreUnopened(words));
        let databases = databases
            .cloned()
            .ok_or_else(|| unopened("the plugin database is not granted to it".to_owned()))?;
        let settings = self.settings.clone();
        let engine = self
            .engine
            .get_or_try_init(|| async move {
                tokio::task::spawn_blocking(move || {
                    let connection = databases
                        .open(&DATABASE, SCHEMA_VERSION, initialize)
                        .map_err(|error| error_chain(&error))?;

                    Engine::open(connection, settings).map_err(|error| error_chain(&error))
                })
                .await
                .map_err(|_| "its opening job stopped".to_owned())?
            })
            .await
            .map_err(unopened)?;

        self.keep_reembedding(engine);
        Ok(engine.clone())
    }

    pub(super) async fn search(
        &self,
        scope: &Scope,
        query: &str,
        databases: Option<&PluginDatabase>,
    ) -> Result<Vec<Found>, BackendError> {
        let engine = self.engine(databases, Operation::Search).await?;
        let hits = engine
            .search(scope, query, RECALL_LIMIT)
            .await
            .map_err(|error| failed(Operation::Search, &error))?;

        Ok(hits
            .into_iter()
            .map(|hit| Found {
                id: hit.memory.id.to_string(),
                text: hit.memory.text,
                score: Some(hit.score),
            })
            .collect())
    }

    pub(super) async fn write(
        &self,
        scope: &Scope,
        write: Write,
        databases: Option<&PluginDatabase>,
    ) -> Result<Written, BackendError> {
        let engine = self.engine(databases, Operation::Add).await?;
        let stored = match write {
            Write::Turn(turn) => engine.capture(scope, turn).await,
            Write::Fact { text, sources } => engine
                .remember(scope, &text, &sources)
                .await
                .map(|memory| memory.into_iter().collect()),
        }
        .map_err(|error| failed(Operation::Add, &error))?;

        Ok(Written::Stored(
            stored
                .into_iter()
                .map(|memory| memory.id.to_string())
                .collect(),
        ))
    }

    /// Starts re-embedding unless it runs already: what a run before left
    /// waits for this one.
    fn keep_reembedding(&self, engine: &Engine) {
        let mut running = self
            .reembedding
            .lock()
            .unwrap_or_else(PoisonError::into_inner);

        if running.as_ref().is_none_or(JoinHandle::is_finished) {
            let engine = engine.clone();

            *running = Some(tokio::spawn(async move {
                let _ = engine.reembed().await;
            }));
        }
    }
}

impl Drop for Embedded {
    fn drop(&mut self) {
        if let Some(task) = self
            .reembedding
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            task.abort();
        }
    }
}

fn failed(operation: Operation, error: &EngineError) -> BackendError {
    BackendError::new(operation, Failure::Engine(error_chain(error)))
}
