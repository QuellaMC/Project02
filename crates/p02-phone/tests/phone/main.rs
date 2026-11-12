//! Her phone as the daemon's other parts reach it: through the crate's
//! public API, with apps written here and the Clock every phone comes
//! with, a store held in memory and a clock that reads one moment.
#![expect(
    clippy::unwrap_used,
    reason = "a test, and the world it builds, fail by panicking"
)]

mod apps;
mod calls;
mod catalog;
mod clock;
mod front;
mod installed;
mod rings;
mod screens;
mod support;
mod time;
