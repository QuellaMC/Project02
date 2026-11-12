//! `phone.net.fetch`: an action reaching the internet through her phone's
//! caller, since the phone makes no request itself. A run of an action
//! answers each fetch from the exchanges of the runs before it, in the
//! order asked. A fetch none answers yet ends the run, which keeps nothing;
//! the caller makes that request, with no lease held, and runs the action
//! again from its start, at the same moment, with what came of it. So the
//! script reads `fetch` as a call that answers at once, and an action asks
//! for the same requests on every run.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::account::Account;
use crate::asks::Asks;

/// The most requests one call of an action makes.
const MOST_FETCHES: usize = 4;
/// The longest address a request is made at, in characters.
const URL_CHARS: usize = 2_048;
/// The largest body a request sends, in bytes.
const BODY_BYTES: usize = 64 * 1_024;
/// The headers a script may give a request, by their names in lowercase.
const HEADERS: [&str; 2] = ["accept", "content-type"];

pub(crate) const FETCH: &str = "phone.net.fetch takes {url, method, headers, body}: an https:// url \
                                of 2,048 characters at most with no user, password, port or \
                                fragment, a method of GET or POST, headers accept and \
                                content-type as text, and with POST a body of 64 KiB at most";
pub(crate) const UNREACHED: &str =
    "phone.net.fetch reaches only the hosts its app's manifest names in reaches";
pub(crate) const OFFLINE: &str =
    "phone.net.fetch reaches nothing here: only an action reaches the internet";
const FIFTH: &str =
    "phone.net.fetch was called a fifth time, and an action reaches the internet 4 times at most";
const OTHER: &str = "phone.net.fetch asked for other than it asked before, and an action asks \
                     for the same requests each time it runs";

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

/// A request an action made and what came of it: its answer, or why there
/// was none, in a sentence its caller gives, which the script's `fetch`
/// throws as a plain `Error`.
#[derive(Clone, Debug)]
pub struct Exchange {
    pub fetch: Fetch,
    pub fetched: Result<Fetched, String>,
}

/// The request a script gives `fetch`, as it gives it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Asked {
    url: String,
    method: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body: Option<String>,
}

/// What one run of an action reaches the internet with: the hosts its app
/// reaches and the account it uses, the exchanges of the runs before it,
/// how many times this run fetched, and how it ended, when it ended at a
/// fetch.
#[derive(Debug)]
pub(crate) struct Net {
    reaches: Vec<String>,
    account: Option<&'static Account>,
    exchanges: Vec<Exchange>,
    fetched: Cell<usize>,
    end: RefCell<Option<End>>,
}

/// How a run of an action ended at a fetch, before its answer.
#[derive(Debug)]
pub(crate) enum End {
    /// It asks for a request no exchange answers yet.
    Asks(Fetch),
    /// It fails the call, in these words: it fetched a fifth time, or
    /// asked for other than it asked at that place before.
    Fails(&'static str),
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

    /// The account of the person's the request is for: its app's, when it
    /// is made at that account's host; none otherwise.
    #[must_use]
    pub fn account(&self) -> Option<&'static Account> {
        self.account
    }
}

impl Net {
    /// A run of an action of the app that `asks` so, answered from
    /// `exchanges`, those of the runs before it.
    pub(crate) fn new(asks: &Asks, exchanges: &[Exchange]) -> Self {
        Self {
            reaches: asks.reaches.clone(),
            account: asks.account(),
            exchanges: exchanges.to_vec(),
            fetched: Cell::new(0),
            end: RefCell::new(None),
        }
    }

    /// The request `asked` is, once it keeps the rules of what `fetch`
    /// takes and is at a host its app reaches; otherwise the words of what
    /// it breaks.
    pub(crate) fn request(&self, asked: Asked) -> Result<Fetch, &'static str> {
        let Asked {
            url,
            method,
            headers,
            body,
        } = asked;
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
            (Method::Post, Some(body)) => body.len() <= BODY_BYTES,
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

        if !self.reaches.iter().any(|reached| reached == host) {
            return Err(UNREACHED);
        }

        let account = self.account.filter(|account| account.host() == host);

        Ok(Fetch {
            url,
            method,
            headers: named,
            body,
            account,
        })
    }

    /// What came of `fetch`, the run's next request: the exchange at its
    /// place. None ends the run, as [`Net::end`] then says: it asks for
    /// `fetch`, which no exchange answers yet, or it fails the call, by a
    /// fifth request or one other than it asked at that place before.
    pub(crate) fn answer(&self, fetch: Fetch) -> Option<&Result<Fetched, String>> {
        let place = self.fetched.get();

        if place == MOST_FETCHES {
            self.ends(End::Fails(FIFTH));
            return None;
        }

        self.fetched.set(place + 1);

        match self.exchanges.get(place) {
            None => {
                self.ends(End::Asks(fetch));
                None
            }
            Some(exchange) if exchange.fetch != fetch => {
                self.ends(End::Fails(OTHER));
                None
            }
            Some(exchange) => Some(&exchange.fetched),
        }
    }

    /// Whether the run ended at a fetch.
    pub(crate) fn ended(&self) -> bool {
        self.end.borrow().is_some()
    }

    /// How the run ended at a fetch, taken once it is over.
    pub(crate) fn end(&self) -> Option<End> {
        self.end.borrow_mut().take()
    }

    fn ends(&self, end: End) {
        *self.end.borrow_mut() = Some(end);
    }
}
