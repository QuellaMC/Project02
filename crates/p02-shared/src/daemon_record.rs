use std::fmt;
use std::io;
use std::num::{NonZeroU16, NonZeroU32};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fs::read_text_lossy;

/// The home when none is named: where the daemon serves, and where a client
/// looks for it.
pub const DEFAULT_HOME: &str = ".project02";

const DAEMON_RECORD_FILE: &str = "daemon.json";

/// The daemon's record on its home, `<home>/daemon.json`, written whole and
/// owner-only by the daemon that holds the home's lease and by nothing else.
/// The token and the port belong to the home and outlive a run; `running`
/// names the run that last wrote the record and is dropped by a clean stop.
/// A reader never trusts `running` without asking the address: after a crash
/// it names a process that is gone, and the lease, not the record, is what
/// says a daemon is alive.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonRecord {
    /// The protocol the daemon that wrote the record speaks.
    pub protocol_version: u32,
    pub token: DaemonToken,
    /// The port the last run bound, for the next run to bind again.
    pub port: NonZeroU16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running: Option<DaemonRun>,
}

/// The run that last wrote a [`DaemonRecord`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonRun {
    pub pid: NonZeroU32,
    pub started_at: String,
}

/// The bearer token a client presents to the daemon: minted once per home,
/// one line of printable ASCII. Its `Debug` never shows it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct DaemonToken(String);

/// Why a text is not a [`DaemonToken`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("not a daemon token: one line of printable ASCII")]
pub struct ParseDaemonTokenError;

impl DaemonToken {
    /// # Errors
    ///
    /// [`ParseDaemonTokenError`] when `value` is empty or holds anything but
    /// printable ASCII, a space included.
    pub fn new(value: &str) -> Result<Self, ParseDaemonTokenError> {
        if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_graphic()) {
            Ok(Self(value.to_owned()))
        } else {
            Err(ParseDaemonTokenError)
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for DaemonToken {
    type Error = ParseDaemonTokenError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl fmt::Debug for DaemonToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("DaemonToken").finish_non_exhaustive()
    }
}

/// Why a daemon record that is there could not be taken as one.
#[derive(Debug, thiserror::Error)]
pub enum ReadDaemonRecordError {
    #[error("could not read the daemon record {path}")]
    Read {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    /// Hand-edited, truncated, or written by something else.
    #[error("could not decode the daemon record {path}")]
    Decode {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

/// Reads the daemon record of the home at `home`: `None` when there is
/// none.
///
/// # Errors
///
/// [`ReadDaemonRecordError`] when something is there that cannot be read,
/// or is not a daemon record.
pub fn read_daemon_record(home: &Path) -> Result<Option<DaemonRecord>, ReadDaemonRecordError> {
    let path = home.join(DAEMON_RECORD_FILE);
    let text = match read_text_lossy(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(ReadDaemonRecordError::Read { path, source }),
    };

    serde_json::from_str(&text)
        .map(Some)
        .map_err(|source| ReadDaemonRecordError::Decode { path, source })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::write_file_atomically;

    #[test]
    fn a_home_without_a_record_reads_as_none() {
        let home = tempfile::tempdir().unwrap();

        assert_eq!(read_daemon_record(home.path()).unwrap(), None);
    }

    #[test]
    #[expect(
        clippy::disallowed_methods,
        reason = "the test puts a directory where the record belongs"
    )]
    fn something_there_that_is_not_a_record_is_an_error_naming_the_file() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(DAEMON_RECORD_FILE);
        let refused_naming_the_file = || {
            let error = read_daemon_record(home.path()).unwrap_err();

            assert!(
                error.to_string().contains(&path.display().to_string()),
                "{error}"
            );
        };

        std::fs::create_dir(&path).unwrap();
        refused_naming_the_file();
        std::fs::remove_dir(&path).unwrap();

        for body in [
            r#"{"protocolVersion": 7, "token": "abc", "port": 43"#,
            r#"{"protocolVersion": 7, "port": 4310}"#,
            r#"{"protocolVersion": 7, "token": "two words", "port": 4310}"#,
            r#"{"protocolVersion": 7, "token": "abc", "port": 0}"#,
            r#"{"protocolVersion": 7, "token": "abc", "port": 65536}"#,
            r#"{"protocolVersion":7,"token":"abc","port":4310,"running":{"pid":0,"startedAt":"2026-10-17T09:00:00.000Z"}}"#,
        ] {
            write_file_atomically(&path, body.as_bytes()).unwrap();
            refused_naming_the_file();
        }
    }

    #[test]
    fn a_record_reads_back_as_written() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(DAEMON_RECORD_FILE);
        let stopped = DaemonRecord {
            protocol_version: 7,
            token: DaemonToken::new("abc").unwrap(),
            port: NonZeroU16::new(4310).unwrap(),
            running: None,
        };
        let running = DaemonRecord {
            running: Some(DaemonRun {
                pid: NonZeroU32::new(4242).unwrap(),
                started_at: "2026-10-17T09:00:00.000Z".to_owned(),
            }),
            ..stopped.clone()
        };

        for (record, text) in [
            (
                stopped,
                r#"{"protocolVersion":7,"token":"abc","port":4310}"#,
            ),
            (
                running,
                r#"{"protocolVersion":7,"token":"abc","port":4310,"running":{"pid":4242,"startedAt":"2026-10-17T09:00:00.000Z"}}"#,
            ),
        ] {
            write_file_atomically(&path, text.as_bytes()).unwrap();

            assert_eq!(read_daemon_record(home.path()).unwrap(), Some(record));
        }
    }
}
