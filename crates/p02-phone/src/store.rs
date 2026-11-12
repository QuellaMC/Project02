//! The App Store, the phone's own app: written here, with no script, since
//! it needs what no app is given. It keeps the catalog it last read, which
//! her opening it reads anew, and which app's page is open; its one view
//! shows that page, or else the list of the catalog's apps. How an app
//! stands on her phone is read from her phone whenever the screen is made,
//! by the one rule every reader of the App Store takes.

use p02_contracts::{LeasedFiles, StoreError};
use p02_wire::{Screen, ScreenItem, ScreenRow, ScreenTile, StoreAppStatus};
use serde_json::{Map, Value, json};

use crate::app::App;
use crate::catalog::{Catalog, CatalogApp};
use crate::data::Kept;
use crate::installed::Listed;
use crate::manifest::Manifest;
use crate::phone::Phone;

/// The App Store's id: no app installs over it.
pub const STORE: &str = "store";

/// What it keeps: the apps of the catalog it last read, and the app whose
/// page is open.
const CATALOG: &str = "catalog";
const PAGE: &str = "page";

const REVIEWED_BY: &str = "Reviewed by Project02";
const REVIEWED: &str = "Reviewed · Project02 Apps";
const UNREAD: &str = "The App Store shows its apps once she opens it.";

/// The App Store as an app: one view, its list or an app's page, and one
/// action, which turns it to an app's page.
pub(crate) fn app() -> App {
    let manifest = Manifest::read(json!({
        "format": "project02.app.v1",
        "id": STORE,
        "name": "App Store",
        "summary": "More apps, each reviewed by Project02",
        "version": "1.0.0",
        "icon": "bag",
        "tint": "blue",
        "wakes": false,
        "views": [{"id": "apps", "title": "App Store", "icon": "bag"}],
        "opensOn": "apps",
        "actions": [{
            "name": "show_app",
            "description": "See what an app in the App Store is and may do, and whether it is \
                            on your phone.",
            "did": "Looked at an app",
            "view": "apps",
            "input": {
                "type": "object",
                "properties": {
                    "app": {"type": "string", "description": "The app's id in the App Store."},
                },
                "required": ["app"],
                "additionalProperties": false,
            },
        }],
    }))
    .expect("the App Store's manifest keeps every rule an app's does");

    App::store(manifest)
}

impl Phone {
    /// Keeps `catalog`, which the App Store read as she opened it, in
    /// `files` in place of what it kept: its view shows its list again.
    ///
    /// # Errors
    ///
    /// The store's, when it fails.
    pub fn keep_catalog(
        &self,
        files: &mut dyn LeasedFiles,
        catalog: &Catalog,
    ) -> Result<(), StoreError> {
        let mut kept = Kept::default();

        kept.storage
            .insert(CATALOG.to_owned(), json!(catalog.apps()));
        kept.write(files, self.store.id())
    }
}

/// What the App Store's view shows from what it keeps, `kept`, her phone's
/// apps being `on_phone`: the page it has open, or its list.
pub(crate) fn screen(kept: &Kept, on_phone: &[Listed]) -> Screen {
    let Some(apps) = read(kept) else {
        return Screen {
            items: vec![ScreenItem::Text {
                text: UNREAD.to_owned(),
            }],
        };
    };
    let open = kept
        .storage
        .get(PAGE)
        .and_then(Value::as_str)
        .and_then(|id| apps.iter().find(|app| app.id().as_str() == id));
    let items = match open {
        Some(app) => page(app, app.status(on_phone)),
        None => vec![ScreenItem::List {
            header: Some(REVIEWED_BY.to_owned()),
            rows: apps
                .iter()
                .map(|app| ScreenRow {
                    id: Some(app.id().to_string()),
                    tile: Some(tile(app)),
                    title: Some(app.name().to_owned()),
                    subtitle: Some(app.summary().to_owned()),
                    value: match app.status(on_phone) {
                        StoreAppStatus::NotOnPhone => None,
                        StoreAppStatus::Update => Some("Update".to_owned()),
                        StoreAppStatus::Installed => Some("Installed".to_owned()),
                    },
                    ..ScreenRow::default()
                })
                .collect(),
        }],
    };

    Screen { items }
}

/// What `show_app` answers of the app `input` names, her phone's apps
/// being `on_phone`, and what the store keeps after it: that app's page
/// open.
///
/// # Errors
///
/// The store's words for an app it does not list, naming those it does.
pub(crate) fn show(
    kept: &Kept,
    on_phone: &[Listed],
    input: &Map<String, Value>,
) -> Result<(Value, Kept), String> {
    let id = input.get("app").and_then(Value::as_str).unwrap_or_default();
    let apps = read(kept).unwrap_or_default();
    let Some(app) = apps.iter().find(|app| app.id().as_str() == id) else {
        let named: Vec<String> = apps
            .iter()
            .map(|app| format!("{} (\"{}\")", app.name(), app.id()))
            .collect();

        return Err(format!(
            "it lists no app \"{id}\"; its apps: {}",
            if named.is_empty() {
                "none".to_owned()
            } else {
                named.join(", ")
            }
        ));
    };
    let mut after = kept.clone();

    after.storage.insert(PAGE.to_owned(), json!(app.id()));
    Ok((
        json!({
            "app": app.id(),
            "name": app.name(),
            "summary": app.summary(),
            "version": app.version(),
            "changes": app.changes(),
            "itMay": it_may(app.wakes()),
            "status": words(app.status(on_phone)),
        }),
        after,
    ))
}

/// What an app may do, a line each, as the App Store says it and the
/// person is told it, from what the app asks for: keeping its own data is
/// every app's, and waking her the one's that says it does.
#[must_use]
pub fn it_may(wakes: bool) -> Vec<&'static str> {
    let mut may = vec!["Keep its own data"];

    if wakes {
        may.push("Wake her when something is due");
    }

    may
}

/// The apps of the catalog the store last read, none before it read one;
/// an entry that does not read is passed over.
fn read(kept: &Kept) -> Option<Vec<CatalogApp>> {
    let apps = kept.storage.get(CATALOG)?.as_array()?;

    Some(apps.iter().filter_map(CatalogApp::of).collect())
}

/// An app's page: its header, its summary, what it may do, and its version
/// with what changed.
fn page(app: &CatalogApp, status: StoreAppStatus) -> Vec<ScreenItem> {
    vec![
        ScreenItem::App {
            id: app.id().to_string(),
            tile: tile(app),
            name: app.name().to_owned(),
            subtitle: REVIEWED.to_owned(),
            status: words(status).to_owned(),
        },
        ScreenItem::Text {
            text: app.summary().to_owned(),
        },
        ScreenItem::List {
            header: Some("It may".to_owned()),
            rows: it_may(app.wakes())
                .into_iter()
                .map(|line| ScreenRow {
                    title: Some(line.to_owned()),
                    ..ScreenRow::default()
                })
                .collect(),
        },
        ScreenItem::Text {
            text: format!("Version {} — {}", app.version(), app.changes()),
        },
    ]
}

fn tile(app: &CatalogApp) -> ScreenTile {
    ScreenTile {
        icon: app.icon().to_owned(),
        tint: app.tint().to_owned(),
    }
}

/// How an app stands on her phone, as its page says it.
fn words(status: StoreAppStatus) -> &'static str {
    match status {
        StoreAppStatus::NotOnPhone => "Not on her phone",
        StoreAppStatus::Update => "Update available",
        StoreAppStatus::Installed => "Installed",
    }
}
