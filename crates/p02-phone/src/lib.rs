#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod app;
mod bundled;
mod catalog;
mod data;
mod engine;
mod error;
mod front;
mod host;
mod installed;
mod manifest;
mod phone;
mod screen;
mod store;
mod time;

pub use app::App;
pub use bundled::BundledAppError;
pub use catalog::{Catalog, CatalogApp};
pub use data::Ring;
pub use error::{CatalogError, PackageError, PhoneError};
pub use front::{Did, Front, PhoneState};
pub use installed::{Listed, OnPhone, Source};
pub use manifest::{Action, View};
pub use phone::{Acted, Opened, Phone, SetRing};
pub use store::STORE;
pub use time::Now;
