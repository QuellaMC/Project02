//! The serve command: its home found, a store made there when the person
//! consents, the home claimed or handed over, then the daemon on its
//! socket until the stop, which runs in the order that loses nothing and
//! lets the home go last.

use std::error::Error;
use std::io;
use std::num::NonZeroU16;
use std::process::ExitCode;

use p02_app::{Daemon, DaemonSettings, Plugin};
use p02_gateway::{Claim, ClaimOutcome, Server};
use p02_role_model::select_adapter;
use p02_shared::{DaemonToken, error_sentence};
use p02_store::Home;
use p02_wire::{Event, Health};
use tokio_util::sync::CancellationToken;

use crate::consent::{self, Unconsented};
use crate::flags::ServeFlags;
use crate::handover::{self, HandedOver};
use crate::switches::Switches;
use crate::{Console, home_of, package_problem};

/// What the line a client finds a daemon by begins with.
pub const ADDRESS_PREFIX: &str = "PROJECT02_GATEWAY=";

pub(crate) async fn run(
    flags: ServeFlags,
    switches: Switches,
    console: &mut Console,
    stop: impl FnOnce() -> io::Result<CancellationToken>,
) -> ExitCode {
    let stop = match stop() {
        Ok(stop) => stop,
        Err(error) => return failed(console, &error),
    };
    let plugins = match p02_plugins::list::plugins() {
        Ok(listed) => listed
            .iter()
            .map(|(manifest, check, factory)| Plugin::new(manifest.clone(), *check, *factory))
            .collect(),
        Err(error) => return failed(console, error),
    };
    let test_provider = match select_adapter(switches.test_provider, None, None) {
        Ok(adapter) => adapter,
        Err(error) => return failed(console, &error),
    };
    let home = match home_of(flags.store) {
        Ok(home) => home,
        Err(error) => return failed(console, &error),
    };

    match consent::ensure_store(
        &home,
        flags.init,
        switches.durations.settings_lock,
        &stop,
        console,
    )
    .await
    {
        Ok(()) => {}
        Err(Unconsented::Declined(refusal)) => return console.failed(&refusal),
        Err(Unconsented::Unmade(error)) => return failed(console, &error),
    }

    let claim = match Claim::take(&home) {
        Ok(ClaimOutcome::Claimed(claim)) => claim,
        Ok(ClaimOutcome::Held { record }) => {
            match handover::hand_over(&home, record, &stop, console).await {
                HandedOver::Claimed(claim) => claim,
                HandedOver::Ended(code) => return code,
            }
        }
        Err(error) => return failed(console, &error),
    };
    let settings = DaemonSettings {
        test_provider,
        durations: switches.durations,
        plugins,
        app_catalog: switches.app_catalog,
        app_internet: switches.app_internet,
        openai_api: switches.openai_api,
    };

    serve(home, claim, settings, &stop, console).await
}

/// Says why serve ends before it served: what broke, then why.
pub(crate) fn failed(console: &mut Console, error: &(dyn Error + 'static)) -> ExitCode {
    console.failed(&error_sentence(error))
}

/// The line a client finds a daemon by, its address with the token in the
/// fragment: what serve prints once it can answer there, and what a second
/// serve hands back of the daemon that holds the home.
pub(crate) fn address_line(port: NonZeroU16, token: &DaemonToken) -> String {
    format!(
        "{ADDRESS_PREFIX}http://127.0.0.1:{port}/#token={}",
        token.as_str()
    )
}

/// The daemon on its socket, from the claim to the stop. Every failure on
/// the way unwinds the same way: what was started is stopped, and the
/// claim is released.
async fn serve(
    home: Home,
    mut claim: Claim,
    settings: DaemonSettings,
    stop: &CancellationToken,
    console: &mut Console,
) -> ExitCode {
    let daemon = match Daemon::open(home, settings).await {
        Ok(daemon) => daemon,
        Err(error) => {
            claim.release();
            return failed(console, &error);
        }
    };
    // Before anything starts, so no failure goes unsaid.
    let mut events = daemon.events();

    // The roster comes up behind the address, never awaited by it. Asked
    // for before the socket can take a request, the boot pass judges only
    // the characters it starts itself: one a client starts is the client's.
    tokio::spawn(daemon.reconcile());

    let server = match Server::bind(daemon.clone(), claim.token(), claim.port()).await {
        Ok(server) => server,
        Err(error) => {
            daemon.stop().await;
            claim.release();
            return failed(console, &error);
        }
    };
    let moved = match claim.publish(server.port()) {
        Ok(moved) => moved,
        Err(error) => {
            server.close().await;
            claim.release();
            return failed(console, &error);
        }
    };

    // A tab left open retries the old address and nothing can tell it; the
    // person can.
    if let Some(taken) = moved {
        console.say(&format!(
            "Port {taken} was taken by another program; the address has changed. Open tabs and \
             bookmarks need the new one."
        ));
    }

    console.say(&address_line(server.port(), claim.token()));
    report_startup_problems(&daemon.health().await, console);

    loop {
        tokio::select! {
            biased;
            () = stop.cancelled() => break,
            Some(event) = events.recv() => {
                report(&event, console);
            }
        }
    }

    // What was announced before the stop is no trouble of the stop's.
    while let Ok(event) = events.try_recv() {
        report(&event, console);
    }

    console.say("Stopping; finishing what is in flight.");

    let mut troubled = false;
    let mut closing = std::pin::pin!(server.close());

    loop {
        tokio::select! {
            () = &mut closing => break,
            Some(event) = events.recv() => troubled |= report(&event, console),
        }
    }

    while let Ok(event) = events.try_recv() {
        troubled |= report(&event, console);
    }

    claim.release();

    if troubled {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

/// What the roster cannot carry: a character package discovery could not
/// publish, which has no runtime to report itself and would otherwise go
/// unsaid.
fn report_startup_problems(health: &Health, console: &mut Console) {
    for package in &health.packages.diagnostics {
        console.warn(&package_problem(package));
    }
}

/// Says what a character's failure, or her work behind the conversation,
/// came to; true for a failure of hers.
fn report(event: &Event, console: &mut Console) -> bool {
    match event {
        Event::StateChanged {
            character_id,
            message: Some(message),
            ..
        } => {
            console.warn(&format!("{character_id}: {message}"));
            true
        }
        Event::MaintenanceFailed {
            character_id,
            failure,
        } => {
            console.warn(&format!("{character_id}: {}", failure.message));
            false
        }
        _ => false,
    }
}
