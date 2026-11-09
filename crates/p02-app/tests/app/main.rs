//! The daemon as its surfaces drive it: a home in a temporary directory,
//! the bundled Mira, the real store and plugin host, and a model whose
//! rounds are scripted.
#![expect(
    clippy::unwrap_used,
    reason = "a test, and the world it builds, fail by panicking, as in the unit tests"
)]

mod lifecycle;
mod pairing;
mod support;
