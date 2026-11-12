//! What an app asks of her phone beyond keeping its own data, which every
//! app does: to wake her, to reach the internet at its hosts, and to use an
//! account of the person's there. Its manifest says it and the App Store's
//! catalog lists it under the same rules, and what the person is told the
//! app may do is said from it here, once.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::account::Account;
use crate::error::PackageError;

/// The most hosts an app reaches.
const MOST_HOSTS: usize = 4;

/// What an app asks of her phone: whether it wakes her, the hosts it
/// reaches, none when it names none, and the account of the person's it
/// uses at one of them, by its id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Asks {
    pub(crate) wakes: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) reaches: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) account: Option<String>,
}

impl Asks {
    /// Whether the app says it wakes her: only then can it set a ring.
    #[must_use]
    pub fn wakes(&self) -> bool {
        self.wakes
    }

    /// The hosts the app reaches, none when it reaches the internet nowhere.
    #[must_use]
    pub fn reaches(&self) -> &[String] {
        &self.reaches
    }

    /// The account of the person's the app uses, at one of its hosts.
    #[must_use]
    pub fn account(&self) -> Option<&'static Account> {
        self.account.as_deref().and_then(Account::of)
    }

    /// Refuses what breaks a rule, saying which: a host that is not a DNS
    /// name in lowercase, of two labels at least and not an address in
    /// numbers; more than 4 hosts, or one named twice; an account the phone
    /// does not know, or whose host the app does not reach.
    pub(crate) fn check(&self) -> Result<(), PackageError> {
        if self.reaches.len() > MOST_HOSTS {
            return Err(PackageError::TooManyHosts);
        }

        let mut seen = BTreeSet::new();

        for host in &self.reaches {
            if !is_host(host) {
                return Err(PackageError::Host(host.clone()));
            }

            if !seen.insert(host) {
                return Err(PackageError::DuplicateHost(host.clone()));
            }
        }

        let Some(id) = &self.account else {
            return Ok(());
        };
        let account = Account::of(id).ok_or_else(|| PackageError::Account(id.clone()))?;

        if self.reaches.iter().any(|host| host == account.host()) {
            Ok(())
        } else {
            Err(PackageError::AccountUnreached {
                account: id.clone(),
                host: account.host(),
            })
        }
    }
}

/// What an app may do, a line each, as the App Store says it and the
/// person is told it, from what the app `asks` for: keeping its own data
/// is every app's.
#[must_use]
pub fn it_may(asks: &Asks) -> Vec<String> {
    let mut may = vec!["Keep its own data".to_owned()];

    if asks.wakes {
        may.push("Wake her when something is due".to_owned());
    }

    if let Some((last, rest)) = asks.reaches.split_last() {
        let hosts = if rest.is_empty() {
            last.clone()
        } else {
            format!("{} and {last}", rest.join(", "))
        };

        may.push(format!("Reach the internet at {hosts}"));
    }

    if let Some(account) = asks.account() {
        may.push(format!("Use your {} account", account.name()));
    }

    may
}

/// Whether `host` is a DNS name in lowercase of two labels at least, each
/// of letters, digits and `-` not at its ends, whose last is not a number,
/// as an address in numbers ends: no bare name such as `localhost`, no
/// address, and no scheme, port or path.
fn is_host(host: &str) -> bool {
    let labels: Vec<&str> = host.split('.').collect();
    let named = |label: &&str| {
        (1..=63).contains(&label.len())
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    };

    host.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(named)
        && labels.last().is_some_and(|last| !is_number(last))
}

/// Whether `label` is a number as an address writes one: decimal, or hex
/// after `0x`.
fn is_number(label: &str) -> bool {
    match label.strip_prefix("0x") {
        Some(hex) => hex.bytes().all(|byte| byte.is_ascii_hexdigit()),
        None => label.bytes().all(|byte| byte.is_ascii_digit()),
    }
}
