//! The daemon and the connector, each on a thread of its own in this
//! process, and the one order that stops them.

use std::convert::Infallible;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;

use p02_telegram::Options;
use project02::{ServeFlags, Switches};
use tokio_util::sync::CancellationToken;

use crate::lines::{Log, daemon_console};

/// The daemon's log, in the logs folder.
pub const DAEMON_LOG: &str = "daemon.log";

/// The connector's log, beside the daemon's.
pub const CONNECTOR_LOG: &str = "telegram.log";

/// How long the connector is given once its stop is cancelled. It drops
/// every call in flight, so it ends at once; one that hangs must not keep
/// the daemon from its own stop.
pub const CONNECTOR_GRACE: Duration = Duration::from_secs(5);

/// How long the daemon is given once its stop is cancelled, to finish what
/// is in flight. A reply being written commits within seconds; a turn
/// parked on a confirmation can wait minutes, which nobody quitting an app
/// will, and the process's end is the crash the runtime recovers from.
pub const DAEMON_GRACE: Duration = Duration::from_secs(20);

/// The daemon and the connector, until [`Running::stop`].
#[derive(Debug)]
pub struct Running {
    daemon: Service,
    connector: Service,
}

/// One of the two on its thread: the stop it listens for, and a channel
/// that disconnects when the thread ends, however it ends.
#[derive(Debug)]
struct Service {
    stop: CancellationToken,
    ended: Receiver<Infallible>,
}

/// Starts the daemon on `home`, making a store there as `serve --init`
/// does, the person having consented by installing, and the connector
/// beside it, which finds the daemon by the home's record; their lines go
/// to [`DAEMON_LOG`] and [`CONNECTOR_LOG`] in `logs`. Answers the two
/// running, and the address the daemon says, its own or that of the daemon
/// already holding the home, on a channel that disconnects without one when
/// the daemon ends before it serves.
///
/// # Errors
///
/// The `io::Error` a thread or the connector's runtime could not be made
/// with; a daemon already started is stopped before the error is answered.
pub fn start(home: PathBuf, logs: &Path) -> io::Result<(Running, Receiver<String>)> {
    let daemon_log = Log::begin(logs.join(DAEMON_LOG));
    let connector_log = Log::begin(logs.join(CONNECTOR_LOG));
    let (said, address) = mpsc::channel();
    let flags = ServeFlags {
        store: Some(home.clone()),
        init: true,
    };
    let daemon = Service::spawn("daemon", move |stop| {
        let mut console = daemon_console(daemon_log, said);

        project02::serve(flags, Switches::default(), &mut console, || Ok(stop));
    })?;
    let connector = match connector(home, connector_log) {
        Ok(connector) => connector,
        Err(error) => {
            daemon.stop_within(DAEMON_GRACE);
            return Err(error);
        }
    };

    Ok((Running { daemon, connector }, address))
}

impl Running {
    /// Stops the two in the order that loses nothing: the connector first,
    /// while the daemon still answers it, then the daemon, each given its
    /// grace. One past its grace is left to the process's end.
    pub fn stop(self) {
        self.connector.stop_within(CONNECTOR_GRACE);
        self.daemon.stop_within(DAEMON_GRACE);
    }
}

impl Service {
    /// Runs `work` on a thread named `name`, with the stop it listens for.
    fn spawn(
        name: &str,
        work: impl FnOnce(CancellationToken) + Send + 'static,
    ) -> io::Result<Self> {
        let stop = CancellationToken::new();
        let listening = stop.clone();
        let (ending, ended) = mpsc::channel();

        thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || {
                work(listening);
                drop(ending);
            })?;

        Ok(Self { stop, ended })
    }

    fn stop_within(self, grace: Duration) {
        self.stop.cancel();

        let _ = self.ended.recv_timeout(grace);
    }
}

/// The connector of `home`, its lines in `log`, on a thread and a runtime
/// of its own until its stop.
fn connector(home: PathBuf, log: Log) -> io::Result<Service> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    Service::spawn("telegram", move |stop| {
        runtime.block_on(p02_telegram::run(Options::new(home), Arc::new(log), stop));
        // What still runs on its blocking pool, such as a name lookup, is
        // nothing the stop waits for.
        runtime.shutdown_background();
    })
}
