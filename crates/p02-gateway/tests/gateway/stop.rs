//! The stop: what it finishes, what it waits for, and what it cuts.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::{Method, StatusCode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpSocket;

use crate::support::{Answer, Gate, Gateway, PATIENCE, Round, World, data, waits};

/// A stop lets the turn in flight finish, its answer and its frames, and
/// only then ends the streams, each once everything the stop announced,
/// her last state after the turn's completion, and every frame queued for
/// it are written, a client far behind that keeps taking them included; a
/// stream asked for meanwhile is refused at once.
#[tokio::test]
async fn a_stop_drains_the_turn_in_flight_then_ends_each_stream_whole() {
    let world = World::new();
    // Longer than the stop takes to reach the streams.
    let mut gateway = Gateway::with(
        &world,
        waits(|durations| durations.grace = Duration::from_secs(30)),
    )
    .await;
    let conversation = gateway.conversation().await;
    let settled = Arc::new(Mutex::new(Vec::new()));
    let mut keeping_up = gateway.events().await;
    let mut lagging = gateway.events().await;

    keeping_up.event("ready").await;
    lagging.event("ready").await;

    let gate = Gate::shut();
    let piece = "x".repeat(64 * 1024);

    gateway.model.script([Round::says("Still here.")
        .drafting(&[piece.as_str(); 128])
        .held(&gate)]);

    let turn = tokio::spawn({
        let request = gateway
            .authorized(Method::POST, "/api/turns")
            .json(&Gateway::line(&conversation, "Still there?", "in-flight"));
        let settled = Arc::clone(&settled);

        async move {
            let answer = Answer::of(request).await;

            settled.lock().unwrap().push("answered");
            answer
        }
    });
    let watched = tokio::spawn({
        let settled = Arc::clone(&settled);

        async move {
            keeping_up.ended().await;
            settled.lock().unwrap().push("ended");
            keeping_up
        }
    });

    gate.reached().await;

    let closing = gateway.closing();
    let asked = Instant::now();
    let late = Answer::of(gateway.authorized(Method::GET, "/api/events")).await;

    assert!(
        late.refused(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
        "{late:?}"
    );
    assert!(asked.elapsed() < Duration::from_secs(5));
    gate.open();

    let answered = turn.await.unwrap().json();
    let keeping_up = watched.await.unwrap();

    lagging.ended().await;
    closing.await.unwrap();

    let messages: Vec<&str> = answered["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["text"].as_str().unwrap())
        .collect();

    assert_eq!(messages, ["Still there?", "Still here."]);
    assert_eq!(*settled.lock().unwrap(), ["answered", "ended"]);

    let numbered = |frames: &[p02_shared::SseFrame]| -> Vec<p02_shared::SseFrame> {
        frames
            .iter()
            .filter(|frame| frame.id.is_some() && frame.event.as_deref() != Some("ready"))
            .cloned()
            .collect()
    };
    let completed = keeping_up
        .all("turn_completed")
        .into_iter()
        .find(|event| event["clientMessageId"] == "in-flight")
        .unwrap();

    assert_eq!(completed["status"], "completed");
    assert_eq!(numbered(&lagging.frames), numbered(&keeping_up.frames));

    let at = |kind: &str, wanted: &dyn Fn(&serde_json::Value) -> bool| {
        keeping_up
            .frames
            .iter()
            .position(|frame| frame.event.as_deref() == Some(kind) && wanted(&data(frame)))
    };
    let completed_at = at("turn_completed", &|event| {
        event["clientMessageId"] == "in-flight"
    });
    let stopped_at = at("state_changed", &|event| event["state"] == "stopped");

    assert!(completed_at < stopped_at, "{completed_at:?} {stopped_at:?}");
    assert!(stopped_at.is_some());
}

/// A stop gives a client that stopped reading a large answer the grace,
/// then cuts it, and lets go of nothing before.
#[tokio::test]
#[cfg_attr(
    windows,
    ignore = "Windows takes a whole answer into its buffers at one write while they have room, \
              so an answer to a reader that stopped is never still being written there: the \
              system delivers it after the stop"
)]
async fn a_stop_gives_a_stalled_reader_the_grace_then_cuts_it() {
    let world = World::new();
    let grace = Duration::from_millis(500);
    let mut gateway = Gateway::with(&world, waits(|durations| durations.grace = grace)).await;
    let conversation = gateway.conversation().await;
    let mut events = gateway.events().await;

    // JSON writes a control character in six bytes: the answer is several
    // mebibytes, more than the sockets hold for a reader that takes
    // nothing.
    gateway
        .model
        .script([Round::says(&"\u{1}".repeat(1024 * 1024))]);

    let socket = TcpSocket::new_v4().unwrap();

    socket.set_recv_buffer_size(4096).unwrap();

    let mut reader = socket
        .connect(([127, 0, 0, 1], gateway.port.get()).into())
        .await
        .unwrap();
    let body = Gateway::line(&conversation, "Tell me everything.", "everything").to_string();

    reader
        .write_all(
            format!(
                "{}{body}",
                gateway.head_of(
                    "POST",
                    "/api/turns",
                    &[
                        ("content-type", "application/json"),
                        ("content-length", &body.len().to_string()),
                    ],
                )
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    events
        .event_where("turn_completed", |event| {
            event["clientMessageId"] == "everything"
        })
        .await;

    let stopped = Instant::now();

    gateway.close().await;

    let took = stopped.elapsed();
    let mut received = Vec::new();

    tokio::time::timeout(PATIENCE, reader.read_to_end(&mut received))
        .await
        .unwrap()
        .ok();

    let head_end = received
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap();
    let head = String::from_utf8_lossy(&received[..head_end]).to_ascii_lowercase();
    let announced: usize = head
        .lines()
        .find_map(|line| line.strip_prefix("content-length: "))
        .unwrap()
        .parse()
        .unwrap();

    assert!(took >= grace, "{took:?}");
    assert!(took < grace + Duration::from_secs(10), "{took:?}");
    assert!(received.len() - head_end - 4 < announced);
}

/// A stop does not wait on a client that stalled halfway through its
/// request's body, whatever the grace.
#[tokio::test]
async fn a_stop_does_not_wait_on_a_client_stalled_mid_body() {
    let world = World::new();
    let mut gateway = Gateway::with(
        &world,
        waits(|durations| durations.grace = Duration::from_secs(60)),
    )
    .await;
    let mut stalled = gateway.socket().await;

    stalled
        .write_all(
            gateway
                .head_of(
                    "POST",
                    "/api/turns",
                    &[
                        ("content-type", "application/json"),
                        ("content-length", "100"),
                        ("expect", "100-continue"),
                    ],
                )
                .as_bytes(),
        )
        .await
        .unwrap();

    let mut continued = [0; 25];

    tokio::time::timeout(PATIENCE, stalled.read_exact(&mut continued))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&continued, b"HTTP/1.1 100 Continue\r\n\r\n");
    stalled.write_all(b"{\"conversationId\":").await.unwrap();

    let stopped = Instant::now();

    gateway.close().await;
    assert!(stopped.elapsed() < Duration::from_secs(5));

    let mut rest = Vec::new();

    tokio::time::timeout(PATIENCE, stalled.read_to_end(&mut rest))
        .await
        .unwrap()
        .ok();
}
