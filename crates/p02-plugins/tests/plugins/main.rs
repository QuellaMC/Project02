//! The plugin host and its packages, driven the way the runtime will drive
//! them.
#![expect(
    clippy::unwrap_used,
    reason = "a test, and the world it builds, fail by panicking, as in the unit tests"
)]

mod activation;
mod before_call;
mod character_memory;
mod character_state;
mod demo_config;
mod health;
mod home;
mod lifecycle;
mod management;
mod mem0;
mod session_history;
mod storage;
mod stub;
mod support;
mod tool_calls;
