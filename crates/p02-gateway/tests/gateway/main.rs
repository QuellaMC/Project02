//! The socket as its clients reach it: a home in a temporary directory, the
//! bundled Mira, the daemon of p02-app, the server on a free loopback port,
//! and a client of it over TCP.
#![expect(
    clippy::unwrap_used,
    reason = "a test, and the world it builds, fail by panicking, as in the unit tests"
)]

mod config;
mod discovery;
mod page;
mod pairing;
mod stop;
mod stream;
mod support;
mod transport;
