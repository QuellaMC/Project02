//! The one way the daemon reaches a service over HTTP: where the service
//! is, how a credential travels to it, and the client that carries both.

use std::fmt;
use std::sync::Once;

use reqwest::header::HeaderValue;
use reqwest::{Client, ClientBuilder, Url, redirect};

/// What a base URL must be, as a refusal states it after the setting's
/// name. A refusal never echoes the value: a mistyped address can carry a
/// credential, and the sentence reaches logs and durable records.
pub const BASE_URL_RULE: &str =
    "an absolute http:// or https:// address with no embedded credentials, query, or fragment";

/// Where a service is: an `http` or `https` origin and path, with no
/// credentials, query or fragment, which would sit before every endpoint
/// path and move where each request lands. Trailing slashes are dropped,
/// so two spellings of one endpoint are one value.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct BaseUrl(Url);

/// Why a text is not a [`BaseUrl`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("a base URL must be {BASE_URL_RULE}")]
pub struct ParseBaseUrlError;

impl BaseUrl {
    /// # Errors
    ///
    /// [`ParseBaseUrlError`] when `text` is not [`BASE_URL_RULE`].
    pub fn parse(text: &str) -> Result<Self, ParseBaseUrlError> {
        let mut url = Url::parse(text).map_err(|_| ParseBaseUrlError)?;
        let acceptable = matches!(url.scheme(), "http" | "https")
            && url.has_host()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none();

        if !acceptable {
            return Err(ParseBaseUrlError);
        }

        let path = url.path().trim_end_matches('/').to_owned();

        url.set_path(&path);
        Ok(Self(url))
    }

    /// The endpoint at `path` below this base.
    #[must_use]
    pub fn endpoint(&self, path: &str) -> Url {
        let mut url = self.0.clone();

        url.set_path(&format!("{}/{path}", self.0.path().trim_end_matches('/')));
        url
    }

    /// The base in its one canonical spelling.
    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for BaseUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("BaseUrl")
            .field(&self.as_str())
            .finish()
    }
}

impl fmt::Display for BaseUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Why a credential cannot travel in a request header.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("a credential must be text a request header can carry")]
pub struct InvalidCredentialError;

/// `value` as a header that carries a credential: marked sensitive, so no
/// `Debug` of a request or a client prints it.
///
/// # Errors
///
/// [`InvalidCredentialError`] when `value` holds a character a header
/// cannot, such as a line break.
pub fn credential_header(value: &str) -> Result<HeaderValue, InvalidCredentialError> {
    let mut header = HeaderValue::from_str(value).map_err(|_| InvalidCredentialError)?;

    header.set_sensitive(true);
    Ok(header)
}

/// A client for the services the daemon calls, which each caller finishes
/// building. TLS goes through the ring provider. No redirect is followed:
/// one would resend the credential and the request body to wherever it
/// points, so a 3xx answer is the caller's to report. No proxy is read
/// from the environment: the daemon reaches each service directly.
pub fn http_client() -> ClientBuilder {
    static PROVIDER: Once = Once::new();

    PROVIDER.call_once(|| {
        // A provider installed first by another part of the process serves
        // just as well, so a refused install is no failure.
        drop(rustls::crypto::ring::default_provider().install_default());
    });

    Client::builder()
        .redirect(redirect::Policy::none())
        .no_proxy()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_base_url_is_an_http_origin_and_path_spelled_one_way() {
        for (text, canonical) in [
            ("https://api.mem0.ai", "https://api.mem0.ai/"),
            ("https://API.mem0.ai/", "https://api.mem0.ai/"),
            ("http://127.0.0.1:8765//", "http://127.0.0.1:8765/"),
            ("http://localhost:11434/v1/", "http://localhost:11434/v1"),
            (
                "https://gateway.example:443/v1",
                "https://gateway.example/v1",
            ),
        ] {
            assert_eq!(BaseUrl::parse(text).unwrap().as_str(), canonical, "{text}");
        }

        for refused in [
            "localhost:11434/v1",
            "ftp://files.example",
            "https://operator:hunter2@mem0.example",
            "https://mem0.example/?key=1",
            "https://mem0.example/#top",
            "not a url",
        ] {
            assert_eq!(BaseUrl::parse(refused), Err(ParseBaseUrlError), "{refused}");
        }

        assert_eq!(
            ParseBaseUrlError.to_string(),
            format!("a base URL must be {BASE_URL_RULE}")
        );
    }

    #[test]
    fn an_endpoint_lands_below_its_base_whatever_the_base_ends_with() {
        let endpoint = |base: &str, path: &str| {
            BaseUrl::parse(base)
                .unwrap()
                .endpoint(path)
                .as_str()
                .to_owned()
        };

        assert_eq!(
            endpoint("https://api.mem0.ai", "v3/memories/search/"),
            "https://api.mem0.ai/v3/memories/search/"
        );
        assert_eq!(
            endpoint("http://localhost:11434/v1/", "embeddings"),
            "http://localhost:11434/v1/embeddings"
        );
        assert_eq!(
            endpoint("http://127.0.0.1:8765", ""),
            "http://127.0.0.1:8765/"
        );
    }

    #[test]
    fn a_credential_header_never_prints() {
        let header = credential_header("Token platform-secret").unwrap();

        assert!(header.is_sensitive());
        assert!(!format!("{header:?}").contains("platform-secret"));
        assert_eq!(
            credential_header("line\nbreak"),
            Err(InvalidCredentialError)
        );
    }
}
