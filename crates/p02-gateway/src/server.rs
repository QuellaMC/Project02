//! The daemon's socket: a loopback port, every connection on it, and the
//! stop in the order that loses nothing.

use std::future::Future;
use std::io;
use std::net::Ipv4Addr;
use std::num::NonZeroU16;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper_util::rt::TokioIo;
use p02_app::Daemon;
use p02_shared::DaemonToken;
use socket2::SockRef;
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tower_service::Service as _;

use crate::events::Streams;
use crate::http::{self, App, Link};

/// How long accepting waits before it tries again when the system has no
/// room for another connection.
const ACCEPT_RETRY: Duration = Duration::from_secs(1);

/// How much of what a connection writes the system holds for a client
/// that has not read it. Bounded, so that a client that stopped reading
/// stalls its writer within this much on every system, where the grace
/// meets it: left to itself, Windows grows a socket's send buffer as the
/// writer asks and Linux grows it to megabytes, and a stream's grace would
/// meet the stall only after all of that.
const SEND_BUFFER: usize = 64 * 1024;

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
    /// request presents: on `port`, the port the home's record held, or on
    /// a free port when that one is taken by another program or there is
    /// none.
    ///
    /// # Errors
    ///
    /// [`BindServerError`] when no loopback port can be bound.
    pub async fn bind(
        daemon: Daemon,
        token: &DaemonToken,
        port: Option<NonZeroU16>,
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
        ));
        let server = Self {
            port,
            grace: daemon.durations().grace,
            daemon,
            streams,
            stopping,
            signals: Signals::default(),
            connections: TaskTracker::new(),
        };

        server.connections.spawn(accept(
            listener,
            router,
            server.signals.clone(),
            server.connections.clone(),
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
    /// frames queued for it are written; then the listener closes, each
    /// connection gets the grace to finish the exchange it holds, and
    /// whatever remains is cut.
    pub fn close(self) -> impl Future<Output = ()> + Send + 'static {
        self.stopping.cancel();

        async move {
            self.daemon.stop().await;
            self.streams.close().await;
            self.signals.draining.cancel();
            self.signals.closing.cancel();
            self.connections.close();

            // A client that has not finished its exchange by then is gone.
            let _ = tokio::time::timeout(self.grace, self.connections.wait()).await;

            self.signals.cut.cancel();
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
async fn accept(listener: TcpListener, router: Router, signals: Signals, connections: TaskTracker) {
    loop {
        let accepted = tokio::select! {
            () = signals.closing.cancelled() => return,
            accepted = listener.accept() => accepted,
        };

        match accepted {
            Ok((stream, _)) => {
                bound(&stream);
                connections.spawn(serve(stream, router.clone(), signals.clone()));
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

/// Bounds what the system holds of `stream`'s writes unread. A stream the
/// system will not bound keeps the system's own buffer, and a client of it
/// that stopped reading is seen that much later.
fn bound(stream: &TcpStream) {
    let _ = SockRef::from(stream).set_send_buffer_size(SEND_BUFFER);
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
async fn serve(stream: TcpStream, router: Router, signals: Signals) {
    let link = CancellationToken::new();
    let service = {
        let link = link.clone();

        hyper::service::service_fn(move |request: hyper::Request<Incoming>| {
            let mut request = request.map(Body::new);

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
