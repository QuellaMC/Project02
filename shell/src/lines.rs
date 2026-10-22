//! What the daemon and the connector would have printed on a terminal:
//! each in a log file of its own, made anew at each start, and the one line
//! the window opens on.

use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, PoisonError};

use p02_shared::{append_line, remove_file};
use project02::{ADDRESS_PREFIX, Console};

/// A log file that whole lines are added to, one at a time, from any
/// thread.
#[derive(Clone, Debug)]
pub(crate) struct Log {
    path: PathBuf,
    appending: Arc<Mutex<()>>,
}

impl Log {
    /// The log at `path`, begun anew: it tells of the run it was made for.
    pub(crate) fn begin(path: PathBuf) -> io::Result<Self> {
        match remove_file(&path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }

        Ok(Self {
            path,
            appending: Arc::new(Mutex::new(())),
        })
    }

    pub(crate) fn line(&self, line: &str) {
        let _appending = self
            .appending
            .lock()
            .unwrap_or_else(PoisonError::into_inner);

        // A log that cannot be written stops nothing.
        let _ = append_line(&self.path, line.as_bytes());
    }
}

impl p02_telegram::Lines for Log {
    fn say(&self, line: &str) {
        self.line(line);
    }

    fn report(&self, line: &str) {
        self.line(line);
    }
}

/// The daemon's console: both its streams into `log`, and the address
/// its first address line names sent to `address`.
pub(crate) fn daemon_console(log: &Log, address: Sender<String>) -> Console {
    Console::new(
        LogStream::new(log.clone(), Some(address)),
        LogStream::new(log.clone(), None),
    )
}

/// A stream cut into lines, each added to the log as it ends.
struct LogStream {
    log: Log,
    pending: Vec<u8>,
    address: Option<Sender<String>>,
}

impl LogStream {
    fn new(log: Log, address: Option<Sender<String>>) -> Self {
        Self {
            log,
            pending: Vec::new(),
            address,
        }
    }
}

impl Write for LogStream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.pending.extend_from_slice(bytes);

        while let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line[..end]);

            self.log.line(&line);

            if let Some(url) = line.strip_prefix(ADDRESS_PREFIX)
                && let Some(address) = self.address.take()
            {
                // The shell may have quit before the daemon served.
                let _ = address.send(url.to_owned());
            }
        }

        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
