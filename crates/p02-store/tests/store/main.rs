//! The store as the runtime and the daemon's other parts reach it: through
//! its public API, on a home in a temporary directory.
#![expect(
    clippy::unwrap_used,
    reason = "a test, and the world it builds, fail by panicking, as in the unit tests"
)]
#![expect(
    clippy::disallowed_methods,
    reason = "a test reads, writes and damages a home's files as a person or a crash would"
)]

mod catalogs;
mod databases;
mod feed;
mod generated;
mod history;
mod layout;
mod plugin_files;
mod records;
mod support;
mod writer;
