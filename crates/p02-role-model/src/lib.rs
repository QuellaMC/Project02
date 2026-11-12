#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod draft;
mod nvidia;
mod prompt;
mod responses;
mod rounds;
mod select;
mod test_provider;
mod transport;

pub use nvidia::NvidiaSettings;
pub use prompt::{
    Opening, Person, Recollection, newest_turns_within, select_history_window,
    summarizer_instructions, today_note,
};
pub use responses::OpenaiSettings;
pub use rounds::{
    DraftEvent, DraftId, ModelRound, Reply, Rounds, RoutedToolCall, TurnInput, TurnOutcome,
    TurnSink,
};
pub use select::{ServiceSettings, TestProvider, UnknownTestProviderError, select_adapter};
pub use transport::BuildAdapterError;
