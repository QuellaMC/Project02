//! The crate driven the way the runtime will drive it.
#![expect(
    clippy::unwrap_used,
    reason = "a test, and the world it builds, fail by panicking, as in the unit tests"
)]

mod nvidia;
mod rounds;
mod stub;
mod support;
