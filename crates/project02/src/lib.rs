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
use std::fmt::{self, Display};
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use p02_app::PackageReport;
use p02_shared::{DEFAULT_HOME, DanglingLinks, ResolvePathError, canonical_path};
use p02_store::Home;
use tokio_util::sync::CancellationToken;

use crate::flags::Command;

pub use crate::flags::ServeFlags;
pub use crate::serve::ADDRESS_PREFIX;
pub use crate::switches::Switches;

/// The command line `args` names, the program's own name left out, run to
/// its end.
#[must_use]
pub fn run(args: &[OsString]) -> ExitCode {
    let mut console = Console::terminal();

    match flags::read(args) {
        Ok(Command::Serve(flags)) => serve_until_signalled(flags, &mut console),
        Ok(Command::Inspect(flags)) => inspect::run(flags, &mut console),
        Ok(Command::Telegram(flags)) => telegram::run(flags, &mut console),
        Err(usage) => console.failed(&usage),
    }
}

/// The daemon as the binary runs it: its switches read, until the process
/// is signalled.
fn serve_until_signalled(flags: ServeFlags, console: &mut Console) -> ExitCode {
    match switches::read(
        env::var_os(switches::TEST_PROVIDER).as_deref(),
        env::var_os(switches::TEST_DURATIONS).as_deref(),
    ) {
        Ok(switches) => serve(flags, switches, console, stop::listen_for_stop),
        Err(refused) => console.failed(&refused),
    }
}

/// The daemon, on a runtime of its own, until the stop `stop` makes on it:
/// the process's signals for the binary, or a token its caller cancels for
/// a program that runs the daemon in its own process.
pub fn serve(
    flags: ServeFlags,
    switches: Switches,
    console: &mut Console,
    stop: impl FnOnce() -> io::Result<CancellationToken>,
) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => return console.failed(&error),
    };
    let code = runtime.block_on(async {
        match stop() {
            Ok(stop) => serve::run(flags, switches, &stop, console).await,
            Err(error) => serve::failed(console, &error),
        }
    });

    // Whatever still runs on the blocking pool is nothing the stop waited
    // for, so the exit does not wait for it either.
    runtime.shutdown_background();
    code
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

/// Where a command speaks: `out` carries the address and what a person
/// reads of the run, `err` every problem. One that stopped listening stops
/// nothing, so what it would have read is let go.
pub struct Console {
    out: Box<dyn Write + Send>,
    err: Box<dyn Write + Send>,
}

impl Console {
    /// The terminal the command runs in: stdout and stderr.
    #[must_use]
    pub fn terminal() -> Self {
        Self::new(io::stdout(), io::stderr())
    }

    /// The lines on `out` and `err`, wherever the caller keeps them.
    #[must_use]
    pub fn new(out: impl Write + Send + 'static, err: impl Write + Send + 'static) -> Self {
        Self {
            out: Box::new(out),
            err: Box::new(err),
        }
    }

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

impl fmt::Debug for Console {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Console").finish_non_exhaustive()
    }
}
