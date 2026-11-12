//! The App Store's catalog as her phone reads it from the web: no more of
//! it than its bound, and no more of an app's file than a text file holds.

use p02_phone::CatalogError;
use p02_plugins::AppCatalog;
use p02_shared::BaseUrl;
use serde_json::json;

use crate::stub::{Answer, Stub};

/// One past what the catalog and an app's file are each read to.
const PAST_THE_BOUND: usize = 256 * 1_024 + 1;

#[tokio::test]
async fn the_catalog_and_an_apps_file_are_read_no_further_than_their_bounds() {
    let stub = Stub::mem0().await;
    let catalog = AppCatalog::new(BaseUrl::parse(&stub.base_url()).unwrap());
    let notes = json!({
        "id": "notes",
        "name": "Notes",
        "summary": "What she writes down",
        "icon": "notebook",
        "tint": "orange",
        "version": "1.0.0",
        "changes": "The first version.",
        "wakes": false,
        "sha256": "0".repeat(64),
    });

    stub.answer(
        "/catalog.json",
        Answer::text(200, &" ".repeat(PAST_THE_BOUND)),
    );
    stub.answer(
        "/catalog.json",
        Answer::json(
            200,
            &json!({"format": "project02.catalog.v1", "apps": [notes]}),
        ),
    );
    stub.answer(
        "/apps/notes/1.0.0.js",
        Answer::text(200, &"x".repeat(PAST_THE_BOUND)),
    );

    assert!(matches!(
        catalog.catalog().await,
        Err(CatalogError::TooLarge)
    ));

    let read = catalog.catalog().await.unwrap();

    assert!(matches!(
        catalog.app(read.app("notes").unwrap()).await,
        Err(CatalogError::NotTheApp { why, .. }) if why == "its file is longer than an app's may be"
    ));
}
