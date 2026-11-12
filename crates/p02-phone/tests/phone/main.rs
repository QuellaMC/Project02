//! Her phone as the daemon's other parts reach it: through the crate's
//! public API, with apps written here, the Clock every phone comes with and
//! Reminders, Weather and Web Search, apps of the App Store's catalog, a
//! store held in memory and a clock that reads one moment.
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
mod net;
mod reminders;
mod rings;
mod screens;
mod search;
mod support;
mod time;
mod weather;
