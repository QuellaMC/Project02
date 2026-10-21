//! The plugins compiled into the daemon: each one's manifest, read once
//! from its descriptor, beside the factory that builds it. A package's
//! descriptor is the one the repository keeps for both daemons; the host's
//! own plugin, which has no package, keeps its own beside its code.

use std::sync::LazyLock;

use p02_contracts::{Manifest, ManifestError, PluginFactory};
use serde_json::Value;

use crate::{character_memory, character_state, demo_config, management, mem0, session_history};

/// Each plugin by its id, with its descriptor and its factory, in id
/// order.
const PLUGINS: [(&str, &str, PluginFactory); 6] = [
    (
        "character-memory",
        include_str!("../../../src/plugins/packages/character-memory/project02.plugin.json"),
        character_memory::create,
    ),
    (
        "character-state",
        include_str!("../../../src/plugins/packages/character-state/project02.plugin.json"),
        character_state::create,
    ),
    (
        "demo-config",
        include_str!("../../../src/plugins/packages/demo-config/project02.plugin.json"),
        demo_config::create,
    ),
    (
        "mem0",
        include_str!("../../../src/plugins/packages/mem0/project02.plugin.json"),
        mem0::create,
    ),
    (
        management::PLUGIN_ID,
        include_str!("management/project02.plugin.json"),
        management::create,
    ),
    (
        "session-history",
        include_str!("../../../src/plugins/packages/session-history/project02.plugin.json"),
        session_history::create,
    ),
];

type Listed = Vec<(Manifest, PluginFactory)>;

static LISTED: LazyLock<Result<Listed, BundledManifestError>> = LazyLock::new(|| {
    PLUGINS
        .iter()
        .map(|&(plugin, descriptor, factory)| Ok((manifest(plugin, descriptor)?, factory)))
        .collect()
});

/// Why a plugin compiled into the daemon has no manifest it can run: a
/// build that must not ship.
#[derive(Debug, thiserror::Error)]
pub enum BundledManifestError {
    #[error("the descriptor of plugin \"{plugin}\" is no JSON")]
    Descriptor {
        plugin: &'static str,
        #[source]
        source: serde_json::Error,
    },
    #[error("the manifest of plugin \"{plugin}\" is refused")]
    Manifest {
        plugin: &'static str,
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
/// [`BundledManifestError`] for the first plugin whose manifest does not
/// parse, at every call, so a build holding one fails at its first use.
pub fn plugins() -> Result<&'static [(Manifest, PluginFactory)], &'static BundledManifestError> {
    LISTED.as_deref()
}

/// The manifest a descriptor carries in its `manifest` member.
fn manifest(plugin: &'static str, descriptor: &str) -> Result<Manifest, BundledManifestError> {
    let descriptor: Value = serde_json::from_str(descriptor)
        .map_err(|source| BundledManifestError::Descriptor { plugin, source })?;

    Manifest::from_value(&descriptor["manifest"])
        .map_err(|source| BundledManifestError::Manifest { plugin, source })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_holds_every_plugin_under_its_own_id_on_by_its_manifest() {
        let listed: Vec<(&str, bool)> = plugins()
            .unwrap()
            .iter()
            .map(|(manifest, _)| {
                (
                    manifest.id().as_str(),
                    manifest.activation().default_enabled(),
                )
            })
            .collect();

        assert_eq!(
            listed,
            [
                ("character-memory", true),
                ("character-state", false),
                ("demo-config", false),
                ("mem0", false),
                ("runtime.plugin", true),
                ("session-history", true),
            ]
        );
    }
}
