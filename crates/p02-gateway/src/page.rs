//! The web page: files built into the binary, so nothing a request names
//! can reach the disk.

use std::borrow::Cow;

use axum::body::{Body, Bytes};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

use crate::http::Refusal;

/// What `pnpm build:web` left in `packages/page/dist` when the binary was
/// built, or nothing when it had not run.
#[derive(RustEmbed)]
#[folder = "../../packages/page/dist/"]
#[allow_missing = true]
struct Built;

/// The file `path` names, public and never cached, so a rebuilt page shows
/// on the next load; hyper answers `HEAD` with the headers alone. A path
/// naming nothing the page holds meets the daemon's own 404, and without a
/// page the root says how to build one.
pub(crate) fn answer(method: &Method, path: &str) -> Response {
    let name = match path {
        "/" => "index.html",
        path => path.strip_prefix('/').unwrap_or(path),
    };
    let file = matches!(*method, Method::GET | Method::HEAD)
        .then(|| Built::get(name))
        .flatten();

    match file {
        Some(file) => {
            let content_type = file.metadata.mimetype().to_owned();
            let body = match file.data {
                Cow::Borrowed(bytes) => Body::from(Bytes::from_static(bytes)),
                Cow::Owned(bytes) => Body::from(bytes),
            };

            (
                [
                    (CONTENT_TYPE, content_type),
                    (CACHE_CONTROL, "no-store".to_owned()),
                ],
                body,
            )
                .into_response()
        }
        None if path == "/" && Built::get("index.html").is_none() => (
            StatusCode::NOT_FOUND,
            "No web page is built here: run `pnpm build`. The API is under /api.",
        )
            .into_response(),
        None => Refusal::new(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("Nothing is served at {path}."),
        )
        .into_response(),
    }
}
