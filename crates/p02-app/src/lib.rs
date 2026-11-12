#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod apps;
mod character;
mod chatgpt;
mod config_control;
mod confirmation;
mod daemon;
mod history;
mod outcome;
mod packages;
mod pairing;
mod phone;
mod reconcile;
mod rings;

pub use chatgpt::kept_sign_in;
pub use daemon::{Daemon, DaemonSettings, Durations, Message, OpenDaemonError, Plugin, Presence};
pub use history::HistoryPage;
pub use outcome::package_report;
