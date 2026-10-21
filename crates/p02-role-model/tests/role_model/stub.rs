//! A model server on the loopback interface for the NVIDIA adapter to
//! call: it answers each request with the next answer the test scripted,
//! and keeps every request it read.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::serve::Listener;
use p02_shared::BaseUrl;
use serde_json::Value;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};

use crate::support::event_text;

/// A request as the stub read it.
#[derive(Clone, Debug)]
pub(crate) struct Request {
    pub(crate) path: String,
    pub(crate) headers: HeaderMap,
    pub(crate) body: Bytes,
}

impl Request {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    pub(crate) fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

/// How the stub answers one request.
pub(crate) enum Answer {
    /// A whole body under a status.
    Whole { status: u16, body: String },
    /// A 200 event stream whose headers go after `delay`, and whose pieces
    /// go as the test sends them, until it lets go of the sender.
    Stream {
        delay: Duration,
        pieces: mpsc::UnboundedReceiver<String>,
    },
    /// Nothing, until the test lets go of the sender.
    Hold(oneshot::Receiver<()>),
}

impl Answer {
    /// A 200 event stream of `frames`, each a `data:` line.
    pub(crate) fn events(frames: &[String]) -> Self {
        Self::Whole {
            status: 200,
            body: frames.iter().map(|frame| event_text(frame)).collect(),
        }
    }
}

#[derive(Default)]
struct Shared {
    answers: Mutex<VecDeque<Answer>>,
    requests: Mutex<Vec<Request>>,
    connections_to_drop: AtomicUsize,
}

pub(crate) struct Stub {
    address: SocketAddr,
    shared: Arc<Shared>,
}

impl Stub {
    pub(crate) async fn start() -> Self {
        let shared = Arc::new(Shared::default());
        let listener = Dropping {
            listener: TcpListener::bind("127.0.0.1:0").await.unwrap(),
            shared: Arc::clone(&shared),
        };
        let address = Listener::local_addr(&listener).unwrap();
        let app = Router::new()
            .fallback(respond)
            .with_state(Arc::clone(&shared));

        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        Self { address, shared }
    }

    pub(crate) fn base_url(&self) -> BaseUrl {
        BaseUrl::parse(&format!("http://{}/v1", self.address)).unwrap()
    }

    /// The next request gets `answer`, after those scripted before it.
    pub(crate) fn answer(&self, answer: Answer) {
        self.shared.answers.lock().unwrap().push_back(answer);
    }

    /// The next request is answered piece by piece through the sender.
    pub(crate) fn stream(&self, delay: Duration) -> mpsc::UnboundedSender<String> {
        let (sender, pieces) = mpsc::unbounded_channel();

        self.answer(Answer::Stream { delay, pieces });
        sender
    }

    /// The next request is answered never, while the sender lives.
    pub(crate) fn hold(&self) -> oneshot::Sender<()> {
        let (release, held) = oneshot::channel();

        self.answer(Answer::Hold(held));
        release
    }

    /// The next connection is closed as soon as it is made.
    pub(crate) fn drop_next_connection(&self) {
        self.shared
            .connections_to_drop
            .fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn connections_still_to_drop(&self) -> usize {
        self.shared.connections_to_drop.load(Ordering::SeqCst)
    }

    pub(crate) fn requests(&self) -> Vec<Request> {
        self.shared.requests.lock().unwrap().clone()
    }
}

/// The stub's listener, which closes the connections the test asked it to
/// drop before a request on them is read.
struct Dropping {
    listener: TcpListener,
    shared: Arc<Shared>,
}

impl Listener for Dropping {
    type Io = TcpStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (TcpStream, SocketAddr) {
        loop {
            let accepted = Listener::accept(&mut self.listener).await;
            let dropped = self
                .shared
                .connections_to_drop
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                    left.checked_sub(1)
                })
                .is_ok();

            if !dropped {
                return accepted;
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        Listener::local_addr(&self.listener)
    }
}

async fn respond(
    State(shared): State<Arc<Shared>>,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    shared.requests.lock().unwrap().push(Request {
        path: uri.path().to_owned(),
        headers,
        body,
    });

    let answer = shared.answers.lock().unwrap().pop_front();

    match answer {
        None => (StatusCode::INTERNAL_SERVER_ERROR, "unscripted").into_response(),
        Some(Answer::Whole { status, body }) => {
            (StatusCode::from_u16(status).unwrap(), body).into_response()
        }
        Some(Answer::Stream { delay, pieces }) => {
            tokio::time::sleep(delay).await;

            let stream = futures_util::stream::unfold(pieces, |mut pieces| async move {
                pieces
                    .recv()
                    .await
                    .map(|piece| (Ok::<_, Infallible>(piece), pieces))
            });

            (
                [(header::CONTENT_TYPE, "text/event-stream")],
                Body::from_stream(stream),
            )
                .into_response()
        }
        Some(Answer::Hold(held)) => {
            let _ = held.await;

            (StatusCode::SERVICE_UNAVAILABLE, "released").into_response()
        }
    }
}
