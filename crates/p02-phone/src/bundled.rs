//! The apps every phone comes with, compiled into the daemon from `apps/`.

use std::sync::LazyLock;

use crate::app::App;
use crate::error::PackageError;
use crate::phone::Phone;

/// Each app every phone comes with, by its file's name in `apps/`, and the
/// text of that file.
const BUNDLED: [(&str, &str); 1] = [("clock.js", include_str!("../apps/clock.js"))];

static BUNDLED_PHONE: LazyLock<Result<Phone, BundledAppError>> = LazyLock::new(|| {
    BUNDLED
        .iter()
        .map(|&(file, text)| App::new(text).map_err(|source| BundledAppError { file, source }))
        .collect::<Result<_, _>>()
        .map(Phone::new)
});

/// Why an app compiled into the daemon is refused: a build that must not
/// ship.
#[derive(Debug, thiserror::Error)]
#[error("the bundled app in apps/{file} is refused")]
pub struct BundledAppError {
    file: &'static str,
    #[source]
    source: PackageError,
}

impl Phone {
    /// The phone every character has: it comes with the apps compiled into
    /// the daemon, made once, and what is installed on it is hers, in the
    /// files each call is given.
    ///
    /// # Errors
    ///
    /// [`BundledAppError`] for the first app it comes with that is refused,
    /// at every call, so a build holding one fails at its first use.
    pub fn bundled() -> Result<&'static Self, &'static BundledAppError> {
        BUNDLED_PHONE.as_ref()
    }
}
