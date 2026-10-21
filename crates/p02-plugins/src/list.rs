//! The plugins compiled into the daemon: each package's manifest, read once
//! from the descriptor the repository keeps for both daemons, beside the
//! factory that builds it.

use std::sync::LazyLock;

use p02_contracts::{Manifest, ManifestError, PluginFactory};
use serde_json::Value;

use crate::{mem0, session_history};

/// Each package by the folder its descriptor is authored in, in id order.
const PACKAGES: [(&str, &str, PluginFactory); 2] = [
    (
        "mem0",
        include_str!("../../../src/plugins/packages/mem0/project02.plugin.json"),
        mem0::create,
    ),
    (
        "session-history",
        include_str!("../../../src/plugins/packages/session-history/project02.plugin.json"),
        session_history::create,
    ),
];

type Listed = Vec<(Manifest, PluginFactory)>;

static PLUGINS: LazyLock<Result<Listed, BundledManifestError>> = LazyLock::new(|| {
    PACKAGES
        .iter()
        .map(|&(package, descriptor, factory)| Ok((manifest(package, descriptor)?, factory)))
        .collect()
});

/// Why a package compiled into the daemon has no manifest it can run: a
/// build that must not ship.
#[derive(Debug, thiserror::Error)]
pub enum BundledManifestError {
    #[error("the descriptor of plugin package \"{package}\" is no JSON")]
    Descriptor {
        package: &'static str,
        #[source]
        source: serde_json::Error,
    },
    #[error("the manifest of plugin package \"{package}\" is refused")]
    Manifest {
        package: &'static str,
        #[source]
        source: ManifestError,
    },
}

/// The plugins compiled into the daemon, in id order: what a home's
/// settings are judged against, and what a character's plugins are built
/// from.
///
/// # Errors
///
/// [`BundledManifestError`] for the first package whose manifest does not
/// parse, at every call, so a build holding one fails at its first use.
pub fn plugins() -> Result<&'static [(Manifest, PluginFactory)], &'static BundledManifestError> {
    PLUGINS.as_deref()
}

/// The manifest a package's descriptor carries in its `manifest` member.
fn manifest(package: &'static str, descriptor: &str) -> Result<Manifest, BundledManifestError> {
    let descriptor: Value = serde_json::from_str(descriptor)
        .map_err(|source| BundledManifestError::Descriptor { package, source })?;

    Manifest::from_value(&descriptor["manifest"])
        .map_err(|source| BundledManifestError::Manifest { package, source })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_listed_package_carries_a_manifest_of_its_own_id() {
        let ids: Vec<&str> = plugins()
            .unwrap()
            .iter()
            .map(|(manifest, _)| manifest.id().as_str())
            .collect();
        let packages: Vec<&str> = PACKAGES.iter().map(|(package, ..)| *package).collect();

        assert_eq!(ids, packages);
    }
}
