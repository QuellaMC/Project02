//! The plugins compiled into the daemon: each one's manifest, read once
//! from the descriptor it keeps beside its code, the check of whether its
//! settings are enough to build it, and the factory that builds it.

use std::sync::LazyLock;

use p02_contracts::{Manifest, ManifestError, PluginFactory, ResolvedConfig, SetupCheck};
use serde_json::Value;

use crate::{
    character_memory, character_state, management, mem0, phone, reply_style, session_history,
};

/// Each plugin by its id, with its descriptor, its check and its factory:
/// the host's own first, then the packages in id order. Whatever lists or
/// runs them keeps this order, the model's tools among them.
const PLUGINS: [(&str, &str, SetupCheck, PluginFactory); 7] = [
    (
        p02_contracts::HOST_PLUGIN,
        include_str!("management/project02.plugin.json"),
        needs_nothing,
        management::create,
    ),
    (
        "character-memory",
        include_str!("character_memory/project02.plugin.json"),
        needs_nothing,
        character_memory::create,
    ),
    (
        "character-state",
        include_str!("character_state/project02.plugin.json"),
        needs_nothing,
        character_state::create,
    ),
    (
        "mem0",
        include_str!("mem0/project02.plugin.json"),
        mem0::check_setup,
        mem0::create,
    ),
    (
        "phone",
        include_str!("phone/project02.plugin.json"),
        needs_nothing,
        phone::create,
    ),
    (
        "reply-style",
        include_str!("reply_style/project02.plugin.json"),
        needs_nothing,
        reply_style::create,
    ),
    (
        "session-history",
        include_str!("session_history/project02.plugin.json"),
        needs_nothing,
        session_history::create,
    ),
];

/// The check of a plugin whose factory builds it from any settings.
#[expect(
    clippy::unnecessary_wraps,
    reason = "a check's signature is the contract's, whether or not it can fail"
)]
fn needs_nothing(_config: &ResolvedConfig) -> Result<(), String> {
    Ok(())
}

type Listed = Vec<(Manifest, SetupCheck, PluginFactory)>;

static LISTED: LazyLock<Result<Listed, BundledManifestError>> = LazyLock::new(|| {
    PLUGINS
        .iter()
        .map(|&(plugin, descriptor, check, factory)| {
            Ok((manifest(plugin, descriptor)?, check, factory))
        })
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
/// packages in id order, each with its check and its factory: what a
/// home's settings are judged against, and what a character's plugins are
/// built from.
///
/// # Errors
///
/// [`BundledManifestError`] for the first plugin whose manifest does not
/// parse, at every call, so a build holding one fails at its first use.
pub fn plugins()
-> Result<&'static [(Manifest, SetupCheck, PluginFactory)], &'static BundledManifestError> {
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
            .map(|(manifest, ..)| {
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
                ("phone", true),
                ("reply-style", false),
                ("session-history", true),
            ]
        );
    }
}
