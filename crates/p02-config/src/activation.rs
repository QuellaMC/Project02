//! What a character's settings make of her plugins beyond each section's
//! own judgment: the memory provider they choose, and the plugins her
//! package expects.

use std::collections::BTreeSet;

use p02_characters::CharacterDefinition;
use p02_shared::Identifier;

use crate::declaration::Namespace;
use crate::diagnostic::{Code, Diagnostic};
use crate::host::DEFAULT_MEMORY_PROVIDER;
use crate::resolve::{Section, Status};

/// What `character`'s settings make of her plugins, `resolved` being her
/// sections and `chosen` her memory provider.
pub(crate) fn judge(
    character: &CharacterDefinition,
    chosen: Option<&str>,
    resolved: &[Section<'_>],
) -> Vec<Diagnostic> {
    memory_provider(chosen, resolved)
        .into_iter()
        .chain(expected(character, resolved))
        .collect()
}

/// The memory provider her settings choose must be a memory plugin she
/// runs, or she has no memory to keep: an error that stops her.
fn memory_provider(chosen: Option<&str>, resolved: &[Section<'_>]) -> Option<Diagnostic> {
    let chosen = chosen?;
    let runs = resolved.iter().any(|section| {
        section.declared.is_memory_provider()
            && section.declared.id().as_str() == chosen
            && matches!(section.status, Status::Active(_))
    });

    (!runs).then(|| {
        let path = DEFAULT_MEMORY_PROVIDER.path();

        Diagnostic::error(
            Code::MemoryProviderUnavailable,
            format!(
                "The memory provider \"{chosen}\" her settings choose is not a memory plugin she \
                 runs. Switch it on, or choose another in {path}."
            ),
        )
        .at(path)
    })
}

/// The plugins her package expects that she does not run, a warning each:
/// she starts without them.
fn expected(character: &CharacterDefinition, resolved: &[Section<'_>]) -> Vec<Diagnostic> {
    let expected: BTreeSet<&Identifier> = character
        .plugins
        .required()
        .iter()
        .chain(character.plugins.recommended())
        .collect();

    expected
        .into_iter()
        .filter_map(|plugin| {
            let status = resolved
                .iter()
                .find(|section| {
                    section.declared.namespace() == Namespace::Plugins
                        && section.declared.id() == plugin
                })
                .map(|section| section.status);
            let why = match status {
                None => "which this build does not have",
                Some(Status::Active(_)) => return None,
                Some(Status::Blocked) => "which her settings block",
                Some(Status::Disabled(_)) => "which her settings switch off",
            };

            Some(
                Diagnostic::warning(
                    Code::PluginNotRunning,
                    format!(
                        "Character \"{}\" expects plugin \"{plugin}\", {why}.",
                        character.profile.id
                    ),
                )
                .at(format!("plugins.{plugin}"))
                .in_section(Namespace::Plugins, plugin.as_str()),
            )
        })
        .collect()
}
