#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod account;
mod ai;
mod app;
mod asks;
mod bundled;
mod catalog;
mod data;
mod engine;
mod error;
mod exchange;
mod front;
mod host;
mod installed;
mod manifest;
mod net;
mod phone;
mod screen;
mod store;
mod time;
mod wake;

pub use account::{Account, AccountKind};
pub use ai::{Answer, Question};
pub use app::App;
pub use asks::{Asks, it_may};
pub use bundled::BundledAppError;
pub use catalog::{Catalog, CatalogApp};
pub use data::Ring;
pub use error::{CatalogError, PackageError, PhoneError};
pub use exchange::{Ask, Exchange};
pub use front::{Did, Front, PhoneState};
pub use installed::{Installed, Listed, OnPhone, Source};
pub use manifest::{Action, View};
pub use net::{Fetch, Fetched, Method};
pub use phone::{Acted, Acting, Opened, Phone, SetRing};
pub use store::STORE;
pub use time::Now;
