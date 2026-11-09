#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod bot;
mod bot_api;
mod cards;
mod character;
mod daemon;
mod gate;
mod management;
mod outbox;
mod table;

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use p02_shared::{BaseUrl, error_sentence};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tokio_util::sync::CancellationToken;

use crate::bot_api::Telegram;
use crate::table::Table;

/// Telegram's own Bot API.
const TELEGRAM: &str = "https://api.telegram.org";

/// Where the connector speaks: stdout says what runs, stderr every trouble,
/// each state once per change.
pub trait Lines: Send + Sync + fmt::Debug {
    fn say(&self, line: &str);
    fn report(&self, line: &str);
}

/// What the connector runs on.
#[derive(Debug)]
pub struct Options {
    /// The home whose record names the daemon.
    pub home: PathBuf,
    /// The Bot API: Telegram's own, unless a test harness names another.
    pub telegram: BaseUrl,
    /// The shortest wait between two edits of a reply's draft in a chat.
    pub draft_edits: Duration,
}

impl Options {
    /// The connector of the home at `home`, on Telegram's own Bot API.
    ///
    /// # Panics
    ///
    /// Never: Telegram's own address is a base URL.
    #[must_use]
    pub fn new(home: PathBuf) -> Self {
        Self {
            home,
            telegram: BaseUrl::parse(TELEGRAM).expect("Telegram's address is a base URL"),
            draft_edits: Duration::from_millis(1_500),
        }
    }
}

/// How the connector ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ended {
    /// At the stop, every bot with it.
    Stopped,
    /// On what it could not go on with, said on stderr.
    Failed,
}

/// Follows the daemon the home's record names and runs a bot for each
/// token its Telegram settings hold, until the stop; answers once every
/// bot has ended.
pub async fn run(options: Options, lines: Arc<dyn Lines>, stop: CancellationToken) -> Ended {
    let telegram = match Telegram::new(options.telegram) {
        Ok(telegram) => Arc::new(telegram),
        Err(error) => {
            lines.report(&format!(
                "Telegram connector: {}",
                error_sentence(&error.without_url())
            ));
            return Ended::Failed;
        }
    };
    let mut table = Table::new(telegram, options.draft_edits, Arc::clone(&lines), &stop);
    let ended = daemon::follow_home(&options.home, &mut table, &lines, &stop).await;

    table.stop_all().await;
    ended
}

/// Says a line unless it is the one said last, so a state that lasts is
/// said once.
#[derive(Debug, Default)]
struct Notice(Option<String>);

impl Notice {
    fn say(&mut self, lines: &dyn Lines, line: String) {
        if self.0.as_ref() != Some(&line) {
            lines.say(&line);
        }

        self.0 = Some(line);
    }

    fn report(&mut self, lines: &dyn Lines, line: String) {
        if self.0.as_ref() != Some(&line) {
            lines.report(&line);
        }

        self.0 = Some(line);
    }

    fn forget(&mut self) {
        self.0 = None;
    }
}

/// The wait before trying again after `failures` failures in a row: a
/// second, doubled with each, and never longer than half a minute.
fn backoff(failures: u32) -> Duration {
    Duration::from_secs(2_u64.saturating_pow(failures).min(30))
}

/// A field read leniently: what does not decode as `T` is absent, so one
/// odd value never costs the rest of what came with it.
fn lenient<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = serde_json::Value::deserialize(deserializer)?;

    Ok(serde_json::from_value(value).ok())
}
