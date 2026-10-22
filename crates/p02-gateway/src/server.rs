//! The daemon's socket: a loopback port, every connection on it, and the
//! stop in the order that loses nothing.

use std::future::Future;
use std::io;
use std::net::Ipv4Addr;
use std::num::NonZeroU16;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use hyper::body::{Frame, Incoming, SizeHint};
use hyper::server::conn::http1;
use hyper_util::rt::TokioIo;
use p02_app::Daemon;
use p02_shared::DaemonToken;
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tokio_util::task::task_tracker::TaskTrackerToken;
use tower_service::Service as _;

use crate::events::Streams;
use crate::http::{self, App, Link};
use crate::page::Page;

/// How long accepting waits before it tries again when the system has no
/// room for another connection.
const ACCEPT_RETRY: Duration = Duration::from_secs(1);

/// The daemon behind HTTP and its event stream, on a loopback port.
#[derive(Debug)]
#[must_use = "a server serves until it is closed"]
pub struct Server {
    port: NonZeroU16,
    daemon: Daemon,
    streams: Streams,
    grace: Duration,
    stopping: CancellationToken,
    signals: Signals,
    connections: TaskTracker,
    /// The connections whose request has fully arrived, each until it ends:
    /// the answers a stop gives the grace to finish.
    answering: TaskTracker,
}

/// What a connection hears of the stop.
#[derive(Clone, Debug, Default)]
struct Signals {
    /// The stop reached the connections: each finishes the exchange it
    /// holds and closes.
    draining: CancellationToken,
    /// The listener closes.
    closing: CancellationToken,
    /// Whatever remains is cut.
    cut: CancellationToken,
}

/// Why no loopback port could be bound.
#[derive(Debug, thiserror::Error)]
#[error("could not bind a loopback port")]
pub struct BindServerError {
    #[source]
    source: io::Error,
}

impl Server {
    /// Serves `daemon` on `127.0.0.1`, with `token` the bearer every API
    /// request presents and `page` the page at the root: on `port`, the
    /// port the home's record held, or on a free port when that one is
    /// taken by another program or there is none.
    ///
    /// # Errors
    ///
    /// [`BindServerError`] when no loopback port can be bound.
    pub async fn bind(
        daemon: Daemon,
        token: &DaemonToken,
        port: Option<NonZeroU16>,
        page: Page,
    ) -> Result<Self, BindServerError> {
        let listener = listen(port)
            .await
            .map_err(|source| BindServerError { source })?;
        let port = listener
            .local_addr()
            .and_then(|address| {
                NonZeroU16::new(address.port())
                    .ok_or_else(|| io::Error::other("the system bound port 0"))
            })
            .map_err(|source| BindServerError { source })?;
        let streams = Streams::new(daemon.clone());
        let stopping = CancellationToken::new();
        let router = http::router(App::new(
            daemon.clone(),
            token,
            stopping.clone(),
            streams.clone(),
            page,
        ));
        let server = Self {
            port,
            grace: daemon.durations().grace,
            daemon,
            streams,
            stopping,
            signals: Signals::default(),
            connections: TaskTracker::new(),
            answering: TaskTracker::new(),
        };

        server.connections.spawn(accept(
            listener,
            router,
            server.signals.clone(),
            server.connections.clone(),
            server.answering.clone(),
        ));
        Ok(server)
    }

    /// The port it listens on.
    #[must_use]
    pub fn port(&self) -> NonZeroU16 {
        self.port
    }

    /// Stops in the order that loses nothing. From the call on, new API
    /// requests answer 503; the daemon stops, its turns draining with the
    /// socket and the streams open, so an accepted turn still receives its
    /// answer and the stream its reply; then each stream ends once the
    /// frames queued for it are written; an answer still being written
    /// gets the grace to finish, while a request that never fully arrived
    /// is waited for not at all; and only then does the listener close and
    /// whatever remains is cut.
    pub fn close(self) -> impl Future<Output = ()> + Send + 'static {
        self.stopping.cancel();

        async move {
            self.daemon.stop().await;
            self.streams.close().await;
            self.signals.draining.cancel();
            self.answering.close();

            // A client that has not taken its answer by then is gone.
            let _ = tokio::time::timeout(self.grace, self.answering.wait()).await;

            self.signals.closing.cancel();
            self.signals.cut.cancel();
            self.connections.close();
            self.connections.wait().await;
        }
    }
}

/// The loopback port `port`, or a free one when that is taken or there is
/// none.
async fn listen(port: Option<NonZeroU16>) -> io::Result<TcpListener> {
    if let Some(port) = port {
        match TcpListener::bind((Ipv4Addr::LOCALHOST, port.get())).await {
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => {}
            bound => return bound,
        }
    }

    TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await
}

/// Takes every connection until the listener closes.
async fn accept(
    listener: TcpListener,
    router: Router,
    signals: Signals,
    connections: TaskTracker,
    answering: TaskTracker,
) {
    loop {
        let accepted = tokio::select! {
            () = signals.closing.cancelled() => return,
            accepted = listener.accept() => accepted,
        };

        match accepted {
            Ok((stream, _)) => {
                connections.spawn(serve(
                    stream,
                    router.clone(),
                    signals.clone(),
                    answering.clone(),
                ));
            }
            // A connection that broke while it was accepted is its
            // client's to make again.
            Err(error) if failed_connection(&error) => {}
            // The system has no room for another, until one closes.
            Err(_) => {
                tokio::select! {
                    () = signals.closing.cancelled() => return,
                    () = tokio::time::sleep(ACCEPT_RETRY) => {}
                }
            }
        }
    }
}

fn failed_connection(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
    )
}

/// Serves one connection, one exchange at a time, until its client leaves,
/// its stream closes it, or the stop cuts it. Once the stop reaches the
/// connections, each finishes the exchange it holds and closes, and one
/// that came after serves one exchange.
async fn serve(stream: TcpStream, router: Router, signals: Signals, answering: TaskTracker) {
    let exchange = Arc::new(Exchange {
        answering,
        token: Mutex::new(None),
    });
    let link = CancellationToken::new();
    let service = {
        let (exchange, link) = (Arc::clone(&exchange), link.clone());

        hyper::service::service_fn(move |request: hyper::Request<Incoming>| {
            exchange.began();

            let mut request = request.map(|body| Body::new(Watched::new(body, &exchange)));

            request.extensions_mut().insert(Link(link.clone()));
            router.clone().call(request)
        })
    };
    let mut told = signals.draining.is_cancelled();
    let connection = http1::Builder::new()
        .keep_alive(!told)
        .serve_connection(TokioIo::new(stream), service);
    let mut connection = std::pin::pin!(connection);

    loop {
        tokio::select! {
            biased;
            () = link.cancelled() => return,
            () = signals.cut.cancelled() => return,
            _ = connection.as_mut() => return,
            () = signals.draining.cancelled(), if !told => {
                connection.as_mut().graceful_shutdown();
                told = true;
            }
        }
    }
}

/// Whether the request a connection holds has fully arrived: from then on
/// an answer to it may be on its way, which a stop waits for, and the
/// connection counts among those answering until its next request begins
/// or it ends.
#[derive(Debug)]
struct Exchange {
    answering: TaskTracker,
    token: Mutex<Option<TaskTrackerToken>>,
}

impl Exchange {
    fn began(&self) {
        *self.token() = None;
    }

    fn arrived(&self) {
        self.token().get_or_insert_with(|| self.answering.token());
    }

    fn token(&self) -> MutexGuard<'_, Option<TaskTrackerToken>> {
        self.token.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A request's body, which marks its exchange arrived once it has been
/// read to its end, or at once when it has none.
struct Watched {
    body: Incoming,
    exchange: Arc<Exchange>,
}

impl Watched {
    fn new(body: Incoming, exchange: &Arc<Exchange>) -> Self {
        if hyper::body::Body::is_end_stream(&body) {
            exchange.arrived();
        }

        Self {
            body,
            exchange: Arc::clone(exchange),
        }
    }
}

impl hyper::body::Body for Watched {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, hyper::Error>>> {
        let polled = Pin::new(&mut self.body).poll_frame(context);

        if matches!(polled, Poll::Ready(None)) {
            self.exchange.arrived();
        }

        polled
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}
