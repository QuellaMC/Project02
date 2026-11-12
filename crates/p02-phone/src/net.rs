//! `phone.net.fetch`: an action reaching the internet at the hosts its app
//! reaches. The phone makes no request itself: a fetch is an ask of the
//! action's host, which its caller makes, the person's key sent with one
//! for an account of theirs.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::account::{Account, AccountKind};
use crate::asks::Asks;
use crate::exchange::TEXT_BYTES;

/// The longest address the phone takes, in characters: a request's, or the
/// one a screen's row names.
pub(crate) const URL_CHARS: usize = 2_048;
/// The headers a script may give a request, by their names in lowercase.
const HEADERS: [&str; 2] = ["accept", "content-type"];

pub(crate) const FETCH: &str = "phone.net.fetch takes {url, method, headers, body}: an https:// url \
                                of 2,048 characters at most with no user, password, port or \
                                fragment, a method of GET or POST, headers accept and \
                                content-type as text, and with POST a body of 64 KiB at most";
const UNREACHED: &str =
    "phone.net.fetch reaches only the hosts its app's manifest names in reaches";
pub(crate) const OFFLINE: &str =
    "phone.net.fetch reaches nothing here: only an action reaches the internet";

/// How a request is made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

/// A request an action asks her phone's caller to make: what the script
/// gave, as the phone took it, and the account of the person's it is for,
/// whose key the caller sends with it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fetch {
    url: Url,
    method: Method,
    headers: Vec<(&'static str, String)>,
    body: Option<String>,
    account: Option<&'static Account>,
}

/// What a request was answered: its status, whatever it is, and its body
/// as text, which the script parses as it expects.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Fetched {
    pub status: u16,
    pub body: String,
}

/// The request a script gives `fetch`, as it gives it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Requested {
    url: String,
    method: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body: Option<String>,
}

impl Fetch {
    /// Where the request is made.
    #[must_use]
    pub fn url(&self) -> &Url {
        &self.url
    }

    /// The host the request is made at, one its app reaches.
    #[must_use]
    pub fn host(&self) -> &str {
        self.url.host_str().unwrap_or_default()
    }

    #[must_use]
    pub fn method(&self) -> Method {
        self.method
    }

    /// The headers the script gave it, each by its name in lowercase.
    #[must_use]
    pub fn headers(&self) -> &[(&'static str, String)] {
        &self.headers
    }

    #[must_use]
    pub fn body(&self) -> Option<&str> {
        self.body.as_deref()
    }

    /// The account of the person's the request is for: its app's, when
    /// that is a key's and the request is made at its host; none otherwise.
    #[must_use]
    pub fn account(&self) -> Option<&'static Account> {
        self.account
    }

    /// The request `requested` is, once it keeps the rules of what `fetch`
    /// takes and is at a host its app, which `asks` so, reaches; otherwise
    /// the words of what it breaks.
    pub(crate) fn of(requested: Requested, asks: &Asks) -> Result<Self, &'static str> {
        let Requested {
            url,
            method,
            headers,
            body,
        } = requested;
        let method = match method.as_deref() {
            None | Some("GET") => Method::Get,
            Some("POST") => Method::Post,
            Some(_) => return Err(FETCH),
        };
        let mut named: Vec<(&'static str, String)> = Vec::new();

        for (name, value) in headers {
            let name = HEADERS
                .into_iter()
                .find(|known| known.eq_ignore_ascii_case(&name))
                .filter(|known| named.iter().all(|(given, _)| given != known))
                .ok_or(FETCH)?;

            named.push((name, value));
        }

        let sent = match (method, &body) {
            (_, None) => true,
            (Method::Get, Some(_)) => false,
            (Method::Post, Some(body)) => body.len() <= TEXT_BYTES,
        };

        if !sent || url.chars().count() > URL_CHARS {
            return Err(FETCH);
        }

        let url = Url::parse(&url).map_err(|_| FETCH)?;
        let plain = url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.fragment().is_none();
        let host = url.host_str().filter(|_| plain).ok_or(FETCH)?;

        if !asks.reaches.iter().any(|reached| reached == host) {
            return Err(UNREACHED);
        }

        let account = asks.account().filter(|account| {
            matches!(account.kind(), AccountKind::Key { host: keyed, .. } if *keyed == host)
        });

        Ok(Self {
            url,
            method,
            headers: named,
            body,
            account,
        })
    }
}
