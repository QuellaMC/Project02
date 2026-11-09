//! The store's locks: the operating system's advisory lock on a file
//! `<locks root>/<sha256 of the key>.lock`, so the kernel releases a holder
//! that dies and no lock is ever stale. Lock files stay where they are: a
//! file removed while another process waits on it would let two holders
//! lock two files of one name. Beside each held lock, `<…>.owner.json`
//! says who holds it, for a person, and for a waiter to tell the holder
//! changed; whether a lock is held is never read from it.

use std::path::{Path, PathBuf};
use std::process;
use std::thread;
use std::time::{Duration, Instant};

use p02_core::{ConversationId, SessionId, Timestamp};
use p02_shared::{
    LockedFile, create_directories, create_new_file, read_file, remove_file, try_lock_file,
};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::digest::sha256_hex;
use crate::error::{BusyCode, StorageError};

/// What a lock guards. Each has its root, the home's locks or the
/// character's, its key, how long a waiter waits for it, and what it is
/// reported as when that wait runs out.
#[derive(Debug)]
pub(crate) enum Resource<'a> {
    /// The one daemon serving a home.
    Daemon,
    /// The making of a conversation.
    ConversationsCatalog,
    /// An open conversation, which one process drives.
    ConversationWriter(&'a ConversationId),
    /// A directory's schema marker.
    StorageSchema,
    /// A character's sessions catalog.
    SessionCatalog,
    /// A character's inbox.
    Inbox,
    /// A session's log, which one writer appends to.
    SessionWriter(&'a SessionId),
    /// A plugin's files in a character's data, at their root, which one
    /// lessee reads and writes at a time.
    PluginFiles(&'a Path),
    /// A settings document, at its path, which its writer holds while it
    /// reads and replaces it; how long a waiter waits is its caller's to
    /// say, since a person saving a setting is waiting on the answer.
    SettingsDocument { path: &'a Path, wait: Duration },
}

impl Resource<'_> {
    fn key(&self) -> String {
        match self {
            Self::Daemon => "daemon".to_owned(),
            Self::ConversationsCatalog => "conversations-catalog".to_owned(),
            Self::ConversationWriter(id) => format!("conversation-writer:{id}"),
            Self::StorageSchema => "storage-schema".to_owned(),
            Self::SessionCatalog => "session-catalog".to_owned(),
            Self::Inbox => "inbox".to_owned(),
            Self::SessionWriter(id) => format!("session-writer:{id}"),
            Self::PluginFiles(root) => format!("plugin:{}", root.display()),
            Self::SettingsDocument { path, .. } => {
                format!("runtime-control-file:{}", path.display())
            }
        }
    }

    /// How long a waiter waits while the holder makes no progress: a lease
    /// held for as long as a daemon or a conversation lasts is refused at
    /// once, a short guarded write is waited out, and a plugin's files,
    /// which a hook holds for its own short work, are waited for briefly,
    /// since the hook that waits has a deadline of its own.
    fn stall_budget(&self) -> Duration {
        match self {
            Self::Daemon | Self::ConversationWriter(_) | Self::SessionWriter(_) => Duration::ZERO,
            Self::ConversationsCatalog
            | Self::StorageSchema
            | Self::SessionCatalog
            | Self::Inbox => Duration::from_secs(10),
            Self::PluginFiles(_) => Duration::from_secs(2),
            Self::SettingsDocument { wait, .. } => *wait,
        }
    }

    fn busy(&self) -> BusyCode {
        match self {
            Self::SessionWriter(_) => BusyCode::Session,
            _ => BusyCode::Storage,
        }
    }
}

/// Locks held together, released together: the last taken first. A lease is
/// released by [`Lease::release`]; one only dropped still lets its locks go,
/// as a crash would, but leaves its holders' stamps behind.
#[derive(Debug)]
#[must_use = "a lease holds its locks until it is released"]
pub struct Lease {
    held: Vec<Held>,
}

#[derive(Debug)]
struct Held {
    stamp: PathBuf,
    _lock: LockedFile,
}

impl Lease {
    /// Releases every lock, each holder's stamp going first, so a stamp
    /// never outlives its lock into the next holder's.
    pub fn release(self) {
        for held in self.held.into_iter().rev() {
            // The stamp only says who held the lock; one a failed removal
            // leaves behind misleads as a crash's would, until the next
            // holder writes its own.
            let _ = remove_file(&held.stamp);
        }
    }
}

/// Takes every lock of `targets`, in the order of their lock files, so two
/// takers of the same locks never wait on each other; each lock gets its own
/// stall budget. On any failure the locks already taken are released.
pub(crate) fn acquire(targets: &[(&Path, &Resource<'_>)]) -> Result<Lease, StorageError> {
    take_all(targets, None)
}

/// Takes the one lock of `resource` under `root` as [`acquire`] does, but
/// gives up at `deadline` if its stall budget has not run out first, and
/// never takes it once `deadline` has passed: the work it guards would
/// land after its caller stopped waiting for it.
pub(crate) fn acquire_before(
    root: &Path,
    resource: &Resource<'_>,
    deadline: Instant,
) -> Result<Lease, StorageError> {
    take_all(&[(root, resource)], Some(deadline))
}

fn take_all(
    targets: &[(&Path, &Resource<'_>)],
    deadline: Option<Instant>,
) -> Result<Lease, StorageError> {
    let mut locks: Vec<Lock> = targets
        .iter()
        .map(|(root, resource)| Lock::new(root, resource))
        .collect();

    locks.sort_by(|left, right| left.file.cmp(&right.file));
    locks.dedup_by(|left, right| left.file == right.file);

    let mut lease = Lease { held: Vec::new() };

    for lock in locks {
        match lock.take(deadline) {
            Ok(held) => lease.held.push(held),
            Err(error) => {
                lease.release();
                return Err(error);
            }
        }
    }

    Ok(lease)
}

/// Runs `work` holding the one lock of `resource` under `root`, and
/// releases it whatever `work` comes to.
pub(crate) fn with_lock<T>(
    root: &Path,
    resource: &Resource<'_>,
    work: impl FnOnce() -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    let lease = acquire(&[(root, resource)])?;
    let result = work();

    lease.release();
    result
}

struct Lock {
    root: PathBuf,
    key: String,
    file: PathBuf,
    stamp: PathBuf,
    budget: Duration,
    busy: BusyCode,
}

/// Who holds a lock, as its stamp says.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stamp<'a> {
    resource_key: &'a str,
    nonce: &'a str,
    pid: u32,
    acquired_at: Timestamp,
}

impl Lock {
    fn new(root: &Path, resource: &Resource<'_>) -> Self {
        let key = resource.key();
        let name = sha256_hex(key.as_bytes());

        Self {
            root: root.to_path_buf(),
            file: root.join(format!("{name}.lock")),
            stamp: root.join(format!("{name}.owner.json")),
            key,
            budget: resource.stall_budget(),
            busy: resource.busy(),
        }
    }

    /// The budget measures a stall, not a queue: it starts again whenever
    /// the lock changes hands while this taker waits.
    fn take(self, deadline: Option<Instant>) -> Result<Held, StorageError> {
        create_directories(&self.root).map_err(StorageError::write(&self.root))?;

        let mut holder = self.holder();
        let mut stalled_since = Instant::now();

        loop {
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return Err(self.refused());
            }

            if let Some(lock) =
                try_lock_file(&self.file).map_err(StorageError::write(&self.file))?
            {
                self.stamp_holder();
                return Ok(Held {
                    stamp: self.stamp,
                    _lock: lock,
                });
            }

            let now_held_by = self.holder();

            if now_held_by.is_some() && now_held_by != holder {
                holder = now_held_by;
                stalled_since = Instant::now();
            }

            let stalled = stalled_since.elapsed();

            if stalled >= self.budget {
                return Err(self.refused());
            }

            let mut wait = retry_delay().min(self.budget.saturating_sub(stalled));

            if let Some(deadline) = deadline {
                wait = wait.min(deadline.saturating_duration_since(Instant::now()));
            }

            thread::sleep(wait);
        }
    }

    fn refused(self) -> StorageError {
        StorageError::Busy {
            resource: self.key,
            code: self.busy,
        }
    }

    fn holder(&self) -> Option<String> {
        let bytes = read_file(&self.stamp).ok()?;
        let stamp: Value = serde_json::from_slice(&bytes).ok()?;

        stamp.get("nonce")?.as_str().map(str::to_owned)
    }

    /// Only the holder writes its stamp, and nothing is decided by it, so
    /// it is written as a note: neither replaced atomically nor flushed, and
    /// a stamp that cannot be written leaves the lock held all the same. A
    /// reader that meets half of one reads no holder.
    fn stamp_holder(&self) {
        let nonce = Uuid::new_v4().to_string();
        let stamp = Stamp {
            resource_key: &self.key,
            nonce: &nonce,
            pid: process::id(),
            acquired_at: Timestamp::now(),
        };
        let mut bytes =
            serde_json::to_vec(&stamp).expect("a stamp of plain fields always serializes");

        bytes.push(b'\n');

        let _ = remove_file(&self.stamp);
        let _ = create_new_file(&self.stamp, &bytes);
    }
}

/// Between 10 and 100 ms, at random, so waiters do not move in step.
fn retry_delay() -> Duration {
    let random = Uuid::new_v4().as_bytes()[0];

    Duration::from_millis(10 + u64::from(random) % 91)
}

#[cfg(test)]
#[expect(
    clippy::disallowed_methods,
    reason = "a test writes and reads the locks' files as another process or a crash would"
)]
mod tests {
    use std::process::Child;

    use p02_shared::{DanglingLinks, canonical_path, temporary_target, write_file_atomically};

    use super::*;
    use crate::test_process;

    fn temp_root() -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let root = canonical_path(directory.path(), DanglingLinks::Keep).unwrap();

        (directory, root)
    }

    fn session() -> SessionId {
        SessionId::parse("conv_a.1").unwrap()
    }

    fn resource_named<'a>(key: &str, session: &'a SessionId) -> Resource<'a> {
        match key {
            "session-catalog" => Resource::SessionCatalog,
            _ => Resource::SessionWriter(session),
        }
    }

    /// Not a test of its own: the second process of the tests below. It
    /// takes the lock its parent names, says so, and holds it until its
    /// parent closes its input, or kills it.
    #[test]
    fn a_lock_holder_for_another_process() {
        let Some(brief) = test_process::brief() else {
            return;
        };
        let (root, key) = brief.split_once('\n').unwrap();
        let session = session();
        let lease = acquire(&[(Path::new(root), &resource_named(key, &session))]).unwrap();

        // A write begun and never finished, as a holder killed mid-write
        // leaves it.
        std::fs::write(
            Path::new(root).join(format!(".sessions.jsonl.{}.tmp", Uuid::new_v4())),
            "half a catal",
        )
        .unwrap();
        test_process::ready_then_wait();
        lease.release();
    }

    fn holder(root: &Path, key: &str) -> Child {
        test_process::spawn(
            "lock::tests::a_lock_holder_for_another_process",
            &format!("{}\n{key}", root.display()),
        )
    }

    fn stamps_in(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.ends_with(".owner.json"))
            .collect();

        names.sort();
        names
    }

    #[test]
    fn every_lock_keeps_the_key_the_wait_and_the_report_of_its_kind() {
        let (_directory, root) = temp_root();
        let conversation = ConversationId::new("conv_a").unwrap();
        let session = session();
        let plugin = root.join("plugin-data").join("character-state");
        let plugin_key = format!("plugin:{}", plugin.display());
        let settings = root.join("config.json");
        let settings_key = format!("runtime-control-file:{}", settings.display());
        let instant = Duration::ZERO;
        let waited = Duration::from_secs(10);

        for (resource, key, budget, busy) in [
            (Resource::Daemon, "daemon", instant, BusyCode::Storage),
            (
                Resource::ConversationsCatalog,
                "conversations-catalog",
                waited,
                BusyCode::Storage,
            ),
            (
                Resource::ConversationWriter(&conversation),
                "conversation-writer:conv_a",
                instant,
                BusyCode::Storage,
            ),
            (
                Resource::StorageSchema,
                "storage-schema",
                waited,
                BusyCode::Storage,
            ),
            (
                Resource::SessionCatalog,
                "session-catalog",
                waited,
                BusyCode::Storage,
            ),
            (Resource::Inbox, "inbox", waited, BusyCode::Storage),
            (
                Resource::SessionWriter(&session),
                "session-writer:conv_a.1",
                instant,
                BusyCode::Session,
            ),
            (
                Resource::PluginFiles(&plugin),
                plugin_key.as_str(),
                Duration::from_secs(2),
                BusyCode::Storage,
            ),
            (
                Resource::SettingsDocument {
                    path: &settings,
                    wait: Duration::from_millis(500),
                },
                settings_key.as_str(),
                Duration::from_millis(500),
                BusyCode::Storage,
            ),
        ] {
            let lock = Lock::new(&root, &resource);

            assert_eq!(
                (lock.key.as_str(), lock.budget, lock.busy),
                (key, budget, busy)
            );
        }

        assert_eq!(
            Lock::new(&root, &Resource::Daemon).file,
            root.join("f77b12a53ece5f6b7050800bbdbf8cc5ebe87f1b1387cf739f243e43e2ce886b.lock")
        );
    }

    #[test]
    fn a_held_lock_is_refused_to_every_other_taker_and_its_stamp_goes_with_it() {
        let (_directory, root) = temp_root();
        let session = session();
        let writer = Resource::SessionWriter(&session);
        let lease = acquire(&[(&root, &writer)]).unwrap();
        let stamp: Value =
            serde_json::from_slice(&std::fs::read(root.join(&stamps_in(&root)[0])).unwrap())
                .unwrap();

        assert_eq!(stamp["resourceKey"], "session-writer:conv_a.1");
        assert_eq!(stamp["pid"], process::id());
        assert!(matches!(
            acquire(&[(&root, &writer)]),
            Err(StorageError::Busy {
                code: BusyCode::Session,
                ..
            })
        ));

        lease.release();
        assert_eq!(stamps_in(&root), Vec::<String>::new());
        acquire(&[(&root, &writer)]).unwrap().release();
    }

    #[test]
    fn a_lock_another_process_holds_is_busy_until_it_lets_go() {
        let (_directory, root) = temp_root();
        let session = session();
        let mut child = holder(&root, "session-writer");

        assert!(matches!(
            acquire(&[(&root, &Resource::SessionWriter(&session))]),
            Err(StorageError::Busy {
                code: BusyCode::Session,
                ..
            })
        ));

        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
        acquire(&[(&root, &Resource::SessionWriter(&session))])
            .unwrap()
            .release();
    }

    /// The kernel lets a dead holder's lock go: the next taker has it, and
    /// the next guarded write sweeps what the holder was writing.
    #[test]
    fn a_holder_killed_mid_write_leaves_its_lock_to_the_next_taker() {
        let (_directory, root) = temp_root();
        let mut child = holder(&root, "session-catalog");

        child.kill().unwrap();
        child.wait().unwrap();

        with_lock(&root, &Resource::SessionCatalog, || {
            write_file_atomically(&root.join("sessions.jsonl"), b"")
                .map_err(StorageError::write(&root))
        })
        .unwrap();

        let mut residue: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| temporary_target(name.as_ref()).is_some())
            .collect();

        residue.sort();
        assert_eq!(residue, Vec::<String>::new());
    }

    /// A waiter's budget is for a holder that makes no progress: while the
    /// stamp shows the lock changing hands, it waits on.
    #[test]
    fn a_waiter_waits_out_a_lock_changing_hands_and_gives_up_on_a_stalled_one() {
        let (_directory, root) = temp_root();
        let budget = Duration::from_millis(1_500);
        let waiter = |root: &Path| {
            let mut lock = Lock::new(root, &Resource::SessionCatalog);

            lock.budget = budget;
            lock.take(None)
        };
        let held = acquire(&[(&root, &Resource::SessionCatalog)]).unwrap();
        let stamp = Lock::new(&root, &Resource::SessionCatalog).stamp;
        let started = Instant::now();

        assert!(matches!(waiter(&root), Err(StorageError::Busy { .. })));
        assert!(started.elapsed() >= budget);

        let handing_on = std::thread::spawn({
            let stamp = stamp.clone();

            move || {
                for _ in 0..40 {
                    std::fs::write(&stamp, format!(r#"{{"nonce":"{}"}}"#, Uuid::new_v4())).unwrap();
                    std::thread::sleep(Duration::from_millis(50));
                }

                held.release();
            }
        });
        let since = Instant::now();

        drop(waiter(&root).unwrap());
        assert!(since.elapsed() > budget, "{:?}", since.elapsed());
        handing_on.join().unwrap();
    }

    #[test]
    fn locks_taken_together_are_taken_in_file_order_and_none_is_kept_when_one_is_busy() {
        let (_directory, root) = temp_root();
        let first = SessionId::parse("conv_a.1").unwrap();
        let second = SessionId::parse("conv_b.1").unwrap();
        let mut files: Vec<(PathBuf, &SessionId)> = [&first, &second]
            .into_iter()
            .map(|id| (Lock::new(&root, &Resource::SessionWriter(id)).file, id))
            .collect();

        files.sort();

        let (later, earlier) = (files[1].1, files[0].1);
        let busy = acquire(&[(&root, &Resource::SessionWriter(later))]).unwrap();

        assert!(matches!(
            acquire(&[
                (&root, &Resource::SessionWriter(later)),
                (&root, &Resource::SessionWriter(earlier)),
            ]),
            Err(StorageError::Busy { .. })
        ));
        acquire(&[(&root, &Resource::SessionWriter(earlier))])
            .unwrap()
            .release();
        busy.release();

        let both = acquire(&[
            (&root, &Resource::SessionWriter(later)),
            (&root, &Resource::SessionWriter(earlier)),
            (&root, &Resource::SessionWriter(later)),
        ])
        .unwrap();
        let held: Vec<&PathBuf> = both.held.iter().map(|held| &held.stamp).collect();

        assert_eq!(
            held,
            [
                &Lock::new(&root, &Resource::SessionWriter(earlier)).stamp,
                &Lock::new(&root, &Resource::SessionWriter(later)).stamp,
            ]
        );
        both.release();
    }
}
