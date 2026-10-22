//! The daemon and the connector, each on a thread and a runtime of its own
//! in this process, and the stop order that ends them.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;

use p02_telegram::Options;
use project02::{ServeFlags, Switches};
use tokio_util::sync::CancellationToken;

use crate::lines::{self, Log};

/// The daemon's log, under the logs folder; the connector's is beside it.
pub(crate) const DAEMON_LOG: &str = "daemon.log";

/// How long Quit waits for the connector, so its last edits reach their
/// chats.
const CONNECTOR_GRACE: Duration = Duration::from_secs(5);

/// How long Quit waits for the daemon. A reply mid-stream commits within
/// seconds; a turn parked on a confirmation can wait minutes, which nobody
/// quitting an app will, and an end past the grace is the crash the
/// runtime recovers from.
const DAEMON_GRACE: Duration = Duration::from_secs(20);

/// The two, running.
#[derive(Debug)]
pub(crate) struct Running {
    daemon: Ending,
    connector: Ending,
}

/// One of the two: the stop it listens for, and a channel that disconnects
/// when its thread ends.
#[derive(Debug)]
struct Ending {
    stop: CancellationToken,
    ended: Receiver<()>,
}

/// Starts the daemon on `home`, consenting to make a store there, and the
/// connector beside it, which waits for the daemon by the home's record;
/// their lines go to [`DAEMON_LOG`] and `telegram.log` under `logs`. Answers
/// them running, and the address the window opens on, whose channel
/// disconnects without one when the daemon ends before it serves.
pub(crate) fn start(home: PathBuf, logs: &Path) -> io::Result<(Running, Receiver<String>)> {
    let daemon_log = Log::begin(logs.join(DAEMON_LOG))?;
    let connector_log = Log::begin(logs.join("telegram.log"))?;
    let (said, address) = mpsc::channel();
    let flags = ServeFlags {
        store: Some(home.clone()),
        init: true,
    };
    let daemon = spawn("daemon", move |stop| {
        let mut console = lines::daemon_console(&daemon_log, said);

        project02::serve(flags, Switches::default(), &mut console, move || Ok(stop));
    })?;
    let connector = match spawn("telegram", move |stop| connect(home, &connector_log, stop)) {
        Ok(connector) => connector,
        Err(error) => {
            daemon.stop_within(DAEMON_GRACE);
            return Err(error);
        }
    };

    Ok((Running { daemon, connector }, address))
}

impl Running {
    /// Stops in the order that loses nothing: the connector first, while
    /// the daemon still answers it, then the daemon, each given its grace.
    /// One that outstays it is left to the process's end.
    pub(crate) fn stop(self) {
        self.connector.stop_within(CONNECTOR_GRACE);
        self.daemon.stop_within(DAEMON_GRACE);
    }
}

impl Ending {
    fn stop_within(self, grace: Duration) {
        self.stop.cancel();

        // Disconnected when it ended in time; a timeout leaves it be.
        let _ = self.ended.recv_timeout(grace);
    }
}

/// Runs `work` on a thread named `name` until it returns, with the stop it
/// listens for.
fn spawn(name: &str, work: impl FnOnce(CancellationToken) + Send + 'static) -> io::Result<Ending> {
    let stop = CancellationToken::new();
    let (ending, ended) = mpsc::channel();
    let listening = stop.clone();

    thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || {
            work(listening);
            drop(ending);
        })?;

    Ok(Ending { stop, ended })
}

/// The connector of `home`, on a runtime of its own until the stop; what
/// ends it is in its log.
fn connect(home: PathBuf, log: &Log, stop: CancellationToken) {
    match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => {
            runtime.block_on(p02_telegram::run(
                Options::new(home),
                Arc::new(log.clone()),
                stop,
            ));
        }
        Err(error) => log.line(&format!("Error: {error}")),
    }
}
