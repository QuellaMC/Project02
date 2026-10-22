#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod consent;
mod flags;
mod handover;
mod serve;
mod switches;

use std::env;
use std::ffi::OsString;
use std::fmt::Display;
use std::io::{self, Write as _};
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut console = Console {
        out: io::stdout(),
        err: io::stderr(),
    };
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let flags = match flags::read(&args) {
        Ok(flags) => flags,
        Err(usage) => return console.failed(&usage),
    };
    let switches = match switches::read(
        env::var_os(switches::TEST_PROVIDER).as_deref(),
        env::var_os(switches::TEST_DURATIONS).as_deref(),
    ) {
        Ok(switches) => switches,
        Err(refused) => return console.failed(&refused),
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => return console.failed(&error),
    };
    let code = runtime.block_on(serve::run(flags, switches, &mut console));

    // Whatever still runs on the blocking pool is nothing the stop waited
    // for, so the exit does not wait for it either.
    runtime.shutdown_background();
    code
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
