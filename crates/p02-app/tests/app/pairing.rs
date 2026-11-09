//! A connector's request to let an account in, and its deadline.

use std::time::Duration;

use p02_core::{ClientStamp, SpeakerName};
use p02_wire::{Answer, Event, PairingAnswer, PairingOutcome};
use serde_json::json;

use crate::support::{Ear, World, wire};

/// A request nobody answers settles expired at its deadline, on the
/// daemon's own clock, and a later answer finds nothing.
#[tokio::test(start_paused = true)]
async fn a_request_nobody_answers_expires_at_its_deadline() {
    let world = World::new();
    let daemon = world.daemon(Vec::new()).await;
    let mut ear = Ear::on(&daemon);
    let PairingOutcome::Pending { request } = daemon
        .request_pairing(
            "telegram",
            ClientStamp::new("381940562").unwrap(),
            SpeakerName::new("Alice").unwrap(),
            ClientStamp::new("telegram:mira_bot").unwrap(),
        )
        .await
    else {
        panic!("the request waits");
    };

    tokio::time::sleep(Duration::from_hours(1) - Duration::from_millis(1)).await;
    assert_eq!(daemon.pending_pairings().len(), 1);
    tokio::time::sleep(Duration::from_millis(2)).await;

    let settled = ear
        .until(|event| matches!(event, Event::PairingSettled { .. }))
        .await;

    assert_eq!(
        wire(&settled),
        json!({
            "kind": "pairing_settled",
            "connectorId": "telegram",
            "code": request.code,
            "subject": {"id": "381940562", "label": "Alice"},
            "decision": "expired",
        })
    );
    assert_eq!(
        daemon.settle_pairing(&request.code, Answer::Approved).await,
        PairingAnswer::Unknown
    );
    assert!(daemon.pending_pairings().is_empty());
}
