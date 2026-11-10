//! What a character's settings make of her plugins beyond each section's
//! own judgment: the plugins her package expects that she does not run.

use std::collections::BTreeSet;

use p02_characters::CharacterDefinition;
use p02_shared::Identifier;
use p02_wire::{Code, Diagnostic, Namespace};

use crate::resolve::{Section, Status};

/// The plugins `character`'s package expects that she does not run,
/// `resolved` being her sections: a warning each, and she starts without
/// them.
pub(crate) fn expected(
    character: &CharacterDefinition,
    resolved: &[Section<'_>],
) -> Vec<Diagnostic> {
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
