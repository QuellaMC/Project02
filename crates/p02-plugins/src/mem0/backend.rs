//! The seam every Mem0 deployment is reached through: search, write and
//! ping, over the hosted platform, a self-hosted server, or the embedded
//! engine. A failure is told in one fixed sentence per kind, so neither a
//! credential nor an address ever leaves through it.

use std::error::Error;
use std::fmt;

use p02_contracts::PluginDatabase;
use p02_memory::{Scope, Turn};

use super::embedded::Embedded;
use super::rest::Rest;

/// How many memories a recall or a search returns.
pub(super) const RECALL_LIMIT: usize = 5;

#[derive(Debug)]
pub(super) enum Backend {
    Rest(Rest),
    Embedded(Box<Embedded>),
}

/// What a backend is asked to keep.
#[derive(Debug)]
pub(super) enum Write {
    /// A captured turn, which the backend extracts memories from.
    Turn(Turn),
    /// A fact the model chose to keep, stored as written.
    Fact { text: String, sources: Vec<String> },
}

/// What came of a write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Written {
    /// The memories the backend stored, by id; none when it found nothing
    /// new to keep.
    Stored(Vec<String>),
    /// The receipt of a write the backend processes later, which proves no
    /// memory yet.
    Queued(String),
}

/// A memory a search found.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Found {
    pub(super) id: String,
    pub(super) text: String,
    pub(super) score: Option<f64>,
}

/// What a ping established: verified only when it proved the backend
/// serves, which the embedded engine's local check does only once its
/// model and embedder have answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Readiness {
    pub(super) verified: bool,
    pub(super) summary: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Operation {
    Search,
    Add,
    Ping,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Failure {
    Http(u16),
    Unreachable,
    Unreadable,
    NothingStored,
    /// The caller stopped waiting: the write may have landed all the same.
    Abandoned,
    /// The embedded engine's own account of what failed.
    Engine(String),
    StoreUnopened(String),
}

/// Why a backend answered nothing usable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct BackendError {
    pub(super) operation: Operation,
    pub(super) failure: Failure,
}

impl Backend {
    /// Readies what work queued past the hook needs: the embedded engine,
    /// which opens only through the hook's database.
    pub(super) async fn open(
        &self,
        databases: Option<&PluginDatabase>,
    ) -> Result<(), BackendError> {
        match self {
            Self::Rest(_) => Ok(()),
            Self::Embedded(embedded) => embedded.engine(databases, Operation::Add).await.map(drop),
        }
    }

    pub(super) async fn search(
        &self,
        scope: &Scope,
        query: &str,
        databases: Option<&PluginDatabase>,
    ) -> Result<Vec<Found>, BackendError> {
        match self {
            Self::Rest(rest) => rest.search(scope, query).await,
            Self::Embedded(embedded) => embedded.search(scope, query, databases).await,
        }
    }

    pub(super) async fn write(
        &self,
        scope: &Scope,
        write: Write,
        databases: Option<&PluginDatabase>,
    ) -> Result<Written, BackendError> {
        match self {
            Self::Rest(rest) => rest.write(scope, write).await,
            Self::Embedded(embedded) => embedded.write(scope, write, databases).await,
        }
    }

    pub(super) async fn ping(
        &self,
        databases: Option<&PluginDatabase>,
    ) -> Result<Readiness, BackendError> {
        match self {
            Self::Rest(rest) => rest.ping().await,
            Self::Embedded(embedded) => embedded.ping(databases).await,
        }
    }
}

impl Operation {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Search => "search",
            Self::Add => "add",
            Self::Ping => "ping",
        }
    }
}

impl BackendError {
    pub(super) fn new(operation: Operation, failure: Failure) -> Self {
        Self { operation, failure }
    }

    /// Whether the backend cannot be reached at all, which health reports
    /// as unavailable rather than degraded.
    pub(super) fn is_unavailable(&self) -> bool {
        matches!(
            self.failure,
            Failure::Unreachable | Failure::StoreUnopened(_)
        )
    }
}

impl fmt::Display for BackendError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let operation = self.operation.as_str();

        match &self.failure {
            Failure::Http(status) => write!(formatter, "mem0 {operation} failed: HTTP {status}."),
            Failure::Unreachable => {
                write!(formatter, "mem0 {operation} failed: backend unreachable.")
            }
            Failure::Unreadable => write!(
                formatter,
                "mem0 {operation} failed: backend returned an unreadable response body."
            ),
            Failure::NothingStored => write!(
                formatter,
                "mem0 {operation} failed: the backend created no memory for it."
            ),
            Failure::Abandoned => write!(
                formatter,
                "mem0 {operation} was abandoned before the backend answered; whether it \
                 completed is unknown."
            ),
            Failure::Engine(words) => write!(formatter, "mem0 {operation} failed: {words}."),
            Failure::StoreUnopened(words) => {
                write!(
                    formatter,
                    "Mem0 embedded storage could not be opened: {words}."
                )
            }
        }
    }
}

impl Error for BackendError {}
