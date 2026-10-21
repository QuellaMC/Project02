#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod character_data;
mod conversations;
mod error;
mod history;
mod home;
mod jsonl;
mod layout;
mod lock;
mod log;
mod marker;
mod record;
mod replay;
mod sessions;
mod taken_lines;

pub use character_data::CharacterData;
pub use conversations::ConversationWriter;
pub use error::{BusyCode, StorageError};
pub use history::ConversationHistory;
pub use home::Home;
pub use layout::EntryKind;
pub use lock::Lease;
pub use log::{SessionLog, SessionWriter};
pub use marker::{MarkerProblem, Scope};
pub use record::{
    AfterTurnCommitted, CharacterRef, ContinuedFrom, EventNormalized, EventReceived, Judgement,
    LogRecord, MAX_SUMMARY_CHARS, MessageCommitted, PayloadSummary, RecordBody, RecordError,
    RecordKind, RoundRecord, RoundSnapshot, RuntimeRejection, SessionContinuation,
    SessionContinued, Summarizer, SummaryProvider, ToolCallFinished, ToolCallStarted, ToolDispatch,
    TurnCompleted, TurnEvidence, TurnRejected, TurnRejection, TurnStatus,
};
pub use replay::{ReplayError, SessionReplay};
pub use sessions::SessionEntry;
pub use taken_lines::TakenLines;
