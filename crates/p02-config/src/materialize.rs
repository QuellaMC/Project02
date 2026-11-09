//! A character's package's settings, merged into her overlay: at her first
//! start, and at the first start after her package changes version.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::Duration;

use p02_characters::{CharacterDefinition, CharacterVersion, PluginExpectations};
use p02_contracts::{ConfigField, ConfigValueType};
use p02_shared::Identifier;
use p02_store::{CharacterData, Home, StorageError};
use serde_json::{Map, Value};

use crate::change::{Edit, Operation};
use crate::declaration::{Namespace, Sections, Target};
use crate::diagnostic::{Code, Diagnostic};
use crate::document::{Document, Read};
use crate::resolve::{Overlay, Written, WrittenOverlay};
use crate::transaction::{settle, with_character};

/// Why a character's package's settings were not merged into her overlay;
/// in every case nothing was written for her.
#[derive(Debug, thiserror::Error)]
pub enum MaterializeError {
    /// The home's document, or her overlay, cannot be read.
    #[error("a settings document does not load")]
    Unreadable(Box<Diagnostic>),
    #[error(transparent)]
    Storage(#[from] StorageError),
}

/// Merges `character`'s package's settings into her overlay before she
/// starts, and makes her data directory: on her first start, as an overlay
/// holding only them, its other values left to the home; on the first
/// start after a new version of her package, filling in only what she
/// lacks; otherwise not at all, so an edit of hers always stands. A change
/// to her settings made before then merges them as this does, and leaves
/// it nothing to merge. Her data directory is made only once both
/// documents are known to be readable, and a lock another writer holds is
/// waited for as long as `wait` while it changes hands.
///
/// # Errors
///
/// [`MaterializeError`] when a document cannot be read, or the store
/// fails.
pub fn materialize(
    home: &Home,
    sections: &Sections,
    character: &CharacterDefinition,
    wait: Duration,
) -> Result<CharacterData, MaterializeError> {
    with_character(home, &character.profile.id, wait, |written, overlay| {
        Ok(start(home, sections, character, written, overlay))
    })?
}

fn start(
    home: &Home,
    sections: &Sections,
    character: &CharacterDefinition,
    written: Written,
    overlay: WrittenOverlay,
) -> Result<CharacterData, MaterializeError> {
    written
        .read
        .usable()
        .map_err(MaterializeError::Unreadable)?;

    let absent = matches!(overlay.read, Read::Absent);
    let file = overlay.read.usable().map_err(|diagnostic| {
        let id = &character.profile.id;

        MaterializeError::Unreadable(Box::new(diagnostic.in_overlay(id, &overlay.path)))
    })?;
    let (mut merged, _) = merged_overlay(
        sections,
        character,
        overlay.path,
        file,
        absent,
        overlay.package_version.as_ref(),
    );

    Ok(settle(home, &mut merged)?)
}

/// Her overlay, `written` being what its file holds and `recorded` the
/// version of her package last merged into it, read with her package's
/// settings merged in while they are still to be merged, at her first
/// start and the first after her package changes version, as her start
/// merges them: what her settings are shown as, and what a change to them
/// edits. Beside it, what of her package's settings is skipped.
pub(crate) fn merged_overlay(
    sections: &Sections,
    character: &CharacterDefinition,
    path: PathBuf,
    written: Document,
    absent: bool,
    recorded: Option<&CharacterVersion>,
) -> (Overlay, Vec<Diagnostic>) {
    let id = &character.profile.id;
    let (package, skipped) = package_document(sections, id, &character.plugins);
    let pending = absent || recorded != Some(&character.version);
    let read = if pending {
        Document::parse(merge_package(written.raw(), &package))
    } else {
        written.clone()
    };

    (
        Overlay {
            character: id.clone(),
            path,
            written,
            read,
            merges: pending.then(|| character.version.clone()),
        },
        skipped,
    )
}

/// What her package contributes to her settings, as an overlay holding
/// only that: each plugin of this build it expects switched on, and the
/// values it gives, each made as a change on her own screen would make it.
/// A plugin this build lacks configures nothing. A value her screen could
/// not set is skipped, as is a credential, a server or a path: a package
/// may come from a stranger, and those are the person's to choose.
pub(crate) fn package_document(
    sections: &Sections,
    character: &Identifier,
    expectations: &PluginExpectations,
) -> (Map<String, Value>, Vec<Diagnostic>) {
    let target = Target::Character(character.clone());
    let switched_on: BTreeSet<&Identifier> = expectations
        .required()
        .iter()
        .chain(expectations.recommended())
        .collect();
    let ids: BTreeSet<&Identifier> = switched_on
        .iter()
        .copied()
        .chain(expectations.config().keys())
        .collect();
    let mut document = Document::empty().raw().clone();
    let mut skipped = Vec::new();

    for id in ids {
        let Some(declared) = sections.find(Namespace::Plugins, id.as_str()) else {
            continue;
        };
        let mut operations = Vec::new();

        if switched_on.contains(id) {
            operations.push((
                format!("{}.enabled", declared.path()),
                Ok(Operation::SectionEnabled {
                    namespace: Namespace::Plugins,
                    id: id.to_string(),
                    enabled: Some(true),
                }),
            ));
        }

        for (name, value) in expectations.config().get(id).into_iter().flatten() {
            let operation = match declared.config().field(name) {
                Some(field) if !package_may_set(field) => Err(
                    "A package never sets a credential, a server or a path: those are the \
                     person's to choose."
                        .to_owned(),
                ),
                _ => Ok(Operation::SectionFieldSet {
                    namespace: Namespace::Plugins,
                    id: id.to_string(),
                    field: name.clone(),
                    value: value.clone(),
                }),
            };

            operations.push((declared.field_path(name), operation));
        }

        for (path, operation) in operations {
            let made = operation
                .and_then(|operation| Edit::new(sections, &target, &operation))
                .and_then(|edit| edit.apply(&mut document));

            if let Err(why) = made {
                skipped.push(
                    Diagnostic::warning(
                        Code::PackageValueSkipped,
                        format!("Her package's {path} is not used. {why}"),
                    )
                    .at(path)
                    .in_section(Namespace::Plugins, id.as_str()),
                );
            }
        }
    }

    (document, skipped)
}

/// Whether a package may give `field` a value: never a credential, a
/// server the plugin sends to, or a place on the person's machine.
fn package_may_set(field: &ConfigField) -> bool {
    !field.secret()
        && !matches!(
            field.value_type(),
            Some(ConfigValueType::Url | ConfigValueType::Path)
        )
}

/// Her overlay with her package's settings filled in where she has none:
/// the package's stanza of a plugin she has none for, and in a stanza of
/// hers its switch and each field she leaves unset. Nothing she set
/// changes, and a stanza or a config of hers that is no object is left as
/// it is, for its diagnostic to name.
pub(crate) fn merge_package(
    overlay: &Map<String, Value>,
    package: &Map<String, Value>,
) -> Map<String, Value> {
    let mut merged = overlay.clone();

    if let Some(Value::Object(offered)) = package.get("plugins")
        && let Value::Object(plugins) = merged
            .entry("plugins")
            .or_insert_with(|| Value::Object(Map::new()))
    {
        for (id, stanza) in offered {
            match plugins.get_mut(id) {
                None => {
                    plugins.insert(id.clone(), stanza.clone());
                }
                Some(Value::Object(ours)) => fill(ours, stanza),
                Some(_) => {}
            }
        }
    }

    merged
}

fn fill(ours: &mut Map<String, Value>, offered: &Value) {
    let Value::Object(offered) = offered else {
        return;
    };

    if let Some(enabled) = offered.get("enabled") {
        ours.entry("enabled").or_insert_with(|| enabled.clone());
    }

    if let Some(Value::Object(fields)) = offered.get("config")
        && let Value::Object(config) = ours
            .entry("config")
            .or_insert_with(|| Value::Object(Map::new()))
    {
        for (name, value) in fields {
            config.entry(name).or_insert_with(|| value.clone());
        }
    }
}
