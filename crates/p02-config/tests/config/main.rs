//! The settings as the daemon's other parts reach them: through the
//! crate's public API, on homes in temporary directories.
#![expect(
    clippy::unwrap_used,
    reason = "a test, and the world it builds, fail by panicking, as in the unit tests"
)]
#![expect(
    clippy::disallowed_methods,
    reason = "a test writes and damages a home's files as a person or a crash would"
)]

mod changes;
mod documents;
mod packages;
mod resolution;
mod support;
mod views;
