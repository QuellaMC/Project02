//! The embedded engine on this device, in the plugin's own database.

use std::sync::{LazyLock, Mutex, PoisonError};

use p02_contracts::PluginDatabase;
use p02_memory::{Engine, EngineError, SCHEMA_VERSION, Scope, Settings, initialize};
use p02_shared::{Identifier, error_chain};
use tokio::sync::OnceCell;
use tokio::task::JoinHandle;

use super::backend::{
    BackendError, Failure, Found, Operation, RECALL_LIMIT, Readiness, Write, Written,
};

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
    reembedding: Mutex<Option<JoinHandle<Result<(), EngineError>>>>,
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
    /// opening it starts re-embedding whatever waits for a vector.
    pub(super) async fn engine(
        &self,
        databases: Option<&PluginDatabase>,
        operation: Operation,
    ) -> Result<Engine, BackendError> {
        if let Some(engine) = self.engine.get() {
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

        self.keep_reembedding(engine).await;
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

    /// Opens the engine and contacts nothing: verified only once the model
    /// and the embedder both answered since it opened, and every memory
    /// has a vector of the current embedder. Re-embedding that stopped on
    /// a failure is told, and starts again here.
    pub(super) async fn ping(
        &self,
        databases: Option<&PluginDatabase>,
    ) -> Result<Readiness, BackendError> {
        let engine = self.engine(databases, Operation::Ping).await?;
        let status = engine
            .status()
            .await
            .map_err(|error| failed(Operation::Ping, &error))?;
        let stopped = self.keep_reembedding(&engine).await;
        let (verified, summary) = if status.unembedded > 0 {
            let summary = match stopped {
                Some(why) => format!(
                    "Mem0 engine could not re-embed its memories for a new embedder ({} to go): \
                     {why}.",
                    status.unembedded
                ),
                None => format!(
                    "Mem0 engine is re-embedding its memories for a new embedder; {} to go.",
                    status.unembedded
                ),
            };

            (false, summary)
        } else if status.ready() {
            (
                true,
                "Mem0 engine loaded; its model and embedder have answered.".to_owned(),
            )
        } else {
            (
                false,
                "Mem0 engine loaded; its model and embedder are contacted on first capture or \
                 recall."
                    .to_owned(),
            )
        };

        Ok(Readiness { verified, summary })
    }

    /// Starts re-embedding unless it runs already, and says why the run
    /// before stopped short, if it did: what it left waits for this one.
    async fn keep_reembedding(&self, engine: &Engine) -> Option<String> {
        let ended = {
            let mut running = self
                .reembedding
                .lock()
                .unwrap_or_else(PoisonError::into_inner);

            if running.as_ref().is_some_and(|task| !task.is_finished()) {
                return None;
            }

            let engine = engine.clone();

            running.replace(tokio::spawn(async move { engine.reembed().await }))
        };
        let ended = ended?.await.unwrap_or(Err(EngineError::Interrupted));

        ended.err().map(|error| error_chain(&error))
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
