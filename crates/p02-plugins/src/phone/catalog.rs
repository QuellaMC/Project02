//! The App Store's catalog as the daemon reads it from where the build
//! keeps it: `catalog.json` under one base address, and the file of version
//! `V` of app `X` at `apps/X/V.js` under the same base, which never
//! changes, so whatever a cache between holds, the catalog names a file
//! that says what its entry says.

use std::sync::OnceLock;
use std::time::Duration;

use p02_contracts::TEXT_FILE_KIB;
use p02_phone::{Catalog, CatalogApp, CatalogError};
use p02_shared::{BaseUrl, http_client};

/// How long one request may take, from connecting to its body's end.
const REQUEST: Duration = Duration::from_secs(8);
/// How much of the catalog is read, in KiB.
const CATALOG_KIB: usize = 256;

/// The App Store's catalog, read anew at every call: its document, and
/// one entry's app. A failure is said in plain words and names no address.
#[derive(Debug)]
pub struct AppCatalog {
    base: BaseUrl,
    /// Made at the first request, not with the reader: a client reads the
    /// system's certificates.
    http: OnceLock<reqwest::Client>,
}

impl AppCatalog {
    /// The catalog under `base`.
    #[must_use]
    pub fn new(base: BaseUrl) -> Self {
        Self {
            base,
            http: OnceLock::new(),
        }
    }

    /// The catalog as it is now.
    ///
    /// # Errors
    ///
    /// [`CatalogError`] when it cannot be reached, is longer than the phone
    /// reads, or is no catalog it reads.
    pub async fn catalog(&self) -> Result<Catalog, CatalogError> {
        let document = self
            .fetch("catalog.json", CATALOG_KIB)
            .await?
            .ok_or(CatalogError::TooLarge)?;

        Catalog::read(&document)
    }

    /// The one file of `app` in the version the catalog lists, as its text:
    /// what a text file holds at most. Whether it is that app is judged
    /// apart, by the phone.
    ///
    /// # Errors
    ///
    /// [`CatalogError::Unreachable`], or [`CatalogError::NotTheApp`] for a
    /// file past that bound or that is no text.
    pub async fn app(&self, app: &CatalogApp) -> Result<String, CatalogError> {
        let not_the_app = |why: &str| CatalogError::NotTheApp {
            name: app.name().to_owned(),
            why: why.to_owned(),
        };
        let file = self
            .fetch(
                &format!("apps/{}/{}.js", app.id(), app.version()),
                TEXT_FILE_KIB,
            )
            .await?
            .ok_or_else(|| not_the_app("its file is longer than an app's may be"))?;

        String::from_utf8(file).map_err(|_| not_the_app("its file is not text"))
    }

    /// The body at `path` below the base, none when it is longer than
    /// `kib` KiB. A transport error is never repeated, since it can name
    /// the address; a redirect is no answer, as any status but success.
    async fn fetch(&self, path: &str, kib: usize) -> Result<Option<Vec<u8>>, CatalogError> {
        let mut response = self
            .http()?
            .get(self.base.endpoint(path))
            .timeout(REQUEST)
            .send()
            .await
            .map_err(|_| CatalogError::Unreachable)?;

        if !response.status().is_success() {
            return Err(CatalogError::Unreachable);
        }

        let mut body = Vec::new();

        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| CatalogError::Unreachable)?
        {
            if body.len() + chunk.len() > kib * 1_024 {
                return Ok(None);
            }

            body.extend_from_slice(&chunk);
        }

        Ok(Some(body))
    }

    /// The client its requests go by, made at the first; one that cannot
    /// be made reaches nothing.
    fn http(&self) -> Result<&reqwest::Client, CatalogError> {
        if let Some(http) = self.http.get() {
            return Ok(http);
        }

        let made = http_client()
            .build()
            .map_err(|_| CatalogError::Unreachable)?;

        Ok(self.http.get_or_init(|| made))
    }
}
