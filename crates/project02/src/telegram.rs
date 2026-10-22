//! The telegram command: the connector beside the daemon, a client of its
//! socket, on a runtime of its own until the stop.

use std::env;
use std::io::{self, Write as _};
use std::process::ExitCode;
use std::sync::Arc;

use p02_shared::error_sentence;
use p02_telegram::{Ended, Lines, Options};

use crate::flags::TelegramFlags;
use crate::stop::listen_for_stop;
use crate::switches::{self, TEST_DURATIONS, TEST_TELEGRAM_API};
use crate::{Console, home_of, on_runtime};

/// Runs the connector until the stop: exit code 0, or 1 when its switches
/// refuse the start, or when it could not go on, which it says on stderr.
pub(crate) fn run(flags: TelegramFlags, console: &mut Console) -> ExitCode {
    let switches = match switches::telegram(
        env::var_os(TEST_DURATIONS).as_deref(),
        env::var_os(TEST_TELEGRAM_API).as_deref(),
    ) {
        Ok(switches) => switches,
        Err(refused) => {
            console.warn(&refused.to_string());
            return ExitCode::FAILURE;
        }
    };
    let home = match home_of(flags.store) {
        Ok(home) => home,
        Err(error) => return console.failed(&error_sentence(&error)),
    };
    let mut options = Options::new(home.root().to_path_buf());

    if let Some(telegram) = switches.telegram {
        options.telegram = telegram;
    }

    if let Some(draft_edits) = switches.draft_edits {
        options.draft_edits = draft_edits;
    }

    let ended = on_runtime(async {
        let stop = listen_for_stop()?;

        io::Result::Ok(p02_telegram::run(options, Arc::new(Terminal), stop).await)
    });

    match ended {
        Ok(Ok(Ended::Stopped)) => ExitCode::SUCCESS,
        Ok(Ok(Ended::Failed)) => ExitCode::FAILURE,
        Ok(Err(error)) | Err(error) => console.failed(&error),
    }
}

/// The connector's lines, on the terminal it runs in.
#[derive(Debug)]
struct Terminal;

impl Lines for Terminal {
    fn say(&self, line: &str) {
        let _ = writeln!(io::stdout(), "{line}");
    }

    fn report(&self, line: &str) {
        let _ = writeln!(io::stderr(), "{line}");
    }
}
