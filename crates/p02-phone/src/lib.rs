#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod app;
mod bundled;
mod data;
mod engine;
mod error;
mod host;
mod manifest;
mod phone;
mod screen;
mod time;

pub use app::App;
pub use bundled::BundledAppError;
pub use data::Ring;
pub use error::{PackageError, PhoneError};
pub use manifest::{Action, View};
pub use phone::{Acted, Phone, SetRing};
pub use screen::{Item, Live, Row, Screen};
pub use time::Now;
