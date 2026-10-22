//! A second serve on a home another process holds, which is then a client
//! of the daemon there: it hands back that daemon's address when it
//! answers as this home's, the person wanted the app and has it. A holder
//! that does not answer is on its way out, since its socket closes before
//! its lease goes, on its way up, since its lease is taken before its
//! socket binds, or gone: for a while, every half second, the lease is
//! tried and the address asked again, so a stop then a start takes the
//! home over and a start twice hands the address back.

use std::error::Error;
use std::num::NonZeroU32;
use std::process::ExitCode;
use std::time::Duration;

use p02_gateway::{Claim, ClaimOutcome};
use p02_shared::{DaemonRecord, http_client};
use p02_store::Home;
use serde_json::Value;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::Console;
use crate::serve::failed;
use crate::switches::Switches;

/// Between two tries of the lease.
const RETRY: Duration = Duration::from_millis(500);

/// How a second serve ended, or the home it took over.
#[derive(Debug)]
pub(crate) enum HandedOver {
    Claimed(Claim),
    Ended(ExitCode),
}

/// What the holder said to one question.
enum Asked {
    Running {
        address: String,
        pid: Option<NonZeroU32>,
    },
    /// Why it is not taken as running here, the rest of a sentence.
    Silent(String),
}

/// Hands back the address of the daemon serving `home`, as its `record`
/// names it, or waits for that daemon for the hold, each question given
/// the probe, and takes the home over once its lease goes. Each wait is
/// said once; a stop while waiting ends it quietly and never claims the
/// home on the way out.
pub(crate) async fn hand_over(
    home: &Home,
    mut record: Option<DaemonRecord>,
    switches: &Switches,
    stop: &CancellationToken,
    console: &mut Console,
) -> HandedOver {
    let client = match http_client().build() {
        Ok(client) => client,
        Err(error) => return HandedOver::Ended(failed(console, &error)),
    };
    let deadline = Instant::now() + switches.hold;
    let mut waiting = false;

    loop {
        let why = match ask(&client, home, record.as_ref(), switches.probe, stop).await {
            Asked::Running { address, pid } => {
                console.say(&match pid {
                    Some(pid) => format!("Already running on this home (pid {pid})."),
                    None => "Already running on this home.".to_owned(),
                });
                console.say(&format!("PROJECT02_GATEWAY={address}"));
                return HandedOver::Ended(ExitCode::SUCCESS);
            }
            Asked::Silent(why) => why,
        };

        if stop.is_cancelled() {
            return HandedOver::Ended(ExitCode::FAILURE);
        }

        if Instant::now() >= deadline {
            console.warn(&format!(
                "Another daemon holds this home but {why}, still; run this again once it has \
                 started or stopped."
            ));
            return HandedOver::Ended(ExitCode::FAILURE);
        }

        if !waiting {
            waiting = true;
            console.warn(&format!(
                "Another daemon holds this home but {why}; waiting for it."
            ));
        }

        tokio::select! {
            biased;
            () = stop.cancelled() => return HandedOver::Ended(ExitCode::FAILURE),
            () = tokio::time::sleep(RETRY) => {}
        }

        match Claim::take(home) {
            Ok(ClaimOutcome::Claimed(claim)) => return HandedOver::Claimed(claim),
            Ok(ClaimOutcome::Held { record: held }) => record = held,
            Err(error) => return HandedOver::Ended(failed(console, &error)),
        }
    }
}

/// One question to the daemon `record` names, `GET /api/health` with its
/// token, under the probe and the stop: running here, or why not.
async fn ask(
    client: &reqwest::Client,
    home: &Home,
    record: Option<&DaemonRecord>,
    probe: Duration,
    stop: &CancellationToken,
) -> Asked {
    let Some(record) = record else {
        return Asked::Silent("has not published its address yet".to_owned());
    };
    let origin = format!("http://127.0.0.1:{}/", record.port);
    let health = async {
        let response = client
            .get(format!("{origin}api/health"))
            .bearer_auth(record.token.as_str())
            .timeout(probe)
            .send()
            .await?;
        let status = response.status();

        response.bytes().await.map(|body| (status, body))
    };
    let answered = tokio::select! {
        biased;
        () = stop.cancelled() => return Asked::Silent(format!("did not answer at {origin}")),
        answered = health => answered,
    };

    match answered {
        Err(error) if error.is_timeout() => Asked::Silent(format!(
            "did not answer at {origin} within {} seconds",
            seconds(probe)
        )),
        Err(error) => Asked::Silent(format!("did not answer at {origin}: {}", innermost(&error))),
        Ok((status, _)) if status.as_u16() == 503 => Asked::Silent("is stopping".to_owned()),
        Ok((status, _)) if !status.is_success() => {
            Asked::Silent(format!("did not answer at {origin}: it answered {status}"))
        }
        Ok((_, body)) => {
            let health: Option<Value> = serde_json::from_slice(&body).ok();
            let served = health
                .as_ref()
                .and_then(|health| health.get("homeRoot"))
                .and_then(Value::as_str);

            match served {
                Some(served) if served == home.root().display().to_string() => Asked::Running {
                    address: format!("{origin}#token={}", record.token.as_str()),
                    pid: record.running.as_ref().map(|run| run.pid),
                },
                Some(served) => Asked::Silent(format!("the one at {origin} serves {served}")),
                None => Asked::Silent(format!(
                    "did not answer at {origin}: its answer is no daemon's health"
                )),
            }
        }
    }
}

/// The cause at the bottom of `error`, which says what a person can act on:
/// a refused connection, say, rather than the request it failed.
fn innermost(error: &(dyn Error + 'static)) -> String {
    let mut deepest = error;

    while let Some(cause) = deepest.source() {
        deepest = cause;
    }

    deepest.to_string()
}

/// `wait` in seconds as a person writes them: `0.5`, `5`, `1.25`.
fn seconds(wait: Duration) -> String {
    let millis = wait.as_millis();
    let (whole, part) = (millis / 1000, millis % 1000);

    if part == 0 {
        whole.to_string()
    } else {
        format!("{whole}.{part:03}")
            .trim_end_matches('0')
            .to_owned()
    }
}
