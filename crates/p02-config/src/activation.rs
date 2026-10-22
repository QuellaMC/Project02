//! What a character's settings make of her plugins beyond each section's
//! own judgment: the memory provider they choose, the plugins her package
//! requires or recommends, and that an error in them stops her, so no
//! plugin of hers runs on settings partly wrong: every one but the host's
//! own is blocked by it.

use p02_characters::CharacterDefinition;
use p02_contracts::{HOST_PLUGIN, PluginKind};
use p02_shared::Identifier;

use crate::declaration::{Declared, Namespace, Sections};
use crate::diagnostic::{Code, Diagnostic};
use crate::resolve::{Section, Status};

const MEMORY_PROVIDER: &str = "project02.defaultMemoryProvider";

/// Judges `resolved`, `character`'s sections, as what she runs, `chosen`
/// her memory provider, adding what it finds to `diagnostics`; once a
/// finding among them stops her, every plugin she would run but the host's
/// own is blocked.
pub(crate) fn judge(
    sections: &Sections,
    character: &CharacterDefinition,
    chosen: Option<&str>,
    resolved: &mut [Section<'_>],
    diagnostics: &mut Vec<Diagnostic>,
) {
    diagnostics.extend(memory_provider(sections, chosen, resolved));
    diagnostics.extend(expectations(character, resolved));

    if diagnostics.iter().any(Diagnostic::stops_character) {
        for section in resolved.iter_mut().filter(|section| {
            section.declared.namespace() == Namespace::Plugins
                && section.declared.id().as_str() != HOST_PLUGIN
                && matches!(section.status, Status::Active(_))
        }) {
            section.status = Status::Blocked;
        }
    }
}

/// The memory provider her settings choose must be a memory plugin she
/// runs; when they choose none, she runs one at most.
fn memory_provider(
    sections: &Sections,
    chosen: Option<&str>,
    resolved: &[Section<'_>],
) -> Option<Diagnostic> {
    let running: Vec<&str> = resolved
        .iter()
        .filter(|section| {
            section.declared.is_memory_provider() && matches!(section.status, Status::Active(_))
        })
        .map(|section| section.declared.id().as_str())
        .collect();

    match chosen {
        Some(chosen) if running.contains(&chosen) => None,
        Some(chosen) => Some(
            match sections.find(Namespace::Plugins, chosen) {
                Some(Declared::Plugin(manifest))
                    if manifest.kind() != PluginKind::MemoryProvider =>
                {
                    Diagnostic::error(
                        Code::DefaultMemoryProviderNotMemoryProvider,
                        format!(
                            "The memory provider \"{chosen}\" her settings choose is a {} \
                             plugin, not a memory plugin. Choose a memory plugin in \
                             {MEMORY_PROVIDER}.",
                            manifest.kind()
                        ),
                    )
                    .in_section(Namespace::Plugins, chosen)
                }
                Some(_) => Diagnostic::error(
                    Code::DefaultMemoryProviderUnavailable,
                    format!(
                        "The memory provider \"{chosen}\" her settings choose is not switched \
                         on. Switch it on, or choose another in {MEMORY_PROVIDER}."
                    ),
                )
                .in_section(Namespace::Plugins, chosen),
                None => Diagnostic::error(
                    Code::DefaultMemoryProviderUnavailable,
                    format!(
                        "The memory provider \"{chosen}\" her settings choose is no plugin this \
                         build has. Choose one it has in {MEMORY_PROVIDER}."
                    ),
                ),
            }
            .at(MEMORY_PROVIDER),
        ),
        None if running.len() > 1 => Some(
            Diagnostic::error(
                Code::AmbiguousMemoryProviderSelection,
                format!(
                    "Her settings switch on more than one memory plugin ({}) and choose none. \
                     Choose one in {MEMORY_PROVIDER}.",
                    running.join(", ")
                ),
            )
            .at(MEMORY_PROVIDER),
        ),
        None => None,
    }
}

/// How much her package wants a plugin.
#[derive(Clone, Copy)]
enum Expectation {
    /// She does not start without it.
    Required,
    /// She starts without it, warned.
    Recommended,
}

/// The plugins her package expects that she does not run: a required one
/// stops her, a recommended one only warns.
fn expectations(character: &CharacterDefinition, resolved: &[Section<'_>]) -> Vec<Diagnostic> {
    let expected = &character.plugins;
    let required = expected
        .required()
        .iter()
        .map(|plugin| (plugin, Expectation::Required));
    let recommended = expected
        .recommended()
        .iter()
        .filter(|plugin| !expected.required().contains(plugin))
        .map(|plugin| (plugin, Expectation::Recommended));

    required
        .chain(recommended)
        .filter_map(|(plugin, expectation)| {
            unmet(&character.profile.id, plugin, expectation, resolved)
        })
        .collect()
}

fn unmet(
    character: &Identifier,
    plugin: &Identifier,
    expectation: Expectation,
    resolved: &[Section<'_>],
) -> Option<Diagnostic> {
    let (verb, missing, off) = match expectation {
        Expectation::Required => (
            "requires",
            Code::CharacterRequiredPluginMissing,
            Code::CharacterRequiredPluginDisabled,
        ),
        Expectation::Recommended => (
            "recommends",
            Code::CharacterRecommendedPluginMissing,
            Code::CharacterRecommendedPluginDisabled,
        ),
    };
    let finding = |code, why: &str| {
        let message = format!("Character \"{character}\" {verb} plugin \"{plugin}\", {why}");

        match expectation {
            Expectation::Required => Diagnostic::error(code, message),
            Expectation::Recommended => Diagnostic::warning(code, message),
        }
        .in_section(Namespace::Plugins, plugin.as_str())
    };
    let section = resolved.iter().find(|section| {
        section.declared.namespace() == Namespace::Plugins && section.declared.id() == plugin
    });

    match section {
        None => Some(
            finding(missing, "which this build does not have.").at(format!("plugins.{plugin}")),
        ),
        Some(section) => {
            let why = match section.status {
                Status::Active(_) => return None,
                Status::Blocked => "which her settings block.",
                Status::Disabled(_) => {
                    "which her settings switch off. Switch it on in her settings."
                }
            };

            Some(finding(off, why).at(format!("{}.enabled", section.declared.path())))
        }
    }
}
