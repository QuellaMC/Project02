//! The apps every phone comes with, compiled into the daemon from `apps/`.

use std::sync::LazyLock;

use crate::app::App;
use crate::error::PackageError;
use crate::phone::Phone;

/// Each app every phone comes with, by the folder it is written in, as its
/// `app.json` and its `app.js`.
const BUNDLED: [(&str, &str, &str); 1] = [(
    "clock",
    include_str!("../apps/clock/app.json"),
    include_str!("../apps/clock/app.js"),
)];

static BUNDLED_PHONE: LazyLock<Result<Phone, BundledAppError>> = LazyLock::new(|| {
    BUNDLED
        .iter()
        .map(|&(folder, manifest, script)| {
            App::new(manifest, script).map_err(|source| BundledAppError { folder, source })
        })
        .collect::<Result<_, _>>()
        .map(Phone::new)
});

/// Why an app compiled into the daemon is refused: a build that must not
/// ship.
#[derive(Debug, thiserror::Error)]
#[error("the bundled app in apps/{folder} is refused")]
pub struct BundledAppError {
    folder: &'static str,
    #[source]
    source: PackageError,
}

impl Phone {
    /// The phone every character has: the apps compiled into the daemon,
    /// made once.
    ///
    /// # Errors
    ///
    /// [`BundledAppError`] for the first of them that is refused, at every
    /// call, so a build holding one fails at its first use.
    pub fn bundled() -> Result<&'static Self, &'static BundledAppError> {
        BUNDLED_PHONE.as_ref()
    }
}
