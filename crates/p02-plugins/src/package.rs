//! What the packages compiled into the daemon share.

use std::error::Error;

use p02_contracts::{
    EvidenceKind, EvidenceNote, EvidenceStatus, FileStore, LeasedStore, PluginError, ProvidedTool,
    StoreError, ToolCall, ToolCallOutcome, ToolInputContract, ToolPreparation,
};
use p02_shared::Identifier;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// A tool of a package, which acts without approval and runs alone until
/// its package says otherwise. No build of the daemon ships a refused one,
/// so a refusal is the package's failure to start.
pub(crate) fn tool(
    name: &str,
    description: &str,
    contract: Value,
) -> Result<ProvidedTool, PluginError> {
    ProvidedTool::new(
        Identifier::new(name).map_err(refused(name))?,
        description,
        ToolInputContract::new(contract).map_err(refused(name))?,
    )
    .map_err(refused(name))
}

fn refused<E: Error + Send + Sync + 'static>(name: &str) -> impl Fn(E) -> PluginError + '_ {
    move |error| PluginError::with_source(format!("tool \"{name}\" was refused"), error)
}

/// The call's input as its tool's contract admits it.
pub(crate) fn admitted<T: DeserializeOwned>(call: &ToolCall) -> Result<T, PluginError> {
    serde_json::from_value(Value::Object(call.input().clone())).map_err(|error| {
        PluginError::with_source(
            format!("{} input is not what its contract admits", call.tool_name()),
            error,
        )
    })
}

/// A call the package refused, which the model reads, and its record.
pub(crate) fn rejected(reason: &str, message: String, summary: &str) -> ToolCallOutcome {
    ToolCallOutcome::Rejected {
        reason: reason.to_owned(),
        message,
        evidence: vec![refusal(summary)],
    }
}

/// A call of a tool that asks first, which the package refused before
/// anyone was asked: the model reads it, and its record.
pub(crate) fn unasked(reason: &str, message: String, summary: &str) -> ToolPreparation {
    ToolPreparation::Rejected {
        reason: reason.to_owned(),
        message,
        evidence: vec![refusal(summary)],
    }
}

fn refusal(summary: &str) -> EvidenceNote {
    EvidenceNote::new(
        EvidenceKind::ToolInvocation,
        EvidenceStatus::Rejected,
        summary,
    )
}

/// Why a package's own files did not read or write as it keeps them.
#[derive(Debug)]
pub(crate) enum FilesError {
    Store(StoreError),
    /// A file holds what the package never writes, in a sentence naming
    /// the file. It is left as it is.
    Damaged(String),
}

impl From<StoreError> for FilesError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl From<FilesError> for PluginError {
    fn from(error: FilesError) -> Self {
        match error {
            FilesError::Store(error) => error.into(),
            FilesError::Damaged(sentence) => Self::new(sentence),
        }
    }
}

/// Runs `work` on the blocking pool, where a package does its disk work.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, PluginError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| PluginError::with_source("the plugin's blocking job failed", error))
}

/// Runs `work` on `store` under its lease, on the blocking pool.
pub(crate) async fn leased<T: Send + 'static>(
    store: FileStore,
    work: impl FnOnce(&mut LeasedStore<'_>) -> Result<T, FilesError> + Send + 'static,
) -> Result<T, PluginError> {
    blocking(move || -> Result<T, FilesError> { store.with_lease(|leased| Ok(work(leased)))? })
        .await?
        .map_err(PluginError::from)
}
