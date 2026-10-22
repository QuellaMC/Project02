//! The settings through the socket: a view, a change, and a connector's
//! read.

use reqwest::Method;
use serde_json::json;

use crate::support::{Gateway, World};

/// A change bound to the fingerprint its view showed is applied, health
/// goes out on the stream, and the next view carries the new fingerprint;
/// a change bound to the old one is a conflict and writes nothing.
#[tokio::test]
async fn a_change_applies_bound_to_its_view_and_a_stale_one_conflicts() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let view = gateway
        .verb(Method::GET, "/api/config?scope=global", None)
        .await;
    let mut events = gateway.events().await;

    events.event("ready").await;

    let change = |fingerprint: &str, name: &str| {
        json!({
            "target": {"scope": "global"},
            "expectedFingerprint": fingerprint,
            "operation": {"kind": "set", "path": "project02.userDisplayName", "value": name},
        })
    };
    let fingerprint = view["fingerprint"].as_str().unwrap();
    let applied = gateway
        .verb(
            Method::POST,
            "/api/config",
            Some(&change(fingerprint, "Robin")),
        )
        .await;

    assert_eq!(view["status"], "ok");
    assert_eq!(applied["status"], "applied");
    events.event("health_changed").await;
    assert_eq!(
        gateway.fingerprint("?scope=global").await,
        applied["fingerprint"].as_str().unwrap()
    );

    let stale = gateway
        .verb(
            Method::POST,
            "/api/config",
            Some(&change(fingerprint, "Sam")),
        )
        .await;

    assert_eq!(
        (stale["status"].as_str(), stale["reason"].as_str()),
        (Some("refused"), Some("conflict"))
    );
    assert_eq!(world.settings()["project02"]["userDisplayName"], "Robin");
}

/// A connector's read hands its secrets in the clear, since a token is
/// what a connector exists to use, and a connector this build lacks is
/// unknown.
#[tokio::test]
async fn a_connector_reads_its_secrets_in_the_clear() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let fingerprint = gateway.fingerprint("?scope=global").await;

    gateway
        .verb(
            Method::POST,
            "/api/config",
            Some(&json!({
                "target": {"scope": "global"},
                "expectedFingerprint": fingerprint,
                "operation": {
                    "kind": "section_field_set",
                    "namespace": "connectors",
                    "id": "telegram",
                    "field": "managementBotToken",
                    "value": "123:management-secret",
                },
            })),
        )
        .await;

    let read = gateway
        .verb(Method::GET, "/api/connectors/telegram/config", None)
        .await;
    let unknown = gateway
        .verb(Method::GET, "/api/connectors/discord/config", None)
        .await;

    assert_eq!(read["status"], "ok");
    assert_eq!(
        read["home"]["values"]["managementBotToken"],
        "123:management-secret"
    );
    assert_eq!(
        (unknown["status"].as_str(), unknown["reason"].as_str()),
        (Some("refused"), Some("unknown_connector"))
    );
    assert!(
        !gateway
            .verb(Method::GET, "/api/config?scope=global", None)
            .await
            .to_string()
            .contains("management-secret")
    );
}
