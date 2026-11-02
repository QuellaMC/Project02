//! The one wait for a stop, which every command that runs until stopped
//! listens with.

use std::io;

use tokio_util::sync::CancellationToken;

/// The stop a person or a service manager asks for: the first SIGINT,
/// SIGTERM or SIGHUP, or on Windows the first of the console's events. A
/// second of any kind ends the process at once, exit code 1, with nothing
/// more of the stop: the way out when stopping hangs, which a serve leaves
/// as a crash does, the lease to the kernel and the record naming its run.
///
/// # Errors
///
/// [`io::Error`] when the process cannot register for its signals.
pub fn listen_for_stop() -> io::Result<CancellationToken> {
    let stop = CancellationToken::new();
    let mut signals = Signals::new()?;

    tokio::spawn({
        let stop = stop.clone();

        async move {
            if signals.next().await {
                stop.cancel();

                if signals.next().await {
                    std::process::exit(1);
                }
            }
        }
    });
    Ok(stop)
}

#[cfg(unix)]
struct Signals {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
    hangup: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl Signals {
    fn new() -> io::Result<Self> {
        use tokio::signal::unix::{SignalKind, signal};

        Ok(Self {
            interrupt: signal(SignalKind::interrupt())?,
            terminate: signal(SignalKind::terminate())?,
            hangup: signal(SignalKind::hangup())?,
        })
    }

    /// Answered at the next signal; false once none can come.
    async fn next(&mut self) -> bool {
        tokio::select! {
            Some(()) = self.interrupt.recv() => true,
            Some(()) = self.terminate.recv() => true,
            Some(()) = self.hangup.recv() => true,
            else => false,
        }
    }
}

/// A closed console arrives as its close event, followed by the system's
/// kill a few seconds later.
#[cfg(windows)]
struct Signals {
    interrupt: tokio::signal::windows::CtrlC,
    interrupt_hard: tokio::signal::windows::CtrlBreak,
    close: tokio::signal::windows::CtrlClose,
    logoff: tokio::signal::windows::CtrlLogoff,
    shutdown: tokio::signal::windows::CtrlShutdown,
}

#[cfg(windows)]
impl Signals {
    fn new() -> io::Result<Self> {
        use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close, ctrl_logoff, ctrl_shutdown};

        Ok(Self {
            interrupt: ctrl_c()?,
            interrupt_hard: ctrl_break()?,
            close: ctrl_close()?,
            logoff: ctrl_logoff()?,
            shutdown: ctrl_shutdown()?,
        })
    }

    /// Answered at the next event; false once none can come.
    async fn next(&mut self) -> bool {
        tokio::select! {
            Some(()) = self.interrupt.recv() => true,
            Some(()) = self.interrupt_hard.recv() => true,
            Some(()) = self.close.recv() => true,
            Some(()) = self.logoff.recv() => true,
            Some(()) = self.shutdown.recv() => true,
            else => false,
        }
    }
}
