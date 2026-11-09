#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod engine;
mod extraction;
mod record;
mod store;
mod wire;

pub use engine::{Engine, EngineError, OpenEngineError, RECALL_THRESHOLD, Settings};
pub use record::{
    Hit, Memory, MemoryId, Message, ObservedOn, ParseObservedOnError, Role, Scope, Turn,
};
pub use store::{SCHEMA_VERSION, initialize};
pub use wire::{
    BuildClientError, DEFAULT_EMBEDDER_MODEL, DEFAULT_MODEL, Endpoint, EndpointError,
    OPENAI_BASE_URL,
};
