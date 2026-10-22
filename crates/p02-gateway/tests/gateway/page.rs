//! The page the binary serves at its root.

use p02_app::Durations;
use p02_gateway::Page;
use reqwest::{Method, StatusCode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::support::{Answer, Gateway, NoPage, PATIENCE, World};

/// The page's files are served with no token and never cached, `HEAD`
/// answers their headers alone, and a path naming nothing the page holds,
/// one climbing out of it among them, meets the daemon's own 404.
#[tokio::test]
async fn the_page_is_served_public_and_uncached_and_nothing_else() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let page = Answer::of(gateway.request(Method::GET, "/")).await;
    let script = page
        .text
        .split("src=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap()
        .to_owned();
    let asset = Answer::of(gateway.request(Method::GET, &script)).await;

    assert_eq!(page.status, StatusCode::OK);
    assert!(page.header("content-type").unwrap().contains("text/html"));
    assert_eq!(page.header("cache-control"), Some("no-store"));
    assert_eq!(asset.status, StatusCode::OK);
    assert!(asset.header("content-type").unwrap().contains("javascript"));
    assert_eq!(asset.header("cache-control"), Some("no-store"));

    for path in ["/", script.as_str()] {
        let head = raw(&gateway, "HEAD", path).await;
        let (status, rest) = head.split_once("\r\n").unwrap();

        assert_eq!(status, "HTTP/1.1 200 OK", "{path}");
        assert!(
            rest.contains("cache-control: no-store\r\n"),
            "{path}: {head}"
        );
        assert!(head.ends_with("\r\n\r\n"), "{path}: {head}");
    }

    for path in [
        "/missing.js",
        "/%2e%2e/Cargo.toml",
        "/../Cargo.toml",
        "/assets/",
    ] {
        let missing = raw(&gateway, "GET", path).await;

        assert!(
            missing.starts_with("HTTP/1.1 404 Not Found\r\n"),
            "{path}: {missing}"
        );
        assert!(
            missing.contains(r#"{"error":{"code":"not_found","#),
            "{path}: {missing}"
        );
        assert!(!missing.contains("[package]"), "{path}");
    }
}

/// What the server answers a raw request for `path`, the path sent as it
/// is written, after which the connection closes.
async fn raw(gateway: &Gateway, method: &str, path: &str) -> String {
    let mut socket = gateway.socket().await;
    let mut received = Vec::new();

    socket
        .write_all(
            format!(
                "{method} {path} HTTP/1.1\r\nhost: 127.0.0.1:{}\r\nconnection: close\r\n\r\n",
                gateway.port
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    tokio::time::timeout(PATIENCE, socket.read_to_end(&mut received))
        .await
        .unwrap()
        .unwrap();
    String::from_utf8(received).unwrap()
}

/// Built without a page, the root says how to build one and where the API
/// is, in plain text.
#[tokio::test]
async fn without_a_built_page_the_root_names_the_api() {
    let world = World::new();
    let gateway = Gateway::serving(&world, Durations::default(), Page::embedded::<NoPage>()).await;
    let root = Answer::of(gateway.request(Method::GET, "/")).await;

    assert_eq!(root.status, StatusCode::NOT_FOUND);
    assert!(
        root.header("content-type")
            .unwrap()
            .starts_with("text/plain")
    );
    assert!(root.text.contains("/api"), "{}", root.text);
}
