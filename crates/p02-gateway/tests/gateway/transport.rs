//! The transport's rules: who may ask, how a request is read, and the one
//! envelope a refusal answers with.

use reqwest::{Method, StatusCode};
use serde_json::json;

use crate::support::{Answer, Gate, Gateway, Round, World};

/// An API request naming a host that is not loopback is misdirected, and
/// `localhost` is loopback.
#[tokio::test]
async fn a_host_that_is_not_loopback_is_refused_421() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let from = |host: String| {
        Answer::of(
            gateway
                .authorized(Method::GET, "/api/health")
                .header("host", host),
        )
    };

    let foreign = from("evil.example".to_owned()).await;

    assert!(
        foreign.refused(StatusCode::MISDIRECTED_REQUEST, "misdirected_host"),
        "{foreign:?}"
    );
    assert_eq!(
        from(format!("localhost:{}", gateway.port)).await.status,
        StatusCode::OK
    );
}

/// No token, or a wrong one, is unauthorized, and an `Authorization` that is
/// no bearer token cannot be read.
#[tokio::test]
async fn a_request_without_the_token_is_refused_and_a_malformed_one_unread() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let health = |authorization: Option<&'static str>| {
        let request = gateway.request(Method::GET, "/api/health");

        Answer::of(match authorization {
            Some(value) => request.header("authorization", value),
            None => request,
        })
    };

    for (authorization, status, code) in [
        (None, StatusCode::UNAUTHORIZED, "unauthorized"),
        (
            Some("Bearer wrong-token"),
            StatusCode::UNAUTHORIZED,
            "unauthorized",
        ),
        (
            Some("Bearer not a token!"),
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            Some("Basic dXNlcjpwYXNz"),
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
    ] {
        let answer = health(authorization).await;

        assert!(
            answer.refused(status, code),
            "{authorization:?}: {answer:?}"
        );
    }

    let cased = Answer::of(gateway.request(Method::GET, "/api/health").header(
        "authorization",
        format!("bearer   {}", gateway.token.as_str()),
    ))
    .await;

    assert_eq!(cased.status, StatusCode::OK);
}

/// A request from a foreign origin is forbidden, and the daemon's own
/// origin passes.
#[tokio::test]
async fn a_foreign_origin_is_forbidden_and_its_own_passes() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let from = |origin: String| {
        Answer::of(
            gateway
                .authorized(Method::GET, "/api/health")
                .header("origin", origin),
        )
    };

    let foreign = from("http://evil.example".to_owned()).await;

    assert!(
        foreign.refused(StatusCode::FORBIDDEN, "forbidden_origin"),
        "{foreign:?}"
    );
    assert_eq!(from(gateway.origin()).await.status, StatusCode::OK);
}

/// Every answer of the API is never cached: a verb's, each refusal, and
/// the event stream.
#[tokio::test]
async fn every_api_answer_is_never_cached() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let answers = [
        Answer::of(gateway.authorized(Method::GET, "/api/health")).await,
        Answer::of(
            gateway
                .authorized(Method::POST, "/api/conversations/open")
                .header("content-type", "application/json")
                .body("{"),
        )
        .await,
        Answer::of(gateway.request(Method::GET, "/api/health")).await,
        Answer::of(gateway.authorized(Method::GET, "/api/missing")).await,
        Answer::of(
            gateway
                .authorized(Method::GET, "/api/health")
                .header("host", "evil.example"),
        )
        .await,
        Answer::of(
            gateway
                .authorized(Method::GET, "/api/health")
                .header("origin", "http://evil.example"),
        )
        .await,
        Answer::of(
            gateway
                .authorized(Method::POST, "/api/turns")
                .header("content-type", "application/json")
                .body("x".repeat(64 * 1024 + 1)),
        )
        .await,
    ];
    let statuses: Vec<(u16, Option<&str>)> = answers
        .iter()
        .map(|answer| (answer.status.as_u16(), answer.header("cache-control")))
        .collect();

    assert_eq!(
        statuses,
        [200, 400, 401, 404, 421, 403, 413].map(|status| (status, Some("no-store")))
    );

    let stream = gateway.events().await;

    assert_eq!(stream.status(), StatusCode::OK);
    assert_eq!(stream.header("cache-control"), Some("no-store"));
}

/// A verb answers its outcome verbatim under 200, a refusal among them as
/// much as a success: nothing of the envelope.
#[tokio::test]
async fn every_verb_answers_its_outcome_under_200() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let health = gateway.verb(Method::GET, "/api/health", None).await;
    let started = gateway
        .verb(Method::POST, "/api/characters/mira/start", None)
        .await;
    let opened = gateway
        .verb(
            Method::POST,
            "/api/conversations/open",
            Some(&json!({"characterId": "mira"})),
        )
        .await;
    let conversation = opened["conversationId"].as_str().unwrap();
    let turn = gateway.say(conversation, "Hello.", "hello").await;
    let page = gateway
        .verb(
            Method::GET,
            &format!("/api/conversations/{conversation}/messages?limit=1"),
            None,
        )
        .await;
    let invalid_page = gateway
        .verb(
            Method::GET,
            &format!("/api/conversations/{conversation}/messages?limit=0"),
            None,
        )
        .await;
    let ghost = gateway
        .verb(
            Method::POST,
            "/api/conversations/open",
            Some(&json!({"characterId": "ghost"})),
        )
        .await;
    let fingerprint = gateway.fingerprint("?scope=global").await;
    let change = gateway
        .verb(
            Method::POST,
            "/api/config",
            Some(&json!({
                "target": {"scope": "global"},
                "expectedFingerprint": fingerprint,
                "operation": {"kind": "set", "path": "project02.userDisplayName", "value": "Robin"},
            })),
        )
        .await;

    assert_eq!(health["protocolVersion"], 7);
    assert_eq!(started["status"], "settled");
    assert_eq!(opened["status"], "opened");
    assert_eq!(turn["status"], "completed");
    assert_eq!(page["status"], "ok");
    assert_eq!(page["messages"].as_array().unwrap().len(), 1);
    assert_eq!(invalid_page["reason"], "invalid_page");
    assert_eq!(
        (ghost["status"].as_str(), ghost["reason"].as_str()),
        (Some("refused"), Some("unknown_character"))
    );
    assert_eq!(ghost.get("error"), None);
    assert_eq!(
        gateway.verb(Method::GET, "/api/confirmations", None).await,
        json!([])
    );
    assert_eq!(
        gateway
            .verb(
                Method::POST,
                "/api/confirmations/nothing-waits",
                Some(&json!({"decision": "approved"})),
            )
            .await,
        json!({"status": "unknown"})
    );
    assert_eq!(change["status"], "applied");
    assert_ne!(change["fingerprint"], fingerprint.as_str());
}

/// A body that is not JSON, one not sent as JSON, one of the wrong shape, a
/// stamp outside its pattern, a change without its value, and a view
/// naming no target cannot be read, each saying where.
#[tokio::test]
async fn a_body_or_query_the_route_cannot_take_is_400() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let line = Gateway::line("conv", "Hello.", "hello");
    let mut stamped = line.clone();

    stamped["source"] = json!("web ui");

    for (path, body, json, names) in [
        ("/api/turns", "{not json".to_owned(), true, "The message"),
        (
            "/api/conversations/open",
            json!({"characterId": "mira"}).to_string(),
            false,
            "sent as JSON",
        ),
        (
            "/api/turns",
            json!({"conversationId": "conv"}).to_string(),
            true,
            "senderId",
        ),
        ("/api/turns", stamped.to_string(), true, "message.source"),
        (
            "/api/turns",
            json!({"unexpected": true}).to_string(),
            true,
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
            true,
            "value",
        ),
        (
            "/api/connectors/telegram/pairing",
            json!({
                "subject": {"id": "two tokens", "label": "Alice"},
                "source": "telegram:mira_bot",
            })
            .to_string(),
            true,
            "pairing request.subject.id",
        ),
    ] {
        let request = gateway.authorized(Method::POST, path).body(body.clone());
        let answer = Answer::of(if json {
            request.header("content-type", "application/json")
        } else {
            request
        })
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
/// the text inside is refused for its own length.
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
            .contains("message.text"),
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

/// Once the stop began, every new API request is 503, the event stream's
/// among them, while the turn already accepted drains to its answer.
#[tokio::test]
async fn once_stopping_every_new_api_request_is_503_while_the_turn_drains() {
    let world = World::new();
    let mut gateway = Gateway::start(&world).await;
    let conversation = gateway.conversation().await;
    let gate = Gate::shut();

    gateway
        .model
        .script([Round::says("Still here.").held(&gate)]);

    let turn = tokio::spawn({
        let request = gateway
            .authorized(Method::POST, "/api/turns")
            .json(&Gateway::line(&conversation, "Still there?", "in-flight"));

        async move { Answer::of(request).await }
    });

    gate.reached().await;

    let closing = gateway.closing();
    let late = [
        Answer::of(gateway.authorized(Method::GET, "/api/health")).await,
        Answer::of(gateway.authorized(Method::GET, "/api/events")).await,
        Answer::of(gateway.request(Method::GET, "/api/missing")).await,
        Answer::of(
            gateway
                .authorized(Method::POST, "/api/turns")
                .json(&Gateway::line(&conversation, "Too late.", "late")),
        )
        .await,
    ];

    for answer in &late {
        assert!(
            answer.refused(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
            "{answer:?}"
        );
        assert_eq!(answer.json()["error"]["message"], "The daemon is stopping.");
        assert_eq!(answer.header("cache-control"), Some("no-store"));
    }

    gate.open();
    assert_eq!(turn.await.unwrap().json()["status"], "completed");
    closing.await.unwrap();
}

/// The daemon sends no CORS header, even to its own origin's preflight,
/// and takes the token from no cookie and no query.
#[tokio::test]
async fn no_cors_and_no_token_but_the_bearer() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let answers = [
        Answer::of(
            gateway
                .request(Method::OPTIONS, "/api/health")
                .header("origin", gateway.origin())
                .header("access-control-request-method", "GET")
                .header("access-control-request-headers", "authorization"),
        )
        .await,
        Answer::of(
            gateway
                .authorized(Method::GET, "/api/health")
                .header("origin", gateway.origin()),
        )
        .await,
        Answer::of(
            gateway
                .request(Method::GET, "/api/health")
                .header("cookie", format!("token={}", gateway.token.as_str())),
        )
        .await,
        Answer::of(gateway.request(
            Method::GET,
            &format!("/api/health?token={}", gateway.token.as_str()),
        ))
        .await,
    ];

    for answer in &answers {
        assert!(
            answer
                .headers
                .keys()
                .all(|name| !name.as_str().starts_with("access-control-")),
            "{answer:?}"
        );
    }

    assert_eq!(answers[2].status, StatusCode::UNAUTHORIZED);
    assert_eq!(answers[3].status, StatusCode::UNAUTHORIZED);
}
