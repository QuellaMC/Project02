//! The event stream: every event of the daemon numbered and formatted once,
//! as a frame of server-sent events, the newest frames kept for a client
//! that comes back, and each open stream fed its frames in order, each one
//! given the grace to be taken.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::fmt;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::header::CONTENT_TYPE;
use axum::response::{IntoResponse, Response};
use hyper::body::Frame;
use p02_app::{
    Daemon, Event, Health, PROTOCOL_VERSION, PairingRequest, PendingConfirmation, Presence,
    RunningTurn, RunningTurns,
};
use p02_config::Connector;
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use ts_rs::TS;

/// How much of the stream is kept for a client that comes back, in UTF-8
/// bytes of formatted frames: minutes of a busy stream, since a reply is a
/// few kilobytes a second. A client further behind gets the snapshot,
/// which is always right.
const TAIL_BYTES: usize = 1024 * 1024;

/// What an idle stream says to stay alive.
const PING: &[u8] = b": ping\n\n";

/// The first frame of a stream a client came back to, from which nothing
/// is missed: there is nothing to install.
const RESUMED: &[u8] = b"event: resumed\ndata: {}\n\n";

/// The streams over the daemon's events. One subscription, taken when they
/// are made and kept while they live, folds the turns running and numbers
/// and formats every event once, keeps the tail, and hands each frame to
/// every open stream, all in one step, so a stream that opens in a step of
/// its own finds the turns running exactly as of the frame it goes on
/// from: a client that installs them and applies the frames after tells
/// no draft twice.
#[derive(Clone)]
pub(crate) struct Streams(Arc<Shared>);

struct Shared {
    daemon: Daemon,
    /// This run's id, under which every frame is numbered: an id of
    /// another run names frames this one never held.
    run: String,
    /// Held only for steps that never wait, so nothing that holds it waits
    /// on anything that wants it.
    hub: Mutex<Hub>,
    writers: TaskTracker,
    closing: CancellationToken,
}

struct Hub {
    /// The one subscription, taken from only while the hub is held and
    /// each event framed in the same step, so every event is framed once,
    /// in the order it was announced.
    events: mpsc::UnboundedReceiver<Event>,
    tail: Tail,
    turns: RunningTurns,
    /// The number of the newest frame that changed what `ready` reads of
    /// the daemon: every event but a turn's, whose turns the hub folds
    /// itself.
    changed: u64,
    open: Vec<mpsc::UnboundedSender<Bytes>>,
    closed: bool,
}

/// The newest frames, oldest out first while they hold more than the
/// bound. An id is reachable from one before the oldest kept, by a client
/// that saw just up to it and so missed nothing the tail let go, to the
/// newest.
#[derive(Default)]
struct Tail {
    frames: VecDeque<(u64, Bytes)>,
    bytes: usize,
    /// The number of the newest frame; 0 before the first.
    latest: u64,
}

/// Why a stream did not open.
#[derive(Debug)]
pub(crate) enum Unopened {
    /// The stop began.
    Stopping,
    /// The snapshot would not spell as JSON, which is the daemon's fault.
    Unformatted(serde_json::Error),
}

/// The first frame of a stream that cannot be caught up: the state every
/// later frame moves on from.
#[derive(Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "GatewayReady")]
#[schemars(rename = "GatewayReady")]
pub(crate) struct Ready {
    pub(crate) protocol_version: u32,
    pub(crate) health: Health,
    pub(crate) confirmations: Vec<PendingConfirmation>,
    pub(crate) pairings: Vec<PairingRequest>,
    pub(crate) turns: Vec<RunningTurn>,
}

impl Streams {
    /// The streams of `daemon`, subscribed to its events from now on.
    pub(crate) fn new(daemon: Daemon) -> Self {
        let hub = Hub {
            events: daemon.events(),
            tail: Tail::default(),
            turns: RunningTurns::default(),
            changed: 0,
            open: Vec::new(),
            closed: false,
        };
        let shared = Arc::new(Shared {
            daemon,
            run: format!("{:016x}", rand::random::<u64>()),
            hub: Mutex::new(hub),
            writers: TaskTracker::new(),
            closing: CancellationToken::new(),
        });

        shared.writers.spawn(pump(Arc::clone(&shared)));
        Self(shared)
    }

    /// A stream from now on, in one step with its first frames, so no
    /// event lands between: `resumed` and exactly the frames after the
    /// id the client last applied, when the tail still holds them; else
    /// `ready`. A connector's stream counts it present from before its
    /// first frame until the stream ends. `link` closes its connection
    /// when the client stops taking what it is sent.
    pub(crate) async fn open(
        &self,
        last_event_id: Option<&str>,
        connector: Option<&Connector>,
        link: CancellationToken,
    ) -> Result<Response, Unopened> {
        let shared = &self.0;
        let presence = {
            let hub = shared.hub();

            if hub.closed {
                return Err(Unopened::Stopping);
            }

            let presence = connector.map(|connector| shared.daemon.connector_present(connector));

            if let Some(missed) = last_event_id.and_then(|id| hub.tail.after(&shared.run, id)) {
                let first = std::iter::once(Bytes::from_static(RESUMED))
                    .chain(missed)
                    .collect();

                return Ok(self.join(hub, first, presence, link));
            }

            presence
        };
        let (ready, hub) = self.ready().await?;

        Ok(self.join(hub, vec![ready], presence, link))
    }

    /// The stream that goes on from `first` with every frame `hub` numbers
    /// after them, joined in the step that holds it.
    fn join(
        &self,
        mut hub: MutexGuard<'_, Hub>,
        first: Vec<Bytes>,
        presence: Option<Presence>,
        link: CancellationToken,
    ) -> Response {
        let shared = &self.0;
        let (queue, queued) = mpsc::unbounded_channel();
        let (body, taken) = mpsc::channel(1);
        let durations = shared.daemon.durations();

        for frame in first {
            // The receiver is right here.
            let _ = queue.send(frame);
        }

        hub.open.push(queue);
        // Before the hub is let go, so a close that comes next waits for it.
        shared.writers.spawn(write(
            queued,
            body,
            Waits {
                heartbeat: durations.heartbeat,
                grace: durations.grace,
            },
            link,
            presence,
        ));
        drop(hub);

        (
            [(CONTENT_TYPE, "text/event-stream")],
            Body::new(Frames(taken)),
        )
            .into_response()
    }

    /// The `ready` frame of a stream that opens now, with the hub held
    /// from the step that numbered it, so the stream goes on from that
    /// frame: the daemon's health and the confirmations and pairings
    /// waiting, read with the hub let go and read again while anything
    /// they show changed under the read, so they hold exactly what the
    /// frames before it told, and the turns running with their drafts as
    /// of that frame.
    async fn ready(&self) -> Result<(Bytes, MutexGuard<'_, Hub>), Unopened> {
        let shared = &self.0;

        loop {
            let read_after = {
                let mut hub = shared.hub();

                hub.catch_up(&shared.run);
                hub.tail.latest
            };
            let health = shared.daemon.health().await;
            let confirmations = shared.daemon.pending_confirmations();
            let pairings = shared.daemon.pending_pairings();
            let mut hub = shared.hub();

            if hub.closed {
                return Err(Unopened::Stopping);
            }

            hub.catch_up(&shared.run);

            if hub.changed <= read_after {
                let ready = Ready {
                    protocol_version: PROTOCOL_VERSION,
                    health,
                    confirmations,
                    pairings,
                    turns: hub.turns.turns(),
                };
                let id = format!("{}-{}", shared.run, hub.tail.latest);
                let data = serde_json::to_string(&ready).map_err(Unopened::Unformatted)?;

                return Ok((frame(Some(&id), "ready", &data), hub));
            }
        }
    }

    /// Ends every stream once everything announced before the close is
    /// handed to it and the frames queued for it are written, a client
    /// that does not take one within the grace dropped on the way, and
    /// refuses every stream asked for after; answered once every stream
    /// ended.
    pub(crate) async fn close(&self) {
        self.0.closing.cancel();
        self.0.writers.close();
        self.0.writers.wait().await;
    }
}

impl fmt::Debug for Streams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Streams")
            .field("run", &self.0.run)
            .finish_non_exhaustive()
    }
}

impl Shared {
    fn hub(&self) -> MutexGuard<'_, Hub> {
        self.hub.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Takes every event as it is announced into the streams, until the close:
/// then what was announced before it is numbered and handed out, and the
/// streams end.
async fn pump(shared: Arc<Shared>) {
    loop {
        let framed = std::future::poll_fn(|context| shared.hub().frame_next(&shared.run, context));

        tokio::select! {
            biased;
            () = shared.closing.cancelled() => break,
            more = framed => if !more {
                break;
            },
        }
    }

    let mut hub = shared.hub();

    hub.catch_up(&shared.run);
    hub.closed = true;
    hub.open.clear();
}

impl Hub {
    /// Frames the next event once one is announced; false once none can
    /// be.
    fn frame_next(&mut self, run: &str, context: &mut Context<'_>) -> Poll<bool> {
        self.events.poll_recv(context).map(|event| {
            event.is_some_and(|event| {
                self.publish(run, &event);
                true
            })
        })
    }

    /// Frames every event announced so far.
    fn catch_up(&mut self, run: &str) {
        while let Ok(event) = self.events.try_recv() {
            self.publish(run, &event);
        }
    }

    fn publish(&mut self, run: &str, event: &Event) {
        self.turns.fold(event);
        self.tail.latest += 1;

        if !matches!(
            event,
            Event::TurnProgress { .. } | Event::TurnCompleted { .. }
        ) {
            self.changed = self.tail.latest;
        }

        if let Ok(frame) = numbered(run, self.tail.latest, event) {
            self.tail.keep(self.tail.latest, frame.clone());
            self.open
                .retain(|stream| stream.send(frame.clone()).is_ok());
        } else {
            // An event its own type cannot spell has no frame, and no
            // stream may go on as if it had none: each ends, and none
            // resumes across the number it took.
            self.tail.forget();
            self.open.clear();
        }
    }
}

impl Tail {
    fn keep(&mut self, number: u64, frame: Bytes) {
        self.bytes += frame.len();
        self.frames.push_back((number, frame));

        while self.bytes > TAIL_BYTES {
            let Some((_, oldest)) = self.frames.pop_front() else {
                break;
            };

            self.bytes -= oldest.len();
        }
    }

    fn forget(&mut self) {
        self.frames.clear();
        self.bytes = 0;
    }

    /// The frames after the one `last_event_id` names, oldest first, and
    /// an empty list when it names the newest; nothing when it is of
    /// another run, names a frame the tail let go or one it never held, or
    /// is no frame's id.
    fn after(&self, run: &str, last_event_id: &str) -> Option<Vec<Bytes>> {
        let (of, number) = last_event_id.split_once('-')?;

        if of != run
            || !(1..=15).contains(&number.len())
            || !number.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }

        let number: u64 = number.parse().ok()?;
        let oldest = self
            .frames
            .front()
            .map_or(self.latest + 1, |(oldest, _)| *oldest);

        if number + 1 < oldest || number > self.latest {
            return None;
        }

        Some(
            self.frames
                .iter()
                .filter(|(kept, _)| *kept > number)
                .map(|(_, frame)| frame.clone())
                .collect(),
        )
    }
}

/// `event` as the frame numbered `number` of `run`: its kind as the event's
/// name and the event as one line of JSON, which never holds a raw line
/// break.
fn numbered(run: &str, number: u64, event: &Event) -> Result<Bytes, serde_json::Error> {
    let event = serde_json::to_value(event)?;
    let kind = event
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();

    Ok(frame(
        Some(&format!("{run}-{number}")),
        kind,
        &event.to_string(),
    ))
}

fn frame(id: Option<&str>, event: &str, data: &str) -> Bytes {
    let id = id.map_or_else(String::new, |id| format!("id: {id}\n"));

    Bytes::from(format!("{id}event: {event}\ndata: {data}\n\n"))
}

#[derive(Clone, Copy)]
struct Waits {
    heartbeat: Duration,
    grace: Duration,
}

/// Writes a stream's frames in order, each once the one before it was
/// taken, and a ping whenever it has been idle a heartbeat; the stream
/// ends once its queue is closed and every frame of it written. A client
/// that has not taken a frame within the grace is not slow, it is gone:
/// its connection is closed and nothing more is queued for it, however
/// long its queue, which says nothing about the client, since a reply
/// spoken in one breath queues hundreds.
async fn write(
    mut queued: mpsc::UnboundedReceiver<Bytes>,
    body: mpsc::Sender<Bytes>,
    waits: Waits,
    link: CancellationToken,
    _presence: Option<Presence>,
) {
    loop {
        let frame = tokio::select! {
            biased;
            () = body.closed() => return,
            frame = queued.recv() => match frame {
                Some(frame) => frame,
                None => return,
            },
            () = tokio::time::sleep(waits.heartbeat) => Bytes::from_static(PING),
        };

        match tokio::time::timeout(waits.grace, taken(&body, frame)).await {
            Ok(true) => {}
            Ok(false) => return,
            Err(_) => {
                link.cancel();
                return;
            }
        }
    }
}

/// Hands `frame` to the response and answers once the response took it;
/// false once the response is gone.
async fn taken(body: &mpsc::Sender<Bytes>, frame: Bytes) -> bool {
    let Ok(slot) = body.reserve().await else {
        return false;
    };

    slot.send(frame);
    // The one slot is free again once the response took the frame.
    body.reserve().await.is_ok()
}

/// A stream's response body: the frames its writer hands it, one at a time.
struct Frames(mpsc::Receiver<Bytes>);

impl hyper::body::Body for Frames {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.0
            .poll_recv(context)
            .map(|frame| frame.map(|bytes| Ok(Frame::data(bytes))))
    }
}
