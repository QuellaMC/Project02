#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod consent;
mod flags;
mod handover;
mod inspect;
mod serve;
mod stop;
mod switches;
mod telegram;

use std::env;
use std::ffi::OsString;
use std::fmt::Display;
use std::future::Future;
use std::io::{self, Write as _};
use std::path::PathBuf;
use std::process::ExitCode;

use p02_app::PackageReport;
use p02_shared::{DEFAULT_HOME, DanglingLinks, ResolvePathError, canonical_path};
use p02_store::Home;

use crate::flags::{Command, ServeFlags};

fn main() -> ExitCode {
    let mut console = Console {
        out: io::stdout(),
        err: io::stderr(),
    };
    let args: Vec<OsString> = env::args_os().skip(1).collect();

    match flags::read(&args) {
        Ok(Command::Serve(flags)) => serve(flags, &mut console),
        Ok(Command::Inspect(flags)) => inspect::run(flags, &mut console),
        Ok(Command::Telegram(flags)) => telegram::run(flags, &mut console),
        Err(usage) => console.failed(&usage),
    }
}

/// The daemon, on a runtime of its own, once its switches are read.
fn serve(flags: ServeFlags, console: &mut Console) -> ExitCode {
    let switches = match switches::read(
        env::var_os(switches::TEST_PROVIDER).as_deref(),
        env::var_os(switches::TEST_DURATIONS).as_deref(),
    ) {
        Ok(switches) => switches,
        Err(refused) => return console.failed(&refused),
    };

    match on_runtime(serve::run(flags, switches, console)) {
        Ok(code) => code,
        Err(error) => console.failed(&error),
    }
}

/// Runs `work` to its end on a runtime of its own. Whatever then still runs
/// on the blocking pool, such as a name lookup, is nothing the command
/// waited for, so the exit does not wait for it either.
pub(crate) fn on_runtime<T>(work: impl Future<Output = T>) -> io::Result<T> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let output = runtime.block_on(work);

    runtime.shutdown_background();
    Ok(output)
}

/// The home `store` names, or `.project02` in the working directory, bound
/// to its real path, so a link that later points elsewhere cannot move a
/// running home, nor what a report says it read.
pub(crate) fn home_of(store: Option<PathBuf>) -> Result<Home, ResolvePathError> {
    let path = store.unwrap_or_else(|| PathBuf::from(DEFAULT_HOME));

    canonical_path(&path, DanglingLinks::Follow).map(Home::new)
}

/// A package discovery could not publish, where and why.
pub(crate) fn package_problem(package: &PackageReport) -> String {
    format!(
        "Character package {} ({}): {}",
        package.path, package.code, package.message
    )
}

/// Where the command speaks: stdout carries the address and what a person
/// reads of the run, stderr every problem. One that stopped listening
/// stops nothing, so what it would have read is let go.
#[derive(Debug)]
pub(crate) struct Console {
    out: io::Stdout,
    err: io::Stderr,
}

impl Console {
    pub(crate) fn say(&mut self, line: &str) {
        let _ = writeln!(self.out, "{line}");
    }

    /// A question, the answer typed on its line.
    pub(crate) fn ask(&mut self, question: &str) {
        let _ = write!(self.out, "{question}");
        let _ = self.out.flush();
    }

    pub(crate) fn warn(&mut self, line: &str) {
        let _ = writeln!(self.err, "{line}");
    }

    /// Says why the command ends here.
    pub(crate) fn failed(&mut self, why: &dyn Display) -> ExitCode {
        self.warn(&format!("Error: {why}"));
        ExitCode::FAILURE
    }
}
