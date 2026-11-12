//! The App Store's catalog: one document listing the apps we read and
//! approved, each by what the store shows of it without fetching it and by
//! the SHA-256 of its one file. Here it is read, and an app's text judged
//! against what the catalog says of it; it is reached over the web
//! elsewhere.

use std::sync::Arc;

use p02_shared::Identifier;
use p02_wire::StoreAppStatus;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

use crate::app::App;
use crate::asks::Asks;
use crate::error::CatalogError;
use crate::installed::Listed;
use crate::manifest::{is_blank, is_lowercase, is_one_line, numbers};
use crate::phone::Phone;

/// The format of a catalog the phone reads.
const FORMAT: &str = "project02.catalog.v1";
/// The most apps a catalog lists.
const MOST_APPS: usize = 100;

/// The apps of the catalog, in its order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Catalog {
    apps: Vec<CatalogApp>,
}

/// An app as the catalog lists it: what the store shows of it, what it
/// asks of her phone included, under the names and rules of an app's
/// manifest, one line on what changed in this version, and the SHA-256 of
/// its one file, in hex.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogApp {
    id: Identifier,
    name: String,
    summary: String,
    icon: String,
    tint: String,
    version: String,
    changes: String,
    #[serde(flatten)]
    asks: Asks,
    sha256: String,
}

impl Catalog {
    /// The catalog `document` holds. An entry that does not keep the rules
    /// is passed over, and the rest kept.
    ///
    /// # Errors
    ///
    /// [`CatalogError::NotACatalog`] for a document that is no JSON, or not
    /// of the format this phone reads; [`CatalogError::TooLarge`] for one
    /// that lists more apps than the phone reads.
    pub fn read(document: &[u8]) -> Result<Self, CatalogError> {
        let document: Value =
            serde_json::from_slice(document).map_err(|_| CatalogError::NotACatalog)?;

        if document.get("format").and_then(Value::as_str) != Some(FORMAT) {
            return Err(CatalogError::NotACatalog);
        }

        let listed = document
            .get("apps")
            .and_then(Value::as_array)
            .ok_or(CatalogError::NotACatalog)?;

        if listed.len() > MOST_APPS {
            return Err(CatalogError::TooLarge);
        }

        Ok(Self {
            apps: listed.iter().filter_map(CatalogApp::of).collect(),
        })
    }

    #[must_use]
    pub fn apps(&self) -> &[CatalogApp] {
        &self.apps
    }

    /// The app the catalog lists as `id`.
    #[must_use]
    pub fn app(&self, id: &str) -> Option<&CatalogApp> {
        self.apps.iter().find(|app| app.id.as_str() == id)
    }
}

impl CatalogApp {
    /// The app `entry` lists, when it keeps every rule.
    pub(crate) fn of(entry: &Value) -> Option<Self> {
        let app = Self::deserialize(entry).ok()?;
        let kept = is_lowercase(&app.id)
            && !is_blank(&app.name)
            && is_one_line(&app.summary)
            && !is_blank(&app.icon)
            && !is_blank(&app.tint)
            && numbers(&app.version).is_some()
            && is_one_line(&app.changes)
            && app.asks.check().is_ok()
            && digest(&app.sha256).is_some();

        kept.then_some(app)
    }

    #[must_use]
    pub fn id(&self) -> &Identifier {
        &self.id
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn summary(&self) -> &str {
        &self.summary
    }

    #[must_use]
    pub fn icon(&self) -> &str {
        &self.icon
    }

    #[must_use]
    pub fn tint(&self) -> &str {
        &self.tint
    }

    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }

    /// What changed in this version, in one line.
    #[must_use]
    pub fn changes(&self) -> &str {
        &self.changes
    }

    /// What the app asks of her phone, which the store shows before it
    /// fetches the app.
    #[must_use]
    pub fn asks(&self) -> &Asks {
        &self.asks
    }

    /// Whether the app says it wakes her.
    #[must_use]
    pub fn wakes(&self) -> bool {
        self.asks.wakes
    }

    /// How this app stands on her phone, whose apps are `on_phone`: not on
    /// it; on it in an older version than this, versions ordered as their
    /// three numbers, which this updates; or on it in this version or a
    /// newer one. Whatever reads the App Store takes this one rule, so
    /// nothing replaces an app with an older version of the store's.
    #[must_use]
    pub fn status(&self, on_phone: &[Listed]) -> StoreAppStatus {
        match on_phone.iter().find(|listed| listed.id == self.id) {
            None => StoreAppStatus::NotOnPhone,
            Some(listed) if numbers(&listed.version) < numbers(&self.version) => {
                StoreAppStatus::Update
            }
            Some(_) => StoreAppStatus::Installed,
        }
    }
}

impl Phone {
    /// The app `text` makes, once it is what the catalog lists as `app`:
    /// the file of the SHA-256 listed, making an app as any app's text
    /// must, of the id and the version listed, asking of her phone what
    /// the catalog says it asks. It is made once, as every app her phone
    /// runs is.
    ///
    /// # Errors
    ///
    /// [`CatalogError::NotTheApp`], saying how it is not.
    pub fn judge(&self, app: &CatalogApp, text: &str) -> Result<Arc<App>, CatalogError> {
        let not_the_app = |why: String| CatalogError::NotTheApp {
            name: app.name.clone(),
            why,
        };

        if digest(&app.sha256).is_none_or(|listed| listed[..] != Sha256::digest(text)[..]) {
            return Err(not_the_app(
                "its file is not the one whose SHA-256 the catalog lists".to_owned(),
            ));
        }

        let made = self
            .made(text)
            .map_err(|why| not_the_app(format!("its file makes no app: {why}")))?;

        if *made.id() != app.id || made.version() != app.version {
            return Err(not_the_app(format!(
                "its file is {} {}, not the {} {} the catalog lists",
                made.id(),
                made.version(),
                app.id,
                app.version
            )));
        }

        if *made.asks() != app.asks {
            return Err(not_the_app(
                "its file asks of her phone other than the catalog lists".to_owned(),
            ));
        }

        Ok(made)
    }
}

/// The 32 bytes `hex`, 64 hex digits, spells; none for any other text.
fn digest(hex: &str) -> Option<[u8; 32]> {
    let mut digest = [0; 32];
    let (pairs, rest) = hex.as_bytes().as_chunks::<2>();

    if pairs.len() != digest.len() || !rest.is_empty() {
        return None;
    }

    for (byte, [high, low]) in digest.iter_mut().zip(pairs) {
        *byte = (hex_digit(*high)? << 4) | hex_digit(*low)?;
    }

    Some(digest)
}

fn hex_digit(digit: u8) -> Option<u8> {
    char::from(digit)
        .to_digit(16)
        .and_then(|value| u8::try_from(value).ok())
}
