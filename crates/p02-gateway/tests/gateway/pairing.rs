//! Pairing through the socket: a connector's request for an account, the
//! person's answer, and what it writes.

use p02_core::Timestamp;
use p02_shared::{PathEntry, describe_entry};
use reqwest::Method;
use serde_json::{Value, json};

use crate::support::{Gateway, World};

const ALICE: &str = "381940562";
const BOB: &str = "987654321";

/// Asks for the account as Mira's bot does when it writes there.
async fn ask(gateway: &Gateway, connector: &str, id: &str, label: &str) -> Value {
    gateway
        .verb(
            Method::POST,
            &format!("/api/connectors/{connector}/pairing"),
            Some(&json!({
                "subject": {"id": id, "label": label},
                "source": "telegram:mira_bot",
            })),
        )
        .await
}

async fn answer(gateway: &Gateway, code: &Value, decision: &str) -> Value {
    gateway
        .verb(
            Method::POST,
            &format!("/api/pairing/{}", code.as_str().unwrap()),
            Some(&json!({"decision": decision})),
        )
        .await
}

/// An account a connector does not know waits under a six-digit code until
/// the pairing deadline, every surface hears of it, and asking again for
/// the same account answers the same request.
#[tokio::test]
async fn a_request_waits_under_a_six_digit_code_and_asking_again_answers_it() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let mut events = gateway.events().await;
    let asked = ask(&gateway, "telegram", ALICE, "Alice (@alice)").await;
    let request = &asked["request"];
    let code = request["code"].as_str().unwrap();
    let requested_at = Timestamp::new(request["requestedAt"].as_str().unwrap()).unwrap();

    assert_eq!(asked["status"], "pending");
    assert_eq!(code.len(), 6);
    assert!(code.bytes().all(|byte| byte.is_ascii_digit()));
    assert_eq!(request["connectorId"], "telegram");
    assert_eq!(
        request["subject"],
        json!({"id": ALICE, "label": "Alice (@alice)"})
    );
    assert_eq!(
        request["expiresAt"].as_i64().unwrap(),
        requested_at.unix_millis() + 60 * 60 * 1000
    );

    let mut announced = events.event("pairing_requested").await;

    announced.as_object_mut().unwrap().remove("kind");
    assert_eq!(&announced, request);
    assert_eq!(
        ask(&gateway, "telegram", ALICE, "Alice (@alice)").await,
        asked
    );
    assert_eq!(
        gateway.verb(Method::GET, "/api/pairing", None).await,
        json!([request])
    );
}

/// Pairing is refused for a connector this build lacks and for a name of
/// more than one line, and an answer to a code never given finds nothing.
#[tokio::test]
async fn a_request_the_daemon_cannot_take_is_refused() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let unknown = ask(&gateway, "discord", ALICE, "Alice").await;
    let multiline = ask(&gateway, "telegram", ALICE, "Alice\nApproved").await;

    assert_eq!(
        (unknown["status"].as_str(), unknown["reason"].as_str()),
        (Some("refused"), Some("unknown_connector"))
    );
    assert!(unknown["message"].as_str().unwrap().contains("telegram"));
    assert_eq!(
        (multiline["status"].as_str(), multiline["reason"].as_str()),
        (Some("refused"), Some("invalid_subject"))
    );
    assert_eq!(
        answer(&gateway, &json!("123456"), "approved").await,
        json!({"status": "unknown"})
    );
    assert_eq!(
        gateway.verb(Method::GET, "/api/pairing", None).await,
        json!([])
    );
}

/// An approval writes the account into the home's allowlist, says health
/// has changed before it says the request settled, and asking for the
/// account again answers paired.
#[tokio::test]
async fn an_approval_writes_the_allowlist_and_the_account_is_paired() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let mut events = gateway.events().await;
    let asked = ask(&gateway, "telegram", ALICE, "Alice (@alice)").await;
    let code = &asked["request"]["code"];

    assert_eq!(
        answer(&gateway, code, "approved").await,
        json!({"status": "settled", "decision": "approved"})
    );

    events.event("pairing_requested").await;
    events.event("health_changed").await;

    let settled = events.event("pairing_settled").await;

    assert_eq!(
        settled,
        json!({
            "kind": "pairing_settled",
            "connectorId": "telegram",
            "code": code,
            "subject": {"id": ALICE, "label": "Alice (@alice)"},
            "decision": "approved",
        })
    );
    assert_eq!(
        world.settings()["connectors"]["telegram"]["config"]["pairedUsers"],
        json!({ALICE: "Alice (@alice)"})
    );
    assert_eq!(
        ask(&gateway, "telegram", ALICE, "Alice (@alice)").await,
        json!({"status": "paired"})
    );
}

/// A denial settles the request denied and writes nothing, and a second
/// answer to it finds nothing.
#[tokio::test]
async fn a_denial_writes_nothing_and_a_second_answer_is_unknown() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let mut events = gateway.events().await;
    let asked = ask(&gateway, "telegram", ALICE, "Alice").await;
    let code = &asked["request"]["code"];

    assert_eq!(
        answer(&gateway, code, "denied").await,
        json!({"status": "settled", "decision": "denied"})
    );
    assert_eq!(events.event("pairing_settled").await["decision"], "denied");
    assert!(matches!(
        describe_entry(&world.path("config.json")),
        PathEntry::Absent
    ));
    assert_eq!(
        answer(&gateway, code, "approved").await,
        json!({"status": "unknown"})
    );
}

/// An approval the home cannot take answers failed with the reason, and the
/// request waits on, announced again, until an approval can be written.
#[cfg(unix)]
#[tokio::test]
async fn an_approval_that_cannot_be_written_leaves_the_request_waiting() {
    use crate::support::mode;

    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let fingerprint = gateway.fingerprint("?scope=global").await;

    // A first change makes the home's document and its lock's file, as a
    // home that has run holds them.
    gateway
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

    let mut events = gateway.events().await;
    let asked = ask(&gateway, "telegram", ALICE, "Alice").await;
    let request = &asked["request"];

    events.event("pairing_requested").await;
    mode(world.home.root(), 0o500);

    let failed = answer(&gateway, &request["code"], "approved").await;

    mode(world.home.root(), 0o755);
    assert_eq!(failed["status"], "failed");
    assert!(
        failed["message"]
            .as_str()
            .unwrap()
            .contains(&world.path("config.json").display().to_string()),
        "{failed}"
    );

    let mut again = events.event("pairing_requested").await;

    again.as_object_mut().unwrap().remove("kind");
    assert_eq!(&again, request);
    assert_eq!(
        gateway.verb(Method::GET, "/api/pairing", None).await,
        json!([request])
    );
    assert_eq!(
        answer(&gateway, &request["code"], "approved").await,
        json!({"status": "settled", "decision": "approved"})
    );
}

/// A request whose account another settings window paired meanwhile
/// settles approved, whether asked for again or answered, and keeps the
/// name that window gave.
#[tokio::test]
async fn a_request_another_window_paired_settles_approved_keeping_its_name() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let mut events = gateway.events().await;
    let for_alice = ask(&gateway, "telegram", ALICE, "Alice (@alice)").await;
    let for_bob = ask(&gateway, "telegram", BOB, "Bob (@bob)").await;
    let named = json!({ALICE: "Alice", BOB: "Bob"});
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
                    "field": "pairedUsers",
                    "value": named,
                },
            })),
        )
        .await;

    assert_eq!(
        ask(&gateway, "telegram", ALICE, "Alice (@alice)").await,
        json!({"status": "paired"})
    );
    assert_eq!(
        events
            .event_where("pairing_settled", |event| event["code"]
                == for_alice["request"]["code"])
            .await["decision"],
        "approved"
    );
    assert_eq!(
        answer(&gateway, &for_bob["request"]["code"], "approved").await,
        json!({"status": "settled", "decision": "approved"})
    );
    assert_eq!(
        world.settings()["connectors"]["telegram"]["config"]["pairedUsers"],
        named
    );
}
