//! The plugins compiled into the daemon: each one's manifest, read once
//! from the descriptor it keeps beside its code, and the factory that
//! builds it.

use std::sync::LazyLock;

use p02_contracts::{Manifest, ManifestError, PluginFactory};
use serde_json::Value;

use crate::{character_memory, character_state, management, mem0, reply_style, session_history};

/// Each plugin by its id, with its descriptor and its factory: the host's
/// own first, then the packages in id order. Whatever lists or runs them
/// keeps this order, the model's tools among them.
const PLUGINS: [(&str, &str, PluginFactory); 6] = [
    (
        p02_contracts::HOST_PLUGIN,
        include_str!("management/project02.plugin.json"),
        management::create,
    ),
    (
        "character-memory",
        include_str!("character_memory/project02.plugin.json"),
        character_memory::create,
    ),
    (
        "character-state",
        include_str!("character_state/project02.plugin.json"),
        character_state::create,
    ),
    (
        "mem0",
        include_str!("mem0/project02.plugin.json"),
        mem0::create,
    ),
    (
        "reply-style",
        include_str!("reply_style/project02.plugin.json"),
        reply_style::create,
    ),
    (
        "session-history",
        include_str!("session_history/project02.plugin.json"),
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

/// The plugins compiled into the daemon, the host's own first and then the
/// packages in id order: what a home's settings are judged against, and
/// what a character's plugins are built from.
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
                ("runtime.plugin", true),
                ("character-memory", true),
                ("character-state", false),
                ("mem0", false),
                ("reply-style", false),
                ("session-history", true),
            ]
        );
    }
}
