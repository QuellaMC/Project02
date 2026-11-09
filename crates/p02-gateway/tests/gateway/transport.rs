//! The transport's rules: how a request is read, and the one envelope a
//! refusal answers with.

use reqwest::{Method, StatusCode};
use serde_json::json;

use crate::support::{Answer, Gateway, World};

/// A body that is not JSON, one of the wrong shape, a stamp outside its
/// pattern, a change without its value, and a view naming no target cannot
/// be read, each saying which request it was.
#[tokio::test]
async fn a_body_or_query_the_route_cannot_take_is_400() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let line = Gateway::line("conv", "Hello.", "hello");
    let mut stamped = line.clone();

    stamped["source"] = json!("web ui");

    for (path, body, names) in [
        ("/api/turns", "{not json".to_owned(), "The message"),
        (
            "/api/turns",
            json!({"conversationId": "conv"}).to_string(),
            "senderId",
        ),
        ("/api/turns", stamped.to_string(), "not a client stamp"),
        (
            "/api/turns",
            json!({"unexpected": true}).to_string(),
            "unexpected",
        ),
        (
            "/api/config",
            json!({
                "target": {"scope": "global"},
                "expectedFingerprint": "fingerprint",
                "operation": {"kind": "set", "path": "project02.enabled"},
            })
            .to_string(),
            "value",
        ),
        (
            "/api/connectors/telegram/pairing",
            json!({
                "subject": {"id": "381940562", "label": "Alice\nApproved"},
                "source": "telegram:mira_bot",
            })
            .to_string(),
            "The pairing request",
        ),
    ] {
        let answer = Answer::of(
            gateway
                .authorized(Method::POST, path)
                .header("content-type", "application/json")
                .body(body.clone()),
        )
        .await;

        assert!(
            answer.refused(StatusCode::BAD_REQUEST, "invalid_request"),
            "{body}: {answer:?}"
        );
        assert!(
            answer.json()["error"]["message"]
                .as_str()
                .unwrap()
                .contains(names),
            "{body}: {answer:?}"
        );
    }

    for query in ["", "?scope=character", "?scope=nobody"] {
        let answer =
            Answer::of(gateway.authorized(Method::GET, &format!("/api/config{query}"))).await;

        assert!(
            answer.refused(StatusCode::BAD_REQUEST, "invalid_request"),
            "{query}: {answer:?}"
        );
    }
}

/// A body over 64 KiB is too large, while one of 64 KiB is read through:
/// the line inside is refused for its own length.
#[tokio::test]
async fn a_body_over_64_kib_is_413_and_one_of_64_kib_is_read() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let of_bytes =
        |bytes: usize| json!({"text": "x".repeat(bytes - r#"{"text":""}"#.len())}).to_string();
    let post = |body: String| {
        Answer::of(
            gateway
                .authorized(Method::POST, "/api/turns")
                .header("content-type", "application/json")
                .body(body),
        )
    };

    let over = post(of_bytes(64 * 1024 + 1)).await;
    let within = post(of_bytes(64 * 1024)).await;

    assert!(
        over.refused(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
        "{over:?}"
    );
    assert!(
        within.refused(StatusCode::BAD_REQUEST, "invalid_request"),
        "{within:?}"
    );
    assert!(
        within.json()["error"]["message"]
            .as_str()
            .unwrap()
            .contains("a line is at most"),
        "{within:?}"
    );
}

/// An unknown API route, `/api` itself included, is 404 behind the same
/// rules, so without the token it is 401; a known route under another
/// method is no route either.
#[tokio::test]
async fn an_unknown_api_route_is_404_behind_the_token() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;

    for path in ["/api/missing", "/api", "/api/turns"] {
        let found = Answer::of(gateway.authorized(Method::GET, path)).await;
        let unauthorized = Answer::of(gateway.request(Method::GET, path)).await;

        assert!(
            found.refused(StatusCode::NOT_FOUND, "not_found"),
            "{path}: {found:?}"
        );
        assert!(
            unauthorized.refused(StatusCode::UNAUTHORIZED, "unauthorized"),
            "{path}: {unauthorized:?}"
        );
    }
}
