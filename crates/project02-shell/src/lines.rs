//! What the daemon and the connector would have printed on a terminal, each
//! in a log of its own begun anew at each start, and the one line the
//! window opens on.

use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, PoisonError};

use p02_shared::{append_line, create_directories, remove_file};
use p02_telegram::Lines;
use project02::{ADDRESS_PREFIX, Console};

/// A log file whole lines are added to, one at a time, from any thread.
#[derive(Clone, Debug)]
pub(crate) struct Log {
    /// The file, held while a line is added to it.
    file: Arc<Mutex<PathBuf>>,
}

impl Log {
    /// The log at `path`, begun anew for this run, its folder made when it
    /// is not there yet. A log that cannot be begun or written stops
    /// nothing: its lines follow the last run's, or are lost.
    #[must_use]
    pub(crate) fn begin(path: PathBuf) -> Self {
        if let Some(folder) = path.parent() {
            let _ = create_directories(folder);
        }

        let _ = remove_file(&path);

        Self {
            file: Arc::new(Mutex::new(path)),
        }
    }

    fn add(&self, line: &str) {
        let path = self.file.lock().unwrap_or_else(PoisonError::into_inner);
        let _ = append_line(&path, line.as_bytes());
    }
}

impl Lines for Log {
    fn say(&self, line: &str) {
        self.add(line);
    }

    fn report(&self, line: &str) {
        self.add(line);
    }
}

/// The daemon's console: both its streams cut into lines in `log`, and the
/// address its out stream's first address line names sent on `address`.
#[must_use]
pub(crate) fn daemon_console(log: Log, address: Sender<String>) -> Console {
    Console::new(
        LogStream::new(log.clone(), Some(address)),
        LogStream::new(log, None),
    )
}

/// A stream cut into lines, each added to the log once its newline comes,
/// since a write may end mid-line; the first line that says an address has
/// it sent, once.
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

            self.log.add(&line);

            if let Some(url) = line.strip_prefix(ADDRESS_PREFIX)
                && let Some(address) = self.address.take()
            {
                // The shell may have stopped waiting for it.
                let _ = address.send(url.to_owned());
            }
        }

        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use p02_shared::read_text_lossy;

    use super::*;

    #[test]
    fn the_daemons_console_logs_each_line_whole_and_sends_the_first_address_once() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("daemon.log");
        let (said, address) = mpsc::channel();
        let mut out = LogStream::new(Log::begin(path.clone()), Some(said));

        for write in [
            "Port 4310 was ta",
            "ken.\n",
            &format!("{ADDRESS_PREFIX}http://127.0.0.1:4311/#token=ab"),
            &format!("c\n{ADDRESS_PREFIX}http://127.0.0.1:4312/#token=de\nStop"),
            "ping.\n",
        ] {
            out.write_all(write.as_bytes()).unwrap();
        }

        assert_eq!(
            read_text_lossy(&path).unwrap(),
            format!(
                "Port 4310 was taken.\n{ADDRESS_PREFIX}http://127.0.0.1:4311/#token=abc\n\
                 {ADDRESS_PREFIX}http://127.0.0.1:4312/#token=de\nStopping.\n"
            )
        );
        assert_eq!(
            address.try_iter().collect::<Vec<_>>(),
            ["http://127.0.0.1:4311/#token=abc"]
        );
    }

    #[test]
    fn a_log_begun_anew_holds_only_the_lines_of_its_run() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("telegram.log");

        append_line(&path, b"Telegram connector: the last run's line.").unwrap();

        let log = Log::begin(path.clone());

        log.say("Telegram connector: this run's line.");

        assert_eq!(
            read_text_lossy(&path).unwrap(),
            "Telegram connector: this run's line.\n"
        );
    }
}
