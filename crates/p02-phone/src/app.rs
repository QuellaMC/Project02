//! An app: its one file, a script that exports its manifest beside its
//! functions, made once and checked whole, so a broken one is refused when
//! it is added; or the App Store, the phone's own.

use std::iter;

use p02_shared::Identifier;

use crate::asks::Asks;
use crate::data::Kept;
use crate::engine;
use crate::error::PackageError;
use crate::host::{Access, Host};
use crate::manifest::{Action, Manifest, View};
use crate::time::Now;

/// An app on her phone: its manifest, every rule of it kept, and what runs
/// it.
#[derive(Clone, Debug)]
pub struct App {
    manifest: Manifest,
    runs: Runs,
}

/// What runs an app's screens and actions.
#[derive(Clone, Debug)]
pub(crate) enum Runs {
    /// Its one file, a script that exports a function for its screens and
    /// for each action, and `rang` when it hears its rings.
    Script { text: String, hears_rings: bool },
    /// The App Store, in Rust: it needs what no app is given.
    Store,
}

impl App {
    /// The app that `text`, its one file, makes. The script runs once, on
    /// an empty phone that only reads, and its manifest is what it exports
    /// as `manifest`.
    ///
    /// # Errors
    ///
    /// [`PackageError`] for the first rule it breaks: a script that does
    /// not run, exports no manifest of plain data or no function for
    /// `screen` or for an action, or a manifest that breaks a rule of its
    /// own.
    pub fn new(text: &str) -> Result<Self, PackageError> {
        let host = Host::new(Kept::default(), Now::epoch(), Access::ReadOnly, None);
        let exports = engine::exports(text, &host)
            .map_err(|failure| PackageError::Script(failure.to_string()))?;
        let manifest = match exports.manifest {
            None => return Err(PackageError::NoManifest),
            Some(Err(place)) => return Err(PackageError::NotPlainData(place)),
            Some(Ok(manifest)) => Manifest::read(manifest)?,
        };
        let exported = |name: &str| exports.functions.iter().any(|function| function == name);
        let unexported = iter::once("screen")
            .chain(manifest.actions.iter().map(|action| action.name().as_str()))
            .find(|name| !exported(name))
            .map(str::to_owned);

        if let Some(function) = unexported {
            return Err(PackageError::Export {
                app: manifest.name,
                function,
            });
        }

        Ok(Self {
            runs: Runs::Script {
                text: text.to_owned(),
                hears_rings: exported("rang"),
            },
            manifest,
        })
    }

    /// The App Store, whose manifest keeps every rule an app's does.
    pub(crate) fn store(manifest: Manifest) -> Self {
        Self {
            manifest,
            runs: Runs::Store,
        }
    }

    #[must_use]
    pub fn id(&self) -> &Identifier {
        &self.manifest.id
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.manifest.name
    }

    /// The line she knows the app by.
    #[must_use]
    pub fn summary(&self) -> &str {
        &self.manifest.summary
    }

    /// The app's own version: three numbers with dots, `1.0.0`.
    #[must_use]
    pub fn version(&self) -> &str {
        &self.manifest.version
    }

    /// A name of the page's own icons, which falls back for one it does not
    /// know.
    #[must_use]
    pub fn icon(&self) -> &str {
        &self.manifest.icon
    }

    /// The tint of the icon's tile, a name of the page's own as the icon is.
    #[must_use]
    pub fn tint(&self) -> &str {
        &self.manifest.tint
    }

    /// What the app asks of her phone: to wake her, the hosts it reaches
    /// and the person's account it uses there.
    #[must_use]
    pub fn asks(&self) -> &Asks {
        &self.manifest.asks
    }

    /// Whether the app says it wakes her: only then can it set a ring.
    #[must_use]
    pub fn wakes(&self) -> bool {
        self.manifest.asks.wakes
    }

    #[must_use]
    pub fn views(&self) -> &[View] {
        &self.manifest.views
    }

    #[must_use]
    pub fn actions(&self) -> &[Action] {
        &self.manifest.actions
    }

    /// The view the app opens on when none is named.
    #[must_use]
    pub fn opens_on(&self) -> &Identifier {
        &self.manifest.opens_on
    }

    pub(crate) fn runs(&self) -> &Runs {
        &self.runs
    }
}
