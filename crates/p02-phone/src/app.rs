//! An app: its manifest and its script, made once from the two texts and
//! checked whole, so a broken one is refused when it is added.

use std::iter;

use p02_shared::Identifier;

use crate::data::Kept;
use crate::engine;
use crate::error::PackageError;
use crate::host::{Access, Host};
use crate::manifest::{Action, Manifest, View};
use crate::time::Now;

/// An app on her phone: its manifest, every rule of it kept, and a script
/// that runs and exports a function for its screens and for each action.
#[derive(Clone, Debug)]
pub struct App {
    manifest: Manifest,
    script: String,
    hears_rings: bool,
}

impl App {
    /// The app that `manifest`, its `app.json`, and `script`, its `app.js`,
    /// make. The script runs once, on an empty phone that only reads.
    ///
    /// # Errors
    ///
    /// [`PackageError`] for the first rule they break: the manifest's, or
    /// a script that does not run or exports no function for `screen` or
    /// for an action.
    pub fn new(manifest: &str, script: &str) -> Result<Self, PackageError> {
        let manifest = Manifest::read(manifest)?;
        let host = Host::new(Kept::default(), Now::epoch(), Access::ReadOnly);
        let functions =
            engine::exported_functions(script, &host).map_err(|failure| PackageError::Script {
                app: manifest.name.clone(),
                failure: failure.to_string(),
            })?;
        let exported = |name: &str| functions.iter().any(|function| function == name);
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
            hears_rings: exported("rang"),
            manifest,
            script: script.to_owned(),
        })
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

    pub(crate) fn script(&self) -> &str {
        &self.script
    }

    /// Whether the script exports `rang`, to hear of its rings.
    pub(crate) fn hears_rings(&self) -> bool {
        self.hears_rings
    }
}
