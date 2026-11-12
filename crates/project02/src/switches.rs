//! The switches a test harness sets in a command's environment: read once
//! at start, and never settings, so neither `config.json` nor the settings
//! page knows them. A value the command cannot use refuses the start rather
//! than doing nothing, before anything is bound or written.

use std::ffi::OsStr;
use std::num::NonZeroU64;
use std::time::Duration;

use p02_app::Durations;
use p02_role_model::TestProvider;
use p02_shared::{BASE_URL_RULE, BaseUrl};

/// Runs every character on the test provider, whatever her settings
/// choose.
pub(crate) const TEST_PROVIDER: &str = "PROJECT02_TEST_PROVIDER";

/// Shortens the waits, so expiry, pings and her moments of her own run in
/// seconds: `key=milliseconds` pairs separated by commas.
pub(crate) const TEST_DURATIONS: &str = "PROJECT02_TEST_DURATIONS";

/// Names the Bot API the connector reaches in Telegram's place.
pub(crate) const TEST_TELEGRAM_API: &str = "PROJECT02_TEST_TELEGRAM_API";

/// Names the App Store's catalog in place of the build's own.
pub(crate) const TEST_APP_CATALOG: &str = "PROJECT02_TEST_APP_CATALOG";

/// Names the stand-in that takes every request of her apps: one for
/// `https://<host>/<path>?<query>` is made at `<base>/<host>/<path>?<query>`.
pub(crate) const TEST_APP_INTERNET: &str = "PROJECT02_TEST_APP_INTERNET";

/// Where this build's App Store is: its catalog, and each of its apps, by
/// the rule the reader follows, under this base.
const APP_CATALOG: &str = "https://raw.githubusercontent.com/QuellaMC/Project02-Apps/main";

/// The waits serve reads, in the order a refusal lists them.
const SERVE_KEYS: [&str; 6] = [
    "confirmation",
    "pairing",
    "silence",
    "ping",
    "grace",
    "minute",
];

/// The one wait the connector reads: between two edits of a draft.
const TELEGRAM_KEYS: [&str; 1] = ["edit"];

/// What the switches make of a run: the model every character answers
/// through, the daemon's waits, where the App Store is, and the stand-in
/// her apps' requests go to. The default is a run no switch touched, the
/// one a program that runs the daemon starts, since no switch is a setting
/// a person sees.
#[derive(Debug)]
pub struct Switches {
    pub(crate) test_provider: Option<TestProvider>,
    pub(crate) durations: Durations,
    pub(crate) app_catalog: BaseUrl,
    pub(crate) app_internet: Option<BaseUrl>,
}

impl Default for Switches {
    fn default() -> Self {
        Self {
            test_provider: None,
            durations: Durations::default(),
            app_catalog: BaseUrl::parse(APP_CATALOG)
                .expect("the build's own App Store is at a base URL"),
            app_internet: None,
        }
    }
}

/// A switch the command cannot use, and why.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub(crate) struct SwitchError(String);

/// What the switches make of the connector: the Bot API it reaches, and how
/// long a draft waits between two edits, each its own unless set.
#[derive(Debug)]
pub(crate) struct TelegramSwitches {
    pub(crate) telegram: Option<BaseUrl>,
    pub(crate) draft_edits: Option<Duration>,
}

/// Serve's switches as the environment sets them: the test provider's
/// value, the durations', the App Store's catalog's and her apps' internet's,
/// each none when unset. The durations are read first, then a test provider
/// other than `deterministic` is refused, then a catalog's address and an
/// internet's that is no base.
pub(crate) fn read(
    provider: Option<&OsStr>,
    durations: Option<&OsStr>,
    catalog: Option<&OsStr>,
    internet: Option<&OsStr>,
) -> Result<Switches, SwitchError> {
    let mut switches = Switches::default();

    for (key, wait) in waits(durations, &SERVE_KEYS)? {
        match key {
            "confirmation" => switches.durations.confirmation = wait,
            "pairing" => switches.durations.pairing = wait,
            "silence" => switches.durations.model_silence = Some(wait),
            "ping" => switches.durations.ping = wait,
            "grace" => switches.durations.grace = wait,
            _ => switches.durations.minute = wait,
        }
    }

    if let Some(provider) = provider {
        switches.test_provider = Some(
            provider
                .to_str()
                .and_then(|provider| provider.parse().ok())
                .ok_or_else(|| {
                    SwitchError(format!(
                        "{TEST_PROVIDER} must be \"deterministic\" when it is set."
                    ))
                })?,
        );
    }

    if let Some(catalog) = base(TEST_APP_CATALOG, catalog)? {
        switches.app_catalog = catalog;
    }

    switches.app_internet = base(TEST_APP_INTERNET, internet)?;

    Ok(switches)
}

/// The connector's switches as the environment sets them: the durations',
/// then the Bot API's address.
pub(crate) fn telegram(
    durations: Option<&OsStr>,
    api: Option<&OsStr>,
) -> Result<TelegramSwitches, SwitchError> {
    let draft_edits = waits(durations, &TELEGRAM_KEYS)?
        .into_iter()
        .map(|(_, wait)| wait)
        .next();

    Ok(TelegramSwitches {
        telegram: base(TEST_TELEGRAM_API, api)?,
        draft_edits,
    })
}

/// The address switch `name` sets to `value`, an absolute http or https one
/// with no credentials, query or fragment; none when unset.
fn base(name: &str, value: Option<&OsStr>) -> Result<Option<BaseUrl>, SwitchError> {
    value
        .map(|value| {
            value
                .to_str()
                .and_then(|value| BaseUrl::parse(value).ok())
                .ok_or_else(|| SwitchError(format!("{name} must be {BASE_URL_RULE}.")))
        })
        .transpose()
}

/// The waits `pairs` sets among the command's `keys`, as `key=milliseconds`
/// pairs separated by commas: a key the command does not read, or a value
/// that is no whole number of milliseconds above 0, is refused.
fn waits(
    pairs: Option<&OsStr>,
    keys: &[&'static str],
) -> Result<Vec<(&'static str, Duration)>, SwitchError> {
    let Some(pairs) = pairs else {
        return Ok(Vec::new());
    };

    pairs
        .to_string_lossy()
        .split(',')
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            let Some(key) = keys.iter().copied().find(|known| *known == key) else {
                return Err(refused(&format!(
                    "unknown key \"{key}\"; the keys here are {}.",
                    keys.join(", ")
                )));
            };
            let wait = value.parse::<NonZeroU64>().map_err(|_| {
                refused(&format!(
                    "key \"{key}\" needs a whole number of milliseconds above 0, not \"{value}\"."
                ))
            })?;

            Ok((key, Duration::from_millis(wait.get())))
        })
        .collect()
}

fn refused(why: &str) -> SwitchError {
    SwitchError(format!("{TEST_DURATIONS}: {why}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn switched(
        provider: Option<&str>,
        durations: Option<&str>,
        catalog: Option<&str>,
        internet: Option<&str>,
    ) -> Result<Switches, SwitchError> {
        read(
            provider.map(OsStr::new),
            durations.map(OsStr::new),
            catalog.map(OsStr::new),
            internet.map(OsStr::new),
        )
    }

    #[test]
    fn each_switch_sets_what_it_names_and_the_rest_keep_their_own() {
        let ms = Duration::from_millis;
        let unset = switched(None, None, None, None).unwrap();

        assert_eq!(unset.test_provider, None);
        assert_eq!(unset.durations, Durations::default());
        assert_eq!(unset.app_catalog.as_str(), APP_CATALOG);
        assert_eq!(unset.app_internet, None);

        let set = switched(
            Some("deterministic"),
            Some("confirmation=1,pairing=2,silence=3,ping=4,grace=5,minute=6"),
            Some("http://127.0.0.1:8765/apps/"),
            Some("http://127.0.0.1:8766"),
        )
        .unwrap();

        assert_eq!(set.test_provider, Some(TestProvider::Deterministic));
        assert_eq!(set.app_catalog.as_str(), "http://127.0.0.1:8765/apps");
        assert_eq!(
            set.app_internet.as_ref().map(BaseUrl::as_str),
            Some("http://127.0.0.1:8766/")
        );
        assert_eq!(
            set.durations,
            Durations {
                confirmation: ms(1),
                pairing: ms(2),
                model_silence: Some(ms(3)),
                settings_lock: Durations::default().settings_lock,
                ping: ms(4),
                grace: ms(5),
                minute: ms(6),
            }
        );
        assert_eq!(
            switched(None, Some("grace=100"), None, None)
                .unwrap()
                .durations,
            Durations {
                grace: ms(100),
                ..Durations::default()
            }
        );
    }

    #[test]
    fn a_switch_serve_cannot_use_is_refused_naming_it() {
        let keys = "the keys here are confirmation, pairing, silence, ping, grace, minute.";

        for (provider, durations, catalog, internet, said) in [
            (
                None,
                Some("edit=100"),
                None,
                None,
                format!("PROJECT02_TEST_DURATIONS: unknown key \"edit\"; {keys}"),
            ),
            (
                None,
                Some("grace=1.5"),
                None,
                None,
                "PROJECT02_TEST_DURATIONS: key \"grace\" needs a whole number of milliseconds \
                 above 0, not \"1.5\"."
                    .to_owned(),
            ),
            (
                Some("nvidia"),
                None,
                None,
                None,
                "PROJECT02_TEST_PROVIDER must be \"deterministic\" when it is set.".to_owned(),
            ),
            (
                None,
                None,
                Some("127.0.0.1:8765"),
                None,
                format!("PROJECT02_TEST_APP_CATALOG must be {BASE_URL_RULE}."),
            ),
            (
                None,
                None,
                None,
                Some("http://127.0.0.1:8766/?all=1"),
                format!("PROJECT02_TEST_APP_INTERNET must be {BASE_URL_RULE}."),
            ),
        ] {
            assert_eq!(
                switched(provider, durations, catalog, internet).map(drop),
                Err(SwitchError(said)),
                "{provider:?} {durations:?} {catalog:?} {internet:?}"
            );
        }
    }
}
