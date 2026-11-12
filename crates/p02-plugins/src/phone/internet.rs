//! Her apps' requests as the daemon makes them: each at the address its
//! action asked for, or, under the test switch, below the stand-in's base
//! by its host, through the client every service is reached with, which
//! follows no redirect. Any status is an answer, its body read as text up
//! to a bound; what is no answer is said in one plain sentence naming no
//! address. A request for an account of the person's carries their key,
//! which nothing prints and no answer hands back.

use std::fmt;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use p02_phone::{Fetch, Fetched, Method};
use p02_shared::{BaseUrl, credential_header, http_client};
use reqwest::Url;
use reqwest::header::{AUTHORIZATION, HeaderValue};

/// How long the requests of one call may take, all together.
pub(super) const REQUESTS: Duration = Duration::from_secs(20);
/// How much of an answer is read, in KiB.
const ANSWER_KIB: usize = 256;

const UNREACHED: &str = "Its server could not be reached.";
const TOO_LONG: &str = "Its server took too long to answer.";
const TOO_MUCH: &str = "Its server answered more than the phone takes.";

/// Where her apps' requests go, and the client that makes them.
#[derive(Debug)]
pub struct AppInternet {
    /// The stand-in every request goes to instead, under the test switch.
    stand_in: Option<BaseUrl>,
    /// Made at the first request, not with the seam: a client reads the
    /// system's certificates.
    http: OnceLock<reqwest::Client>,
}

/// A key the person gave for an account of theirs, and the header it
/// travels in.
pub(super) struct Key {
    text: String,
    header: HeaderValue,
}

impl AppInternet {
    /// Requests made where they say, or, when `stand_in` names a base, each
    /// one for `https://<host>/<path>?<query>` made at
    /// `<stand_in>/<host>/<path>?<query>`, the rest of it unchanged.
    #[must_use]
    pub fn new(stand_in: Option<BaseUrl>) -> Self {
        Self {
            stand_in,
            http: OnceLock::new(),
        }
    }

    /// What came of `fetch`, made by `until` and carrying `key` when it is
    /// for an account: its status and its body as text, with the key
    /// redacted wherever the service echoed it; or why there was no answer.
    pub(super) async fn fetch(
        &self,
        fetch: &Fetch,
        key: Option<&Key>,
        until: Instant,
    ) -> Result<Fetched, String> {
        let wait = until.saturating_duration_since(Instant::now());

        if wait.is_zero() {
            return Err(TOO_LONG.to_owned());
        }

        let method = match fetch.method() {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
        };
        let mut request = self
            .http()?
            .request(method, self.address(fetch))
            .timeout(wait);

        for (name, value) in fetch.headers() {
            request = request.header(*name, value);
        }

        if let Some(key) = key {
            request = request.header(AUTHORIZATION, key.header.clone());
        }

        if let Some(body) = fetch.body() {
            request = request.body(body.to_owned());
        }

        let mut response = request.send().await.map_err(|error| said(&error))?;
        let status = response.status().as_u16();
        let mut body = Vec::new();

        while let Some(chunk) = response.chunk().await.map_err(|error| said(&error))? {
            if body.len() + chunk.len() > ANSWER_KIB * 1_024 {
                return Err(TOO_MUCH.to_owned());
            }

            body.extend_from_slice(&chunk);
        }

        let body = String::from_utf8_lossy(&body).into_owned();

        Ok(Fetched {
            status,
            body: match key {
                Some(key) => body.replace(&key.text, "[redacted]"),
                None => body,
            },
        })
    }

    /// Where `fetch` is made: at its own address, or below the stand-in's
    /// base by its host.
    fn address(&self, fetch: &Fetch) -> Url {
        let Some(stand_in) = &self.stand_in else {
            return fetch.url().clone();
        };
        let mut address = stand_in.endpoint(&format!("{}{}", fetch.host(), fetch.url().path()));

        address.set_query(fetch.url().query());
        address
    }

    /// The client its requests go by, made at the first; one that cannot be
    /// made reaches nothing.
    fn http(&self) -> Result<&reqwest::Client, String> {
        if let Some(http) = self.http.get() {
            return Ok(http);
        }

        let made = http_client().build().map_err(|_| UNREACHED.to_owned())?;

        Ok(self.http.get_or_init(|| made))
    }
}

impl Key {
    /// The key `text`, sent as `Authorization: Bearer <text>`; none when no
    /// header can carry it, which is no key at all.
    pub(super) fn new(text: &str) -> Option<Self> {
        credential_header(&format!("Bearer {text}"))
            .ok()
            .map(|header| Self {
                text: text.to_owned(),
                header,
            })
    }
}

impl fmt::Debug for Key {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Key([redacted])")
    }
}

/// Why a request had no answer, said naming no address: a transport error
/// can name one, so it is never repeated.
fn said(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        TOO_LONG
    } else {
        UNREACHED
    }
    .to_owned()
}
