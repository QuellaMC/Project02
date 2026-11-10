#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod nvidia;
mod prompt;
mod rounds;
mod select;
mod test_provider;

pub use nvidia::{BuildNvidiaAdapterError, NvidiaSettings};
pub use prompt::{
    Opening, Person, Recollection, newest_turns_within, select_history_window,
    summarizer_instructions, today_note,
};
pub use rounds::{
    DraftEvent, DraftId, ModelRound, Reply, Rounds, RoutedToolCall, TurnInput, TurnOutcome,
    TurnSink,
};
pub use select::{TestProvider, UnknownTestProviderError, select_adapter};
