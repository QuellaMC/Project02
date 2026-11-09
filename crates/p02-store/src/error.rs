use std::io;
use std::path::PathBuf;

use p02_core::{ConversationId, ParseConversationError, SessionId};
use p02_shared::{BoundJsonError, Identifier};

use crate::database::OpenDatabaseError;
use crate::layout::EntryKind;
use crate::marker::{MarkerProblem, SCHEMA_VERSION, Scope};
use crate::plugin_files::{FileKind, ValueProblem};
use crate::replay::ReplayError;

/// Why the store refused or could not do what it was asked. Each is
/// reported under [`StorageError::code`].
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error(
        "{} was written by a newer Project02, at storage schema version {found}, and this build \
         reads up to version {SCHEMA_VERSION}: update Project02 to open it, or choose another \
         home",
        .path.display()
    )]
    NewerSchemaVersion { path: PathBuf, found: u64 },
    #[error("storage schema marker {} {problem}", .path.display())]
    MalformedMarker {
        path: PathBuf,
        problem: MarkerProblem,
    },
    #[error("{} is {}, not {}", .path.display(), .found.article(), .found.other().article())]
    WrongScope { path: PathBuf, found: Scope },
    #[error(
        "{} holds \"{entry}\" and no home marker; choose an empty folder or an existing \
         Project02 home",
        .path.display()
    )]
    UnmarkedHome { path: PathBuf, entry: String },
    #[error("{} must be a real {expected} inside its storage directory", .path.display())]
    NotReal { path: PathBuf, expected: EntryKind },
    #[error("character data directory {} has no storage schema marker", .path.display())]
    NoMarker { path: PathBuf },
    #[error("session directory {} is missing", .path.display())]
    MissingSessionDirectory { path: PathBuf },
    #[error("session log {} is missing, though a later segment continues it", .path.display())]
    MissingLog { path: PathBuf },
    #[error(
        "sessions catalog {} is missing or empty while session directories hold evidence",
        .path.display()
    )]
    MissingCatalog { path: PathBuf },
    #[error(
        "session directory {} holds evidence the sessions catalog does not list",
        .path.display()
    )]
    UncataloguedSession { path: PathBuf },
    #[error("conversation record {} is malformed", .path.display())]
    MalformedConversation {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("the record does not fit the session's log")]
    Refused(#[source] ReplayError),
    #[error("{} changed while it was read, twice", .path.display())]
    ConcurrentWrite { path: PathBuf },
    #[error("{resource} is busy")]
    Busy { resource: String, code: BusyCode },
    #[error("session \"{0}\" already exists")]
    SessionExists(SessionId),
    #[error("session \"{0}\" does not exist")]
    SessionNotFound(SessionId),
    #[error("session \"{0}\" is not the latest segment of its conversation")]
    NotLatestSegment(SessionId),
    #[error("session \"{0}\" holds evidence and cannot be discarded")]
    SessionNotEmpty(SessionId),
    #[error("conversation \"{0}\" does not exist")]
    ConversationNotFound(ConversationId),
    #[error("conversation \"{conversation}\" is not between {participant} and the person")]
    NotAParticipant {
        conversation: ConversationId,
        participant: Identifier,
    },
    #[error("a conversation cannot be made between these participants")]
    InvalidParticipants(#[source] ParseConversationError),
    #[error(
        "\"{path}\" is no {expected} of a plugin's store: segments of letters, digits, '.', '_' \
         and '-', each beginning with a letter or a digit, a document's last ending in .json and \
         a log's in .jsonl"
    )]
    InvalidStorePath { path: String, expected: FileKind },
    #[error("the value for \"{path}\" is not within the JSON limits")]
    StoreValueLimits {
        path: String,
        #[source]
        source: BoundJsonError,
    },
    #[error("{} is no JSON document within the JSON limits", .path.display())]
    MalformedDocument {
        path: PathBuf,
        #[source]
        source: ValueProblem,
    },
    #[error("could not open database {}", .path.display())]
    Database {
        path: PathBuf,
        #[source]
        source: OpenDatabaseError,
    },
    #[error("could not read {}", .path.display())]
    Read {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("could not write {}", .path.display())]
    Write {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

/// What a busy lock is reported as: the session it would let its holder
/// write, or anything else in the store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BusyCode {
    Session,
    Storage,
}

impl StorageError {
    /// The code the error is reported under, which clients read.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::NewerSchemaVersion { .. } => "unsupported_schema_version",
            Self::MalformedMarker { .. } | Self::WrongScope { .. } => "malformed_schema_marker",
            Self::NotAParticipant { .. } => "character_identity_mismatch",
            Self::UnmarkedHome { .. }
            | Self::NotReal { .. }
            | Self::NoMarker { .. }
            | Self::MissingSessionDirectory { .. }
            | Self::MissingLog { .. }
            | Self::MissingCatalog { .. }
            | Self::UncataloguedSession { .. } => "missing_file",
            Self::MalformedConversation { .. }
            | Self::Refused(_)
            | Self::InvalidParticipants(_)
            | Self::MalformedDocument { .. } => "malformed_record",
            Self::InvalidStorePath { .. } => "invalid_store_path",
            Self::StoreValueLimits { .. } => "invalid_store_value",
            Self::ConcurrentWrite { .. } => "concurrent_write",
            Self::Busy {
                code: BusyCode::Session,
                ..
            } => "session_busy",
            Self::Busy {
                code: BusyCode::Storage,
                ..
            } => "storage_busy",
            Self::SessionExists(_) => "session_already_exists",
            Self::SessionNotFound(_) | Self::NotLatestSegment(_) => "session_not_found",
            Self::SessionNotEmpty(_) => "session_not_empty",
            Self::ConversationNotFound(_) => "conversation_not_found",
            Self::Read { .. } => "read_failed",
            Self::Write { .. } | Self::Database { .. } => "write_failed",
        }
    }

    pub(crate) fn read(path: impl Into<PathBuf>) -> impl FnOnce(io::Error) -> Self {
        let path = path.into();

        move |source| Self::Read { path, source }
    }

    pub(crate) fn write(path: impl Into<PathBuf>) -> impl FnOnce(io::Error) -> Self {
        let path = path.into();

        move |source| Self::Write { path, source }
    }
}
