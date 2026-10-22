//! The one place a store is born, before anything else is written: a
//! directory that holds nothing yet becomes one only with the person's
//! consent, `--init` or a yes at the terminal. A directory that holds
//! anything is the store's to adopt or refuse when the home is claimed.

use std::io::{self, BufRead as _, IsTerminal as _};
use std::time::Duration;

use p02_config::create_home_document;
use p02_shared::list_directory;
use p02_store::{Home, StorageError};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::Console;

/// Why there is no store to serve.
#[derive(Debug)]
pub(crate) enum Unconsented {
    /// The person did not agree, or could not be asked; the sentence says
    /// what to do.
    Declined(String),
    /// The store refused to be made, or a write failed.
    Unmade(StorageError),
}

/// Makes the store `home` names when its directory holds nothing yet and
/// the person consents: the store's marker and data directory, and the
/// home's settings document as a new home holds it, its lock waited for up
/// to `settings_wait`. A stop while the person is asked is a no.
pub(crate) async fn ensure_store(
    home: &Home,
    init: bool,
    settings_wait: Duration,
    stop: &CancellationToken,
    console: &mut Console,
) -> Result<(), Unconsented> {
    if !holds_nothing(home) {
        return Ok(());
    }

    let root = home.root().display();

    if !init
        && !agrees(
            &format!("No Project02 store at \"{root}\". Create one there? [y/N] "),
            stop,
            console,
        )
        .await
    {
        return Err(Unconsented::Declined(format!(
            "No Project02 store at \"{root}\". Re-run with --init to create one there, or pass \
             --store to point at an existing store."
        )));
    }

    home.ensure().map_err(Unconsented::Unmade)?;
    create_home_document(home, settings_wait).map_err(Unconsented::Unmade)
}

/// Whether making a store there would make one out of nothing: the
/// directory is not there, or is empty.
fn holds_nothing(home: &Home) -> bool {
    match list_directory(home.root()) {
        Ok(entries) => entries.is_empty(),
        Err(error) => error.kind() == io::ErrorKind::NotFound,
    }
}

/// Whether the person answers `question` yes at the terminal. Nobody is
/// asked when serve has no terminal, as under a script or a service
/// manager, and silence, a terminal that went away or a stop is a no.
async fn agrees(question: &str, stop: &CancellationToken, console: &mut Console) -> bool {
    if !io::stdin().is_terminal() {
        return false;
    }

    console.ask(question);

    let (answered, answer) = oneshot::channel();
    // A read of the terminal cannot be called off: one a stop overtakes
    // ends with the process.
    let reading = std::thread::Builder::new().spawn(move || {
        let mut line = String::new();
        let read = io::stdin().lock().read_line(&mut line);

        let _ = answered.send(read.map(|_| line));
    });
    let line = match reading {
        Ok(_) => tokio::select! {
            biased;
            () = stop.cancelled() => None,
            answer = answer => answer.ok().and_then(Result::ok),
        },
        Err(_) => None,
    };

    // The person's own line ends the question's; anything else would leave
    // what serve says next beside it.
    if !line.as_deref().is_some_and(|line| line.ends_with('\n')) {
        console.say("");
    }

    line.is_some_and(|line| matches!(line.trim().to_lowercase().as_str(), "y" | "yes"))
}
