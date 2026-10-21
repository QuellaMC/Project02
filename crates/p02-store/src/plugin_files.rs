//! A plugin's own files in a character's data, `plugin-data/<plugin>/`:
//! documents (`.json`) replaced whole and logs (`.jsonl`) appended to, every
//! value held to the JSON limits, one lessee at a time. The store's ledger,
//! `.plugin-store.json`, counts the writes it committed and journals the one
//! in flight: a write is journaled, then made, checked and committed, so one
//! a crash cut short is finished by the next lease, or refused as damage
//! when its file is neither what the write found there nor what it made. A
//! file's name says its kind, so no file is ever both.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Instant;

use p02_contracts::{FileStoreBackend, LeasedFiles, StoreError};
use p02_shared::{
    BoundJsonError, Credentials, Identifier, JsonLimits, PathEntry, append_line, bound_json,
    create_directories, describe_entry, read_file, sync_file, write_file_atomically,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::character_data::CharacterData;
use crate::digest::sha256_hex;
use crate::error::StorageError;
use crate::home::check_real;
use crate::jsonl::{committed_length, committed_lines};
use crate::layout::{EntryKind, PLUGIN_STORE_LEDGER};
use crate::lock::{Lease, Resource, acquire_before};

/// What a file of a plugin's store holds, as its name says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileKind {
    /// One JSON value, in a `.json` file replaced whole.
    Document,
    /// One JSON value a line, in a `.jsonl` file appended to.
    Log,
}

impl fmt::Display for FileKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Document => "document",
            Self::Log => "log",
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

/// A plugin's files while its lease is held, with the store's ledger as
/// last read or written. Dropping it releases the lease.
#[derive(Debug)]
pub(crate) struct LeasedPluginFiles {
    root: PathBuf,
    ledger: Ledger,
    lease: Option<Lease>,
}

/// How a journaled write is made on its file.
type Apply<'a> = &'a dyn Fn(&Path, &Pending) -> io::Result<()>;

/// A file of a plugin's store as its plugin names it: `/`-separated
/// segments of ASCII letters, digits, `.`, `_` and `-`, each beginning with
/// a letter or a digit, the last ending in `.json` or `.jsonl`. So no path
/// leaves the store or names its ledger, a write's temporary or a database
/// beside it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
struct StorePath {
    text: String,
    kind: FileKind,
}

#[derive(Debug, thiserror::Error)]
#[error("not a path of a plugin's store")]
struct NotAStorePath;

/// A store's ledger: how many writes it committed, and the one it journaled
/// and has not committed yet.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending: Option<Pending>,
}

/// A write as its journal holds it: what it makes of which file, and what
/// it found there, so whoever finds it after a crash can tell how far it
/// came.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
enum Pending {
    /// A document replaced by `content`; `replaces` is the digest of the
    /// document it found, none when there was none.
    Replace {
        path: StorePath,
        replaces: Option<String>,
        content: String,
    },
    /// `line` appended to a log after its first `after` bytes, the whole
    /// lines it found, whose digest is `prefix`.
    Append {
        path: StorePath,
        after: u64,
        prefix: String,
        line: String,
    },
}

/// How far a journaled write came on its file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Progress {
    /// The file is as the write found it, or holds part of an append.
    Unfinished,
    /// The file is as the write made it.
    Done,
}

impl PluginFiles {
    pub(crate) fn new(data: CharacterData, plugin: Identifier) -> Self {
        Self { data, plugin }
    }

    /// The store under its lease, waited for until `deadline` at the latest,
    /// with the write a crash left journaled finished first.
    pub(crate) fn lease_before(
        &self,
        deadline: Instant,
    ) -> Result<LeasedPluginFiles, StorageError> {
        let root = self.data.plugin_root(&self.plugin);
        let lease = acquire_before(
            &self.data.locks_root(),
            &Resource::PluginFiles(&root),
            deadline,
        )?;
        let mut leased = LeasedPluginFiles {
            root,
            ledger: Ledger::default(),
            lease: Some(lease),
        };

        self.data.checked_plugin_root(&self.plugin)?;
        leased.ledger = Ledger::read(&leased.root)?;
        leased.settle()?;
        Ok(leased)
    }
}

impl FileStoreBackend for PluginFiles {
    fn lease(&self, deadline: Instant) -> Result<Box<dyn LeasedFiles + '_>, StoreError> {
        Ok(Box::new(self.lease_before(deadline).map_err(store_error)?))
    }
}

impl LeasedPluginFiles {
    pub(crate) fn read_document(&self, path: &str) -> Result<Option<Value>, StorageError> {
        let path = StorePath::named(path, FileKind::Document)?;
        let target = self.located(&path)?;

        read_entry(&target)?
            .map(|bytes| {
                value_of(&bytes, &path.text).map_err(|source| StorageError::MalformedDocument {
                    path: target.clone(),
                    source,
                })
            })
            .transpose()
    }

    /// The log's committed lines, each a value; what follows the last
    /// newline is an append cut short and no line.
    pub(crate) fn read_log(&self, path: &str) -> Result<Vec<Value>, StorageError> {
        let path = StorePath::named(path, FileKind::Log)?;
        let target = self.located(&path)?;
        let bytes = read_entry(&target)?.unwrap_or_default();

        committed_lines(&bytes)
            .map(|(line, text)| {
                value_of(text, &path.text).map_err(|source| StorageError::MalformedLine {
                    path: target.clone(),
                    line,
                    source,
                })
            })
            .collect()
    }

    fn replace_with(
        &mut self,
        path: &str,
        value: &Value,
        apply: Apply<'_>,
    ) -> Result<(), StorageError> {
        let path = StorePath::named(path, FileKind::Document)?;
        let mut content = bounded_text(value, &path)?;

        content.push('\n');
        self.settle()?;

        let target = self.located(&path)?;
        let found = read_entry(&target)?;

        self.write(
            &target,
            &Pending::Replace {
                path,
                replaces: found.as_deref().map(sha256_hex),
                content,
            },
            apply,
        )
    }

    fn append_with(
        &mut self,
        path: &str,
        value: &Value,
        apply: Apply<'_>,
    ) -> Result<(), StorageError> {
        let path = StorePath::named(path, FileKind::Log)?;
        let line = bounded_text(value, &path)?;

        self.settle()?;

        let target = self.located(&path)?;
        let found = read_entry(&target)?.unwrap_or_default();
        let whole = &found[..committed_length(&found)];

        self.write(
            &target,
            &Pending::Append {
                path,
                after: whole.len() as u64,
                prefix: sha256_hex(whole),
                line,
            },
            apply,
        )
    }

    /// Journals `pending`, makes it on its file at `target`, checks that it
    /// landed and commits it. A write that failed and left its file
    /// unfinished is no write: its journal goes, so no later lease makes
    /// what its caller was told failed. Kept journaled, when even that fails
    /// or the file holds the write all the same, it is finished before the
    /// next write starts, or by the next lease.
    fn write(
        &mut self,
        target: &Path,
        pending: &Pending,
        apply: Apply<'_>,
    ) -> Result<(), StorageError> {
        let revision = self.ledger.revision;

        self.save(Ledger {
            revision,
            pending: Some(pending.clone()),
        })?;

        if let Err(source) = apply(target, pending) {
            if pending.progress(target).ok() == Some(Progress::Unfinished) {
                let _ = self.save(Ledger {
                    revision,
                    pending: None,
                });
            }

            return Err(StorageError::Write {
                path: target.to_path_buf(),
                source,
            });
        }

        pending.check_landed(target)?;
        self.save(Ledger {
            revision: revision + 1,
            pending: None,
        })
    }

    /// Finishes the write the ledger journaled, if there is one: made where
    /// it did not land, then checked and committed.
    fn settle(&mut self) -> Result<(), StorageError> {
        let Some(pending) = self.ledger.pending.clone() else {
            return Ok(());
        };
        let target = self.located(pending.path())?;

        if pending.progress(&target)? == Progress::Unfinished {
            apply(&target, &pending).map_err(StorageError::write(&target))?;
            pending.check_landed(&target)?;
        }

        self.save(Ledger {
            revision: self.ledger.revision + 1,
            pending: None,
        })
    }

    /// Writes `ledger` and keeps it as the store's, or keeps the one before
    /// when the write fails.
    fn save(&mut self, ledger: Ledger) -> Result<(), StorageError> {
        ledger.write(&self.root)?;
        self.ledger = ledger;
        Ok(())
    }

    /// Where `path` is, once every entry on the way to it is a real
    /// directory and it a real file, or not there yet.
    fn located(&self, path: &StorePath) -> Result<PathBuf, StorageError> {
        let mut location = self.root.clone();
        let mut segments = path.text.split('/').peekable();

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
}

impl LeasedFiles for LeasedPluginFiles {
    fn read_json(&self, path: &str) -> Result<Option<Value>, StoreError> {
        self.read_document(path).map_err(store_error)
    }

    fn read_jsonl(&self, path: &str) -> Result<Vec<Value>, StoreError> {
        self.read_log(path).map_err(store_error)
    }

    fn write_json(&mut self, path: &str, value: &Value) -> Result<(), StoreError> {
        self.replace_with(path, value, &apply).map_err(store_error)
    }

    fn append_jsonl(&mut self, path: &str, value: &Value) -> Result<(), StoreError> {
        self.append_with(path, value, &apply).map_err(store_error)
    }

    fn revision(&self) -> Result<u64, StoreError> {
        Ok(self.ledger.revision)
    }
}

impl Drop for LeasedPluginFiles {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            lease.release();
        }
    }
}

impl StorePath {
    fn parse(text: &str) -> Result<Self, NotAStorePath> {
        let named = text.split('/').all(|segment| {
            segment
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        });
        let kind = match text.rsplit_once('.') {
            Some((_, "jsonl")) => FileKind::Log,
            Some((_, "json")) => FileKind::Document,
            _ => return Err(NotAStorePath),
        };

        if named {
            Ok(Self {
                text: text.to_owned(),
                kind,
            })
        } else {
            Err(NotAStorePath)
        }
    }

    /// The path a plugin names, when it is a store path of the kind its call
    /// takes.
    fn named(text: &str, expected: FileKind) -> Result<Self, StorageError> {
        let path = Self::parse(text).map_err(|_| StorageError::UnsafeStorePath {
            path: text.to_owned(),
        })?;

        if path.kind == expected {
            Ok(path)
        } else {
            Err(StorageError::WrongFileKind {
                path: path.text,
                found: path.kind,
                expected,
            })
        }
    }
}

impl TryFrom<String> for StorePath {
    type Error = NotAStorePath;

    fn try_from(text: String) -> Result<Self, Self::Error> {
        Self::parse(&text)
    }
}

impl From<StorePath> for String {
    fn from(path: StorePath) -> Self {
        path.text
    }
}

impl Ledger {
    /// The ledger of the store at `root`: a store never written has none,
    /// and has committed nothing.
    fn read(root: &Path) -> Result<Self, StorageError> {
        let path = root.join(PLUGIN_STORE_LEDGER);
        let Some(bytes) = read_entry(&path)? else {
            return Ok(Self::default());
        };

        serde_json::from_slice(&bytes)
            .map_err(|source| StorageError::MalformedLedger { path, source })
    }

    /// Replaces the store's ledger whole, making the store if this is its
    /// first write.
    fn write(&self, root: &Path) -> Result<(), StorageError> {
        let path = root.join(PLUGIN_STORE_LEDGER);
        let mut bytes =
            serde_json::to_vec(self).expect("a ledger of plain fields always serializes");

        bytes.push(b'\n');
        create_directories(root).map_err(StorageError::write(root))?;
        write_file_atomically(&path, &bytes).map_err(StorageError::write(&path))
    }
}

impl Pending {
    fn path(&self) -> &StorePath {
        match self {
            Self::Replace { path, .. } | Self::Append { path, .. } => path,
        }
    }

    /// How far the write came on its file at `target`; damage when the file
    /// is neither as the write found it nor as it made it.
    fn progress(&self, target: &Path) -> Result<Progress, StorageError> {
        let found = read_entry(target)?;
        let found = found.as_deref();
        let conflict = || StorageError::InterruptedWriteConflict {
            path: target.to_path_buf(),
        };

        match self {
            Self::Replace {
                replaces, content, ..
            } => {
                if found == Some(content.as_bytes()) {
                    Ok(Progress::Done)
                } else if found.map(sha256_hex) == *replaces {
                    Ok(Progress::Unfinished)
                } else {
                    Err(conflict())
                }
            }
            Self::Append {
                after,
                prefix,
                line,
                ..
            } => {
                let (whole, rest) = usize::try_from(*after)
                    .ok()
                    .and_then(|after| found.unwrap_or_default().split_at_checked(after))
                    .ok_or_else(conflict)?;

                if sha256_hex(whole) != *prefix {
                    Err(conflict())
                } else if rest.strip_suffix(b"\n") == Some(line.as_bytes()) {
                    Ok(Progress::Done)
                } else if rest.contains(&b'\n') {
                    Err(conflict())
                } else {
                    // What follows the whole lines is an append cut short,
                    // of this line or of one before it, and appending cuts
                    // it first.
                    Ok(Progress::Unfinished)
                }
            }
        }
    }

    /// Refuses, as damage, the write's file at `target` when the write was
    /// made on it and it is still not as the write made it.
    fn check_landed(&self, target: &Path) -> Result<(), StorageError> {
        match self.progress(target)? {
            Progress::Done => Ok(()),
            Progress::Unfinished => Err(StorageError::InterruptedWriteConflict {
                path: target.to_path_buf(),
            }),
        }
    }
}

/// Makes `pending` on its file at `target`: the document replaced whole, or
/// the line appended after the log's last whole line. Either is on disk
/// before the ledger commits it, so no crash of the machine leaves a write
/// counted that its file does not hold.
fn apply(target: &Path, pending: &Pending) -> io::Result<()> {
    if let Some(parent) = target.parent() {
        create_directories(parent)?;
    }

    match pending {
        Pending::Replace { content, .. } => write_file_atomically(target, content.as_bytes()),
        Pending::Append { line, .. } => {
            append_line(target, line.as_bytes())?;
            sync_file(target)
        }
    }
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

/// `value` as the one line of JSON text it is written as, once it is within
/// the limits.
fn bounded_text(value: &Value, path: &StorePath) -> Result<String, StorageError> {
    let value = bound_json(
        value.clone(),
        &path.text,
        JsonLimits::default(),
        Credentials::Keep,
    )
    .map_err(|source| StorageError::StoreValueLimits {
        path: path.text.clone(),
        source,
    })?;

    Ok(serde_json::to_string(&value).expect("a JSON value always serializes"))
}

fn store_error(error: StorageError) -> StoreError {
    StoreError::Store(Box::new(error))
}

#[cfg(test)]
#[expect(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "a test writes a store's files as a writer cut short or a person would"
)]
mod tests {
    use std::io::Write as _;
    use std::time::Duration;

    use p02_shared::{DanglingLinks, canonical_path};
    use serde_json::json;

    use super::*;
    use crate::home::Home;
    use crate::test_process;

    const WRITER: &str = "plugin_files::tests::a_plugin_writer_for_another_process";

    fn mira() -> Identifier {
        Identifier::new("mira").unwrap()
    }

    /// Character-state's files in Mira's data, in a home of the test's own.
    fn store_in(home: &Home) -> PluginFiles {
        let data = CharacterData::ensure(home, &mira()).unwrap();

        PluginFiles::new(data, Identifier::new("character-state").unwrap())
    }

    fn later() -> Instant {
        Instant::now() + Duration::from_secs(10)
    }

    fn mood(mood: &str) -> Value {
        json!({"mood": mood})
    }

    /// Not a test of its own: the second process of the tests below. It
    /// leases the store of the home its parent names and does what its
    /// brief says, then says so and waits to be killed.
    #[test]
    fn a_plugin_writer_for_another_process() {
        let Some(brief) = test_process::brief() else {
            return;
        };
        let (root, stage) = brief.split_once('\n').unwrap();
        let files = store_in(&Home::new(PathBuf::from(root)));
        let mut leased = files.lease_before(later()).unwrap();
        let stopped = |_: &Path, _: &Pending| -> io::Result<()> {
            test_process::ready_then_wait();
            Ok(())
        };

        match stage {
            "hold" => test_process::ready_then_wait(),
            "replace-unmade" => leased
                .replace_with("state.json", &mood("curious"), &stopped)
                .unwrap(),
            "replace-landed" => leased
                .replace_with("state.json", &mood("curious"), &|target, pending| {
                    apply(target, pending)?;
                    stopped(target, pending)
                })
                .unwrap(),
            "append-cut" => leased
                .append_with("events.jsonl", &mood("curious"), &|target, pending| {
                    let Pending::Append { line, .. } = pending else {
                        unreachable!("an append is journaled as one");
                    };

                    std::fs::OpenOptions::new()
                        .append(true)
                        .open(target)?
                        .write_all(&line.as_bytes()[..line.len() / 2])?;
                    stopped(target, pending)
                })
                .unwrap(),
            _ => unreachable!("no such stage: {stage}"),
        }
    }

    /// storage.plugin-store-journal: a write whose writer was killed part way is finished by the next lease from what its journal says, made when it never reached its file, kept and counted once when it landed, completed when its line was cut short, and refused as damage, its file left as it is, when the file is neither what the write found nor what it made; a journal this build cannot read is refused, never guessed at
    #[test]
    fn a_write_a_crash_cut_short_is_finished_by_the_next_lease_or_refused_as_damage() {
        for (stage, edit, events, state) in [
            ("replace-unmade", None, ["calm"].as_slice(), Some("curious")),
            ("replace-landed", None, &["calm"], Some("curious")),
            ("append-cut", None, &["calm", "curious"], Some("calm")),
            ("append-cut", Some("{\"mood\":\"edited\"}\n"), &[], None),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());
            let files = store_in(&home);
            let root = files.data.plugin_root(&files.plugin);
            let mut leased = files.lease_before(later()).unwrap();

            leased
                .replace_with("state.json", &mood("calm"), &apply)
                .unwrap();
            leased
                .append_with("events.jsonl", &mood("calm"), &apply)
                .unwrap();
            drop(leased);

            let mut writer =
                test_process::spawn(WRITER, &format!("{}\n{stage}", home.root().display()));

            writer.kill().unwrap();
            writer.wait().unwrap();

            let Some(edit) = edit else {
                let leased = files.lease_before(later()).unwrap();
                let moods = |values: Vec<Value>| -> Vec<String> {
                    values
                        .iter()
                        .map(|value| value["mood"].as_str().unwrap().to_owned())
                        .collect()
                };

                assert_eq!(moods(leased.read_log("events.jsonl").unwrap()), events);
                assert_eq!(
                    leased.read_document("state.json").unwrap(),
                    state.map(mood),
                    "{stage}"
                );
                assert_eq!(
                    leased.ledger,
                    Ledger {
                        revision: 3,
                        pending: None,
                    }
                );
                assert_eq!(
                    std::fs::read_to_string(root.join(PLUGIN_STORE_LEDGER)).unwrap(),
                    "{\"revision\":3}\n"
                );
                continue;
            };

            std::fs::write(root.join("events.jsonl"), edit).unwrap();

            let refused = files.lease_before(later()).unwrap_err();

            assert!(
                matches!(refused, StorageError::InterruptedWriteConflict { .. }),
                "{refused}"
            );
            assert_eq!(refused.code(), "malformed_record");
            assert_eq!(
                std::fs::read_to_string(root.join("events.jsonl")).unwrap(),
                edit
            );
            assert_eq!(
                Ledger::read(&root)
                    .unwrap()
                    .pending
                    .map(|pending| pending.path().clone()),
                Some(StorePath::parse("events.jsonl").unwrap())
            );

            let unread = r#"{"revision":2,"pending":{"rename":{"path":"events.jsonl"}}}"#;

            std::fs::write(root.join(PLUGIN_STORE_LEDGER), unread).unwrap();

            let refused = files.lease_before(later()).unwrap_err();

            assert!(
                matches!(refused, StorageError::MalformedLedger { .. }),
                "{refused}"
            );
            assert_eq!(
                std::fs::read_to_string(root.join(PLUGIN_STORE_LEDGER)).unwrap(),
                unread
            );
        }
    }

    /// A write the disk refused, as a full disk does, is reported, and no
    /// later lease makes it behind its caller's back.
    #[test]
    fn a_write_that_failed_to_land_is_never_made_after() {
        let directory = tempfile::tempdir().unwrap();
        let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());
        let files = store_in(&home);
        let full = |_: &Path, _: &Pending| -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::StorageFull,
                "the disk is full",
            ))
        };
        let mut leased = files.lease_before(later()).unwrap();

        leased
            .append_with("events.jsonl", &mood("calm"), &apply)
            .unwrap();

        for refused in [
            leased.append_with("events.jsonl", &mood("curious"), &full),
            leased.replace_with("state.json", &mood("curious"), &full),
        ] {
            assert_eq!(refused.unwrap_err().code(), "write_failed");
        }

        drop(leased);

        let leased = files.lease_before(later()).unwrap();

        assert_eq!(leased.read_log("events.jsonl").unwrap(), [mood("calm")]);
        assert_eq!(leased.read_document("state.json").unwrap(), None);
        assert_eq!(
            leased.ledger,
            Ledger {
                revision: 1,
                pending: None,
            }
        );
    }

    #[test]
    fn a_plugin_lease_is_waited_for_until_the_deadline_or_two_seconds_without_progress() {
        let directory = tempfile::tempdir().unwrap();
        let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());
        let files = store_in(&home);
        let mut holder = test_process::spawn(WRITER, &format!("{}\nhold", home.root().display()));
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
