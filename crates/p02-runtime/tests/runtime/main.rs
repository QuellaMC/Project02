//! The runtime as the character's actor drives it: lines through an open
//! thread on a home in a temporary directory, over the real store and the
//! real plugin host, with a model whose answers are scripted.
#![expect(
    clippy::unwrap_used,
    reason = "a test, and the world it builds, fail by panicking, as in the unit tests"
)]
#![expect(
    clippy::disallowed_methods,
    reason = "a test reads, damages and makes read-only a home's files, as a person or a failing \
              disk would"
)]

mod failures;
mod moments;
mod support;
mod threads;
mod turns;
