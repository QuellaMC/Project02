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
use std::future::Future;
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

/// The binary: the command line `args`, the program's name left out, run
/// to its end on the terminal.
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

/// The daemon as the binary runs it: on the switches its environment sets,
/// until the process is signalled.
fn serve_until_signalled(flags: ServeFlags, console: &mut Console) -> ExitCode {
    match switches::read(
        env::var_os(switches::TEST_PROVIDER).as_deref(),
        env::var_os(switches::TEST_DURATIONS).as_deref(),
    ) {
        Ok(switches) => serve(flags, switches, console, stop::listen_for_stop),
        Err(refused) => console.failed(&refused),
    }
}

/// The daemon, on a runtime of its own, until the stop `stop` makes on that
/// runtime: the process's signals for the binary, or a token its caller
/// cancels for a program that runs the daemon in its own process. What it
/// says goes to `console`, the address on a line that begins with
/// [`ADDRESS_PREFIX`].
pub fn serve(
    flags: ServeFlags,
    switches: Switches,
    console: &mut Console,
    stop: impl FnOnce() -> io::Result<CancellationToken>,
) -> ExitCode {
    match on_runtime(serve::run(flags, switches, console, stop)) {
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

/// Where a command speaks: `out` carries the address and what a person
/// reads of the run, `err` every problem. Each line is handed on as it is
/// said, since a program's writer, unlike a terminal, may keep it back
/// until flushed. A writer that stopped listening stops nothing, so what
/// it would have read is let go.
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

    /// The two streams a program keeps the lines in, such as its log files.
    #[must_use]
    pub fn new(out: impl Write + Send + 'static, err: impl Write + Send + 'static) -> Self {
        Self {
            out: Box::new(out),
            err: Box::new(err),
        }
    }

    pub(crate) fn say(&mut self, line: &str) {
        deliver(self.out.as_mut(), format_args!("{line}\n"));
    }

    /// A question, the answer typed on its line.
    pub(crate) fn ask(&mut self, question: &str) {
        deliver(self.out.as_mut(), format_args!("{question}"));
    }

    pub(crate) fn warn(&mut self, line: &str) {
        deliver(self.err.as_mut(), format_args!("{line}\n"));
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

fn deliver(stream: &mut dyn Write, text: fmt::Arguments<'_>) {
    let _ = stream.write_fmt(text);
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead as _, BufReader, BufWriter};
    use std::sync::{Arc, Mutex};
    use std::thread;

    use p02_shared::{http_client, read_daemon_record};
    use reqwest::StatusCode;

    use super::*;

    /// lifecycle.serve-in-a-program: A program that runs the daemon in its own process, on a console and a stop token of its own, finds the address on that console's out, on the line that begins with `ADDRESS_PREFIX`, and the daemon answers there with its token; cancelling the token ends serve with exit 0, daemon.json no longer naming a running process.
    #[test]
    fn a_program_runs_the_daemon_on_its_own_console_until_it_cancels_the_stop() {
        let home = tempfile::tempdir().unwrap();
        let (said, out) = io::pipe().unwrap();
        let stop = CancellationToken::new();
        let serving = thread::spawn({
            let flags = ServeFlags {
                store: Some(home.path().to_path_buf()),
                init: true,
            };
            let stop = stop.clone();

            move || {
                let mut console = Console::new(out, io::stderr());

                serve(flags, Switches::default(), &mut console, || Ok(stop))
            }
        });
        let mut lines = BufReader::new(said).lines().map_while(Result::ok);
        let address = lines
            .find_map(|line| line.strip_prefix(ADDRESS_PREFIX).map(str::to_owned))
            .expect("serve says its address");
        let (origin, token) = address.split_once("#token=").unwrap();
        let health = on_runtime(async {
            let response = http_client()
                .build()?
                .get(format!("{origin}api/health"))
                .bearer_auth(token)
                .send()
                .await?;

            reqwest::Result::Ok(response.status())
        });

        assert_eq!(health.unwrap().unwrap(), StatusCode::OK);

        stop.cancel();

        assert_eq!(serving.join().unwrap(), ExitCode::SUCCESS);
        assert_eq!(
            read_daemon_record(home.path()).unwrap().unwrap().running,
            None
        );
    }

    /// What a program's writer was given, read while the console holds it.
    #[derive(Clone, Default)]
    struct Kept(Arc<Mutex<Vec<u8>>>);

    impl Kept {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    impl Write for Kept {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn each_line_reaches_a_writer_that_buffers_as_it_is_said() {
        let (out, err) = (Kept::default(), Kept::default());
        let mut console = Console::new(BufWriter::new(out.clone()), BufWriter::new(err.clone()));

        console.say("Said.");
        console.warn("Warned.");

        assert_eq!(out.text(), "Said.\n");
        assert_eq!(err.text(), "Warned.\n");
    }
}
