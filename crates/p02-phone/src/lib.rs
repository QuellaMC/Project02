#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod app;
mod bundled;
mod data;
mod engine;
mod error;
mod front;
mod host;
mod installed;
mod manifest;
mod phone;
mod screen;
mod time;

pub use app::App;
pub use bundled::BundledAppError;
pub use data::Ring;
pub use error::{PackageError, PhoneError};
pub use front::{Did, Front, PhoneState};
pub use installed::{Listed, OnPhone, Source};
pub use manifest::{Action, View};
pub use phone::{Acted, Opened, Phone, SetRing};
pub use time::Now;
