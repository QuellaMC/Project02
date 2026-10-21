//! The second process of the tests that need one: this test binary run
//! again for one test, which reads its brief from the environment, does
//! what it says, tells its parent so, and holds what it took until the
//! parent closes its input or kills it.

use std::io::{BufRead as _, BufReader, Write as _};
use std::process::{Child, Command, Stdio};

/// What the second process is asked to do.
const BRIEF: &str = "P02_STORE_TEST_BRIEF";
/// What the second process says once it has done it.
const READY: &str = "P02_STORE_TEST_READY";

/// Runs `test`, a test of this binary, as a second process given `brief`,
/// and returns it once it says it is ready.
pub(crate) fn spawn(test: &str, brief: &str) -> Child {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture", "--test-threads=1"])
        .env(BRIEF, brief)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();

    assert!(
        lines.any(|line| line.unwrap() == READY),
        "the second process said nothing"
    );
    // The second process writes on until it exits, and a closed pipe would
    // fail it.
    std::thread::spawn(move || lines.for_each(drop));
    child
}

/// The brief of the second process; `None` in an ordinary run, where the
/// test that plays the second process does nothing.
pub(crate) fn brief() -> Option<String> {
    std::env::var(BRIEF).ok()
}

/// Tells the parent the second process is ready, then waits until the
/// parent closes its input.
pub(crate) fn ready_then_wait() {
    // On a line of its own: the test runner may have begun one.
    println!("\n{READY}");
    std::io::stdout().flush().unwrap();
    std::io::stdin().read_line(&mut String::new()).unwrap();
}
