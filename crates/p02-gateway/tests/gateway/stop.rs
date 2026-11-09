//! The stop: what it waits for, and what it cuts.

use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpSocket;

use crate::support::{Gateway, PATIENCE, World, waits};

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
    gateway.model.says(&"\u{1}".repeat(1024 * 1024));

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
