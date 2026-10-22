//! The event stream: its first frame, its numbering, what a client that
//! comes back is handed, its heartbeat, the turns running in its snapshot,
//! a connector's presence, and a client that stops reading.

use std::time::{Duration, Instant};

use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

use crate::support::{Answer, Gate, Gateway, Round, World, data, telegram_connected, waits};

/// A request for an account to be let in, as a connector asks.
async fn ask_pairing(gateway: &Gateway, id: &str) -> Value {
    gateway
        .verb(
            Method::POST,
            "/api/connectors/telegram/pairing",
            Some(&json!({"subject": {"id": id, "label": format!("Account {id}")}})),
        )
        .await
}

/// The whole frames of a stream's bytes so far, each with its blank line.
fn frames(raw: &[u8]) -> Vec<String> {
    let text = String::from_utf8(raw.to_vec()).unwrap();

    text.split_inclusive("\n\n")
        .filter(|frame| frame.ends_with("\n\n"))
        .map(str::to_owned)
        .collect()
}

fn id_of(frame: &str) -> &str {
    frame
        .lines()
        .find_map(|line| line.strip_prefix("id: "))
        .unwrap()
}

/// A stream without a usable `Last-Event-ID` opens with `ready`: the
/// daemon's health, the confirmations and pairings waiting and the turns
/// running, as an event stream that is never cached.
#[tokio::test]
async fn a_stream_opens_with_the_snapshot() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;

    gateway
        .verb(Method::POST, "/api/characters/mira/start", None)
        .await;

    let asked = ask_pairing(&gateway, "friend").await;
    let mut events = gateway.events().await;
    let ready = events.event("ready").await;

    assert!(
        events
            .header("content-type")
            .unwrap()
            .starts_with("text/event-stream")
    );
    assert_eq!(events.header("cache-control"), Some("no-store"));
    assert_eq!(
        ready,
        json!({
            "protocolVersion": 7,
            "health": gateway.verb(Method::GET, "/api/health", None).await,
            "confirmations": [],
            "pairings": [asked["request"]],
            "turns": [],
        })
    );
}

/// Frames are numbered from one under the run's 16 hex digits, `ready`
/// carrying the number it goes on from, 0 before any, and each frame is one
/// line of JSON.
#[tokio::test]
async fn frames_are_numbered_and_ready_carries_the_number_it_goes_on_from() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let mut first = gateway.events().await;
    let opened = first.next(|_| true).await;
    let id = opened.id.clone().unwrap();
    let (run, zero) = id.split_once('-').unwrap();

    assert_eq!(opened.event.as_deref(), Some("ready"));
    assert_eq!(run.len(), 16);
    assert!(
        run.bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    );
    assert_eq!(zero, "0");

    ask_pairing(&gateway, "one").await;
    ask_pairing(&gateway, "two").await;
    first
        .event_where("pairing_requested", |event| event["subject"]["id"] == "two")
        .await;

    let mut second = gateway.events().await;
    let ready = second.next(|_| true).await;

    assert_eq!(
        first
            .frames
            .iter()
            .map(|frame| frame.id.clone().unwrap())
            .collect::<Vec<_>>(),
        [0, 1, 2].map(|number| format!("{run}-{number}"))
    );
    assert_eq!(ready.id, Some(format!("{run}-2")));

    for frame in first.frames.iter().chain([&ready]) {
        assert!(!frame.data.as_deref().unwrap().contains('\n'));
        assert!(data(frame).is_object());
    }
}

/// A turn reaches the stream as its line, its reply's drafts in order, the
/// reply they join to, then how it ended.
#[tokio::test]
async fn a_turn_reaches_the_stream_in_order() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let conversation = gateway.conversation().await;
    let mut events = gateway.events().await;

    gateway.say(&conversation, "Hello there.", "order").await;
    events
        .event_where("turn_completed", |event| {
            event["clientMessageId"] == "order"
        })
        .await;

    let said: Vec<Value> = events.frames[1..].iter().map(data).collect();
    let kinds: Vec<&str> = said
        .iter()
        .map(|event| {
            event["progress"]["kind"]
                .as_str()
                .or_else(|| event["kind"].as_str())
                .unwrap()
        })
        .collect();
    let text = |kind: &str| -> String {
        said.iter()
            .filter(|event| event["progress"]["kind"] == kind)
            .map(|event| event["progress"]["text"].as_str().unwrap())
            .collect()
    };

    assert_eq!(kinds.first(), Some(&"user_message"));
    assert!(
        kinds[1..kinds.len() - 2]
            .iter()
            .all(|kind| *kind == "reply_delta")
    );
    assert!(kinds.len() >= 5, "{kinds:?}");
    assert_eq!(
        kinds[kinds.len() - 2..],
        ["visible_reply", "turn_completed"]
    );
    assert_eq!(text("reply_delta"), text("visible_reply"));
}

/// A client that comes back with an id the tail holds is handed `resumed`
/// and exactly the frames after it, byte for byte, then the live frames
/// under the same numbers; one that holds the newest is handed none.
#[tokio::test]
async fn a_client_that_comes_back_is_resumed_byte_for_byte() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let conversation = gateway.conversation().await;
    let mut first = gateway.events().await;

    gateway.say(&conversation, "One.", "one").await;
    gateway.say(&conversation, "Two.", "two").await;
    first
        .event_where("turn_completed", |event| event["clientMessageId"] == "two")
        .await;

    let held = frames(&first.raw);
    let cursor = held
        .iter()
        .position(|frame| frame.contains(r#""clientMessageId":"one""#))
        .unwrap();
    let mut back = gateway
        .events_with("", &[("last-event-id", id_of(&held[cursor]))])
        .await;
    let resumed = "event: resumed\ndata: {}\n\n";
    let missed: String = held[cursor + 1..].concat();
    let last = held.last().unwrap();

    back.next(|frame| frame.id.as_deref() == Some(id_of(last)))
        .await;
    assert_eq!(
        String::from_utf8(back.raw.clone()).unwrap(),
        format!("{resumed}{missed}")
    );

    let mut newest = gateway
        .events_with("", &[("last-event-id", id_of(last))])
        .await;

    newest
        .next(|frame| frame.event.as_deref() == Some("resumed"))
        .await;
    gateway.say(&conversation, "Three.", "three").await;
    first
        .event_where("turn_completed", |event| {
            event["clientMessageId"] == "three"
        })
        .await;

    let live: Vec<String> = frames(&first.raw)[held.len()..].to_vec();

    newest
        .next(|frame| frame.id.as_deref() == Some(id_of(live.last().unwrap())))
        .await;
    assert_eq!(
        String::from_utf8(newest.raw.clone()).unwrap(),
        format!("{resumed}{}", live.concat())
    );
}

/// An id the tail let go of, one past the newest, one of another run and
/// one that is no id open with `ready`, while one still in the tail is
/// resumed.
#[tokio::test]
async fn an_id_the_tail_cannot_resume_opens_with_ready() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let conversation = gateway.conversation().await;
    let mut watching = gateway.events().await;
    let before = watching.next(|_| true).await.id.unwrap();
    let piece = "x".repeat(64 * 1024);

    // Twenty pieces of 64 KiB: more than the tail's mebibyte.
    gateway
        .model
        .script([Round::says("Done.").drafting(&[piece.as_str(); 20])]);
    gateway
        .say(&conversation, "Tell me everything.", "long")
        .await;
    watching
        .event_where("turn_completed", |event| event["clientMessageId"] == "long")
        .await;

    let last_delta = watching
        .frames
        .iter()
        .rev()
        .find(|frame| {
            frame.event.as_deref() == Some("turn_progress")
                && data(frame)["progress"]["kind"] == "reply_delta"
        })
        .unwrap()
        .id
        .clone()
        .unwrap();
    let newest = watching.frames.last().unwrap().id.clone().unwrap();
    let (run, number) = newest.split_once('-').unwrap();
    let other_run = format!(
        "{}{}",
        if run.starts_with('0') { '1' } else { '0' },
        &run[1..]
    );
    let opens_with = async |last_event_id: &str| {
        let mut events = gateway
            .events_with("", &[("last-event-id", last_event_id)])
            .await;

        events.next(|_| true).await.event.unwrap()
    };

    assert_eq!(opens_with(&last_delta).await, "resumed");

    for last_event_id in [
        before,
        format!("{run}-{}", number.parse::<u64>().unwrap() + 1),
        format!("{other_run}-1"),
        "yesterday".to_owned(),
        format!("{run}-+1"),
    ] {
        assert_eq!(opens_with(&last_event_id).await, "ready", "{last_event_id}");
    }
}

/// An idle stream says `: ping` each heartbeat.
#[tokio::test]
async fn an_idle_stream_pings_each_heartbeat() {
    let world = World::new();
    let gateway = Gateway::with(
        &world,
        waits(|durations| durations.heartbeat = Duration::from_millis(50)),
    )
    .await;
    let mut events = gateway.events().await;
    let ping = |frame: &p02_shared::SseFrame| frame.comment.as_deref() == Some("ping");

    events.next(ping).await;

    let first = Instant::now();

    events.next(ping).await;

    let interval = first.elapsed();

    assert!(interval >= Duration::from_millis(40), "{interval:?}");
    assert!(interval < Duration::from_secs(5), "{interval:?}");
}

/// A stream opened mid-reply finds the turn running in `ready`, with its
/// draft so far, and one opened after the turn finds none.
#[tokio::test]
async fn ready_holds_the_turn_running_with_its_draft_so_far() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let conversation = gateway.conversation().await;
    let mut watching = gateway.events().await;
    let gate = Gate::shut();

    gateway.model.script([Round::says("Hello there, friend.")
        .drafting(&["Hello", " there,"])
        .held(&gate)]);

    let turn = tokio::spawn({
        let request = gateway
            .authorized(Method::POST, "/api/turns")
            .json(&Gateway::line(&conversation, "Hello?", "running"));

        async move { Answer::of(request).await }
    });

    gate.reached().await;
    watching
        .event_where("turn_progress", |event| {
            event["progress"]["text"] == " there,"
        })
        .await;

    let mut mid_reply = gateway.events().await;

    assert_eq!(
        mid_reply.event("ready").await["turns"],
        json!([{
            "characterId": "mira",
            "conversationId": conversation,
            "source": "web",
            "clientMessageId": "running",
            "drafts": [{"draftId": "1.0", "text": "Hello there,"}],
        }])
    );
    gate.open();
    assert_eq!(turn.await.unwrap().json()["status"], "completed");
    watching
        .event_where("turn_completed", |event| {
            event["clientMessageId"] == "running"
        })
        .await;
    assert_eq!(
        gateway.events().await.event("ready").await["turns"],
        json!([])
    );
}

/// A connector's stream holds it present from before its first frame until
/// its last stream ends, health changing only when the count crosses zero;
/// a connector this build lacks is refused, naming those it has.
#[tokio::test]
async fn a_connector_is_present_while_its_streams_are_open() {
    let world = World::new();
    let gateway = Gateway::start(&world).await;
    let mut watching = gateway.events().await;
    let unknown =
        Answer::of(gateway.authorized(Method::GET, "/api/events?connector=discord")).await;

    assert!(
        unknown.refused(StatusCode::BAD_REQUEST, "invalid_request"),
        "{unknown:?}"
    );
    assert!(
        unknown.json()["error"]["message"]
            .as_str()
            .unwrap()
            .contains("telegram")
    );

    let mut first = gateway.events_with("?connector=telegram", &[]).await;

    assert_eq!(telegram_connected(&first.event("ready").await), Some(true));
    watching
        .event_where("health_changed", |event| {
            telegram_connected(event) == Some(true)
        })
        .await;

    let mut second = gateway.events_with("?connector=telegram", &[]).await;

    second.event("ready").await;
    drop(first);
    drop(second);
    watching
        .event_where("health_changed", |event| {
            telegram_connected(event) == Some(false)
        })
        .await;

    // A frame after both ends, which every frame of theirs precedes.
    let asked = ask_pairing(&gateway, "later").await;

    watching
        .event_where("pairing_requested", |event| {
            event["code"] == asked["request"]["code"]
        })
        .await;
    assert_eq!(
        watching
            .all("health_changed")
            .iter()
            .map(telegram_connected)
            .collect::<Vec<_>>(),
        [Some(true), Some(false)]
    );
}

/// A client that stops taking frames is dropped within the grace: its
/// connection is closed, and what it held of the connector's presence goes.
#[tokio::test]
async fn a_client_that_stops_reading_is_dropped_within_the_grace() {
    let world = World::new();
    let grace = Duration::from_millis(300);
    let gateway = Gateway::with(&world, waits(|durations| durations.grace = grace)).await;
    let conversation = gateway.conversation().await;
    let mut watching = gateway.events().await;
    let mut stalled = gateway.events_with("?connector=telegram", &[]).await;

    stalled.event("ready").await;
    watching
        .event_where("health_changed", |event| {
            telegram_connected(event) == Some(true)
        })
        .await;

    let piece = "x".repeat(64 * 1024);

    // Eight mebibytes of draft: far more than the sockets between the two
    // hold for a reader that takes nothing.
    gateway
        .model
        .script([Round::says("Done.").drafting(&[piece.as_str(); 128])]);

    let said = Instant::now();
    let turn = tokio::spawn({
        let request = gateway
            .authorized(Method::POST, "/api/turns")
            .json(&Gateway::line(&conversation, "Talk a lot.", "long"));

        async move { Answer::of(request).await }
    });

    // The watching client keeps taking its frames meanwhile, as a client
    // that reads does; only the stalled one is gone.
    watching
        .event_where("health_changed", |event| {
            telegram_connected(event) == Some(false)
        })
        .await;

    let dropped = said.elapsed();

    assert!(dropped >= grace, "{dropped:?}");
    assert!(dropped < Duration::from_secs(30), "{dropped:?}");
    assert_eq!(turn.await.unwrap().json()["status"], "completed");
    stalled.ended().await;
    assert!(!String::from_utf8_lossy(&stalled.raw).contains("event: turn_completed"));
}
