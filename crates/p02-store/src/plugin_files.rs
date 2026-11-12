//! A plugin's own files in a character's data, `plugin-data/<plugin>/`:
//! documents (`.json`) and text files (`.txt`) replaced whole or removed,
//! and logs (`.jsonl`) only appended to, every value held to the JSON
//! limits and every text to its bound, one lessee at a time. A file's name
//! says its kind, so no file is of two kinds.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Instant;

use p02_contracts::{FileStoreBackend, LeasedFiles, StoreError, TEXT_FILE_KIB};
use p02_shared::{
    BoundJsonError, Credentials, Identifier, JsonLimits, PathEntry, append_line, bound_json,
    create_directories, describe_entry, read_file, remove_file, write_file_atomically,
};
use serde_json::Value;

use crate::character_data::CharacterData;
use crate::error::StorageError;
use crate::home::check_real;
use crate::jsonl::committed_lines;
use crate::layout::EntryKind;
use crate::lock::{Lease, Resource, acquire_before};

/// What a file of a plugin's store holds, as its name says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileKind {
    /// One JSON value, in a `.json` file replaced whole.
    Document,
    /// One JSON value a line, in a `.jsonl` file appended to.
    Log,
    /// UTF-8 text within its bound, in a `.txt` file replaced whole.
    Text,
}

impl FileKind {
    /// How the name of every file of this kind ends.
    fn suffix(self) -> &'static str {
        match self {
            Self::Document => ".json",
            Self::Log => ".jsonl",
            Self::Text => ".txt",
        }
    }
}

impl fmt::Display for FileKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Document => "document",
            Self::Log => "log",
            Self::Text => "text file",
        })
    }
}

/// Why text in a plugin's store is no value its plugin is handed.
#[derive(Debug, thiserror::Error)]
pub enum ValueProblem {
    #[error("it is not JSON")]
    NotJson(#[source] serde_json::Error),
    #[error(transparent)]
    Limits(BoundJsonError),
}

/// One plugin's files in one character's data.
#[derive(Clone, Debug)]
pub(crate) struct PluginFiles {
    data: CharacterData,
    plugin: Identifier,
}

/// A plugin's files while its lease is held. Dropping it releases the
/// lease.
#[derive(Debug)]
struct LeasedPluginFiles {
    root: PathBuf,
    lease: Option<Lease>,
}

impl PluginFiles {
    pub(crate) fn new(data: CharacterData, plugin: Identifier) -> Self {
        Self { data, plugin }
    }

    /// The store under its lease, waited for until `deadline` at the latest.
    fn lease_before(&self, deadline: Instant) -> Result<LeasedPluginFiles, StorageError> {
        let root = self.data.plugin_root(&self.plugin);
        let lease = acquire_before(
            &self.data.locks_root(),
            &Resource::PluginFiles(&root),
            deadline,
        )?;
        let leased = LeasedPluginFiles {
            root,
            lease: Some(lease),
        };

        self.data.checked_plugin_root(&self.plugin)?;
        Ok(leased)
    }
}

impl FileStoreBackend for PluginFiles {
    fn lease(&self, deadline: Instant) -> Result<Box<dyn LeasedFiles + '_>, StoreError> {
        Ok(Box::new(self.lease_before(deadline).map_err(store_error)?))
    }
}

impl LeasedPluginFiles {
    fn read_document(&self, path: &str) -> Result<Option<Value>, StorageError> {
        let target = self.located(store_path(path, &[FileKind::Document])?)?;

        read_entry(&target)?
            .map(|bytes| {
                value_of(&bytes, path).map_err(|source| StorageError::MalformedDocument {
                    path: target.clone(),
                    source,
                })
            })
            .transpose()
    }

    /// The log's committed lines, each a value, and a line that is no JSON
    /// value within the limits null, for its plugin to pass over as it
    /// passes over any line it cannot use; what follows the last newline is
    /// an append cut short and no line.
    fn read_log(&self, path: &str) -> Result<Vec<Value>, StorageError> {
        Ok(committed_lines(&self.log_bytes(path)?)
            .map(|(_, text)| value_of(text, path).unwrap_or(Value::Null))
            .collect())
    }

    /// How many lines [`LeasedPluginFiles::read_log`] reads of the log.
    fn count_log(&self, path: &str) -> Result<u64, StorageError> {
        Ok(committed_lines(&self.log_bytes(path)?).count() as u64)
    }

    /// The text file's text, once it is UTF-8 within the bound.
    fn read_text_file(&self, path: &str) -> Result<Option<String>, StorageError> {
        let target = self.located(store_path(path, &[FileKind::Text])?)?;
        let Some(bytes) = read_entry(&target)? else {
            return Ok(None);
        };

        match String::from_utf8(bytes) {
            Ok(text) if fits(&text) => Ok(Some(text)),
            _ => Err(StorageError::MalformedText { path: target }),
        }
    }

    fn replace(&self, path: &str, value: &Value) -> Result<(), StorageError> {
        let mut content = bounded_text(value, store_path(path, &[FileKind::Document])?)?;

        content.push('\n');

        let target = self.made_way_to(path)?;

        write_file_atomically(&target, content.as_bytes()).map_err(StorageError::write(&target))
    }

    /// Appends the line after the log's last whole line, what a crash left
    /// after it cut first.
    fn append(&self, path: &str, value: &Value) -> Result<(), StorageError> {
        let line = bounded_text(value, store_path(path, &[FileKind::Log])?)?;
        let target = self.made_way_to(path)?;

        append_line(&target, line.as_bytes()).map_err(StorageError::write(&target))
    }

    fn replace_text(&self, path: &str, text: &str) -> Result<(), StorageError> {
        let path = store_path(path, &[FileKind::Text])?;

        if !fits(text) {
            return Err(StorageError::StoreTextTooLong {
                path: path.to_owned(),
            });
        }

        let target = self.made_way_to(path)?;

        write_file_atomically(&target, text.as_bytes()).map_err(StorageError::write(&target))
    }

    /// Removes the document or text file at `path` and nothing else, not
    /// the directories on the way to it. A log is only appended to.
    fn delete(&self, path: &str) -> Result<(), StorageError> {
        let target = self.located(store_path(path, &[FileKind::Document, FileKind::Text])?)?;

        remove_file(&target).map_err(StorageError::write(&target))
    }

    fn log_bytes(&self, path: &str) -> Result<Vec<u8>, StorageError> {
        let target = self.located(store_path(path, &[FileKind::Log])?)?;

        Ok(read_entry(&target)?.unwrap_or_default())
    }

    /// Where `path` is, once every entry on the way to it is a real
    /// directory and it a real file, or not there yet.
    fn located(&self, path: &str) -> Result<PathBuf, StorageError> {
        let mut location = self.root.clone();
        let mut segments = path.split('/').peekable();

        while let Some(segment) = segments.next() {
            location.push(segment);

            let expected = if segments.peek().is_some() {
                EntryKind::Directory
            } else {
                EntryKind::File
            };

            check_real(&location, expected)?;
        }

        Ok(location)
    }

    /// Where `path` is, as [`LeasedPluginFiles::located`] finds it, with
    /// the directories on the way to it made.
    fn made_way_to(&self, path: &str) -> Result<PathBuf, StorageError> {
        let target = self.located(path)?;

        if let Some(parent) = target.parent() {
            create_directories(parent).map_err(StorageError::write(parent))?;
        }

        Ok(target)
    }
}

impl LeasedFiles for LeasedPluginFiles {
    fn read_json(&self, path: &str) -> Result<Option<Value>, StoreError> {
        self.read_document(path).map_err(store_error)
    }

    fn read_jsonl(&self, path: &str) -> Result<Vec<Value>, StoreError> {
        self.read_log(path).map_err(store_error)
    }

    fn count_jsonl(&self, path: &str) -> Result<u64, StoreError> {
        self.count_log(path).map_err(store_error)
    }

    fn read_text(&self, path: &str) -> Result<Option<String>, StoreError> {
        self.read_text_file(path).map_err(store_error)
    }

    fn write_json(&mut self, path: &str, value: &Value) -> Result<(), StoreError> {
        self.replace(path, value).map_err(store_error)
    }

    fn append_jsonl(&mut self, path: &str, value: &Value) -> Result<(), StoreError> {
        self.append(path, value).map_err(store_error)
    }

    fn write_text(&mut self, path: &str, text: &str) -> Result<(), StoreError> {
        self.replace_text(path, text).map_err(store_error)
    }

    fn remove(&mut self, path: &str) -> Result<(), StoreError> {
        self.delete(path).map_err(store_error)
    }
}

impl Drop for LeasedPluginFiles {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            lease.release();
        }
    }
}

/// `text`, when it names a file of one of `kinds` in a plugin's store:
/// `/`-separated segments of ASCII letters, digits, `.`, `_` and `-`, each
/// beginning with a letter or a digit, the last ending in the suffix of its
/// kind. So no path leaves the store or names a write's temporary or a
/// database beside it.
fn store_path<'a>(text: &'a str, kinds: &'static [FileKind]) -> Result<&'a str, StorageError> {
    let named = text.split('/').all(|segment| {
        segment
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    });

    if named && kinds.iter().any(|kind| text.ends_with(kind.suffix())) {
        Ok(text)
    } else {
        Err(StorageError::InvalidStorePath {
            path: text.to_owned(),
            expected: kinds,
        })
    }
}

/// Whether `text` is within what a text file holds.
fn fits(text: &str) -> bool {
    text.len() <= TEXT_FILE_KIB * 1_024
}

/// The bytes of the file at `target`, none when nothing is there; anything
/// there but a file is refused.
fn read_entry(target: &Path) -> Result<Option<Vec<u8>>, StorageError> {
    match describe_entry(target) {
        PathEntry::Absent => Ok(None),
        PathEntry::File => read_file(target)
            .map(Some)
            .map_err(StorageError::read(target)),
        PathEntry::Unreadable(source) => Err(StorageError::Read {
            path: target.to_path_buf(),
            source,
        }),
        PathEntry::Directory | PathEntry::Link | PathEntry::Other => Err(StorageError::NotReal {
            path: target.to_path_buf(),
            expected: EntryKind::File,
        }),
    }
}

/// The value `text` holds, once it is JSON within the limits.
fn value_of(text: &[u8], name: &str) -> Result<Value, ValueProblem> {
    let value = serde_json::from_slice(text).map_err(ValueProblem::NotJson)?;

    bound_json(value, name, JsonLimits::default(), Credentials::Keep).map_err(ValueProblem::Limits)
}

/// `value` as the one line of JSON text it is written as at `path`, once
/// it is within the limits.
fn bounded_text(value: &Value, path: &str) -> Result<String, StorageError> {
    let value = bound_json(
        value.clone(),
        path,
        JsonLimits::default(),
        Credentials::Keep,
    )
    .map_err(|source| StorageError::StoreValueLimits {
        path: path.to_owned(),
        source,
    })?;

    Ok(serde_json::to_string(&value).expect("a JSON value always serializes"))
}

fn store_error(error: StorageError) -> StoreError {
    StoreError::Store(Box::new(error))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use p02_shared::{DanglingLinks, canonical_path};

    use super::*;
    use crate::home::Home;
    use crate::test_process;

    const HOLDER: &str = "plugin_files::tests::a_plugin_lease_holder_for_another_process";

    /// Character-state's files in Mira's data in `home`.
    fn store_in(home: &Home) -> PluginFiles {
        let data = CharacterData::ensure(home, &Identifier::new("mira").unwrap()).unwrap();

        PluginFiles::new(data, Identifier::new("character-state").unwrap())
    }

    fn later() -> Instant {
        Instant::now() + Duration::from_secs(10)
    }

    /// Not a test of its own: the second process of the test below. It
    /// leases the store of the home its parent names, says so, and holds
    /// the lease until its parent closes its input.
    #[test]
    fn a_plugin_lease_holder_for_another_process() {
        let Some(root) = test_process::brief() else {
            return;
        };
        let leased = store_in(&Home::new(PathBuf::from(root)))
            .lease_before(later())
            .unwrap();

        test_process::ready_then_wait();
        drop(leased);
    }

    #[test]
    fn a_plugin_lease_is_waited_for_until_the_deadline_or_two_seconds_without_progress() {
        let directory = tempfile::tempdir().unwrap();
        let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());
        let files = store_in(&home);
        let mut holder = test_process::spawn(HOLDER, &home.root().display().to_string());
        let started = Instant::now();
        let refused = files
            .lease_before(started + Duration::from_millis(300))
            .unwrap_err();

        assert_eq!(refused.code(), "storage_busy");
        assert!(
            (Duration::from_millis(300)..Duration::from_secs(2)).contains(&started.elapsed()),
            "{:?}",
            started.elapsed()
        );

        let started = Instant::now();

        files.lease_before(later()).unwrap_err();
        assert!(
            (Duration::from_secs(2)..Duration::from_secs(10)).contains(&started.elapsed()),
            "{:?}",
            started.elapsed()
        );

        let input = holder.stdin.take();
        let letting_go = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(input);
        });

        drop(files.lease_before(later()).unwrap());
        letting_go.join().unwrap();
        assert!(holder.wait().unwrap().success());
    }
}
