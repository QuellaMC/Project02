//! The runner on a temporary home, with no window and the test provider
//! off: the daemon and the connector started and stopped in their order, a
//! home the store refuses, and a home another daemon holds.
#![expect(
    clippy::unwrap_used,
    reason = "a test, and the world it builds, fail by panicking, as in the unit tests"
)]

use std::path::{Path, PathBuf};
use std::sync::mpsc::RecvTimeoutError;
use std::thread;
use std::time::{Duration, Instant};

use p02_shared::{
    DanglingLinks, canonical_path, create_directories, create_new_file, http_client,
    read_daemon_record, read_text_lossy,
};
use project02_shell::run::{CONNECTOR_GRACE, CONNECTOR_LOG, DAEMON_LOG, start};
use tempfile::TempDir;

/// How long a test waits for what it expects before it fails.
const PATIENCE: Duration = Duration::from_secs(60);

/// A folder of the test's own, spelled canonically as the daemon spells its
/// home, for the home and the logs; it goes with the test.
struct World {
    _directory: TempDir,
    root: PathBuf,
}

impl World {
    fn new() -> Self {
        let directory = TempDir::new().unwrap();
        let root = canonical_path(directory.path(), DanglingLinks::Keep).unwrap();

        Self {
            _directory: directory,
            root,
        }
    }

    fn home(&self) -> PathBuf {
        self.root.join("home")
    }

    /// The logs folder `name`, one for each start.
    fn logs(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
}

/// The origin and the token of the address a daemon says.
fn parts(address: &str) -> (&str, &str) {
    address
        .split_once("/#token=")
        .expect("an address holds its token in the fragment")
}

/// The status `GET /api/health` answers with the address's token.
fn health(address: &str) -> u16 {
    let (origin, token) = parts(address);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();

    runtime.block_on(async {
        http_client()
            .build()
            .unwrap()
            .get(format!("{origin}/api/health"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    })
}

/// Waits until the log at `path` holds `line`.
fn wait_for_line(path: &Path, line: &str) {
    let deadline = Instant::now() + PATIENCE;

    while !read_text_lossy(path)
        .unwrap_or_default()
        .lines()
        .any(|said| said == line)
    {
        assert!(
            Instant::now() < deadline,
            "{} never said {line:?}",
            path.display()
        );
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn the_daemon_serves_and_the_connector_follows_until_the_stop_ends_both_within_their_graces() {
    let world = World::new();
    let logs = world.logs("logs");
    let (running, address) = start(world.home(), &logs).unwrap();
    let address = address
        .recv_timeout(PATIENCE)
        .expect("the daemon says its address");
    let (origin, _) = parts(&address);
    let record = read_daemon_record(&world.home()).unwrap().unwrap();

    assert_eq!(
        record.running.map(|run| run.pid.get()),
        Some(std::process::id())
    );
    assert_eq!(health(&address), 200);
    wait_for_line(
        &logs.join(CONNECTOR_LOG),
        &format!("Telegram connector: connected to {origin}."),
    );

    let stopping = Instant::now();

    running.stop();

    let stopped = stopping.elapsed();

    assert!(stopped < CONNECTOR_GRACE, "the stop took {stopped:?}");
    assert_eq!(
        read_daemon_record(&world.home()).unwrap().unwrap().running,
        None
    );
}

#[test]
fn a_home_the_store_refuses_ends_the_address_channel_empty_with_the_reason_in_the_daemons_log() {
    let world = World::new();
    let home = world.home();
    let logs = world.logs("logs");

    create_directories(&home).unwrap();
    create_new_file(&home.join("notes.txt"), b"mine").unwrap();

    let (running, address) = start(home, &logs).unwrap();

    assert_eq!(
        address.recv_timeout(PATIENCE),
        Err(RecvTimeoutError::Disconnected)
    );

    let log = read_text_lossy(&logs.join(DAEMON_LOG)).unwrap();

    assert!(
        log.lines()
            .any(|line| line.starts_with("Error: ") && line.contains("\"notes.txt\"")),
        "{log}"
    );

    running.stop();
}

#[test]
fn a_start_on_a_home_another_daemon_holds_hands_over_and_its_stop_leaves_that_one_serving() {
    let world = World::new();
    let (first, first_address) = start(world.home(), &world.logs("first")).unwrap();
    let first_address = first_address
        .recv_timeout(PATIENCE)
        .expect("the first daemon says its address");
    let (second, second_address) = start(world.home(), &world.logs("second")).unwrap();

    assert_eq!(
        second_address.recv_timeout(PATIENCE),
        Ok(first_address.clone())
    );

    second.stop();

    assert_eq!(health(&first_address), 200);

    first.stop();
}
