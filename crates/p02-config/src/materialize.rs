//! A character's package's settings, merged into her overlay: at her first
//! start, and at the first start after her package changes version.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::Duration;

use p02_characters::{CharacterDefinition, CharacterVersion, PluginExpectations};
use p02_shared::Identifier;
use p02_store::{CharacterData, Home, StorageError};
use serde_json::{Map, Value};

use crate::declaration::{
    Declared, Layer, Namespace, Sections, VERSION, authorable, expectation, outside_scope,
};
use crate::diagnostic::{Code, Diagnostic};
use crate::document::{Document, Read};
use crate::resolve::{Overlay, Written, WrittenOverlay, in_overlay};
use crate::transaction::{settle, with_character};

/// Why a character's package's settings were not merged into her overlay;
/// in every case nothing was written for her.
#[derive(Debug, thiserror::Error)]
pub enum MaterializeError {
    /// Her package's settings are not ones her overlay may hold.
    #[error("the character package's plugin settings are invalid")]
    Package { diagnostics: Vec<Diagnostic> },
    /// The home's document, or her overlay, does not load.
    #[error("a settings document does not load")]
    Unloadable { diagnostics: Vec<Diagnostic> },
    #[error(transparent)]
    Storage(#[from] StorageError),
}

/// Merges `character`'s package's settings into her overlay before she
/// starts, and makes her data directory: on her first start, as an overlay
/// holding only them, its other values left to the home; on the first
/// start after a new version of her package, filling in only what she
/// lacks; otherwise not at all, so an edit of hers always stands. A change
/// to her settings made before then merges them as this does, and leaves
/// it nothing to merge. Her data directory is made only once her package's
/// settings and both documents are known to be good, and a lock another
/// writer holds is waited for as long as `wait` while it changes hands.
///
/// # Errors
///
/// [`MaterializeError`] when her package's settings are invalid, a
/// document does not load, or the store fails.
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
    let id = &character.profile.id;

    written
        .read
        .usable()
        .map_err(|diagnostics| MaterializeError::Unloadable { diagnostics })?;

    let absent = matches!(overlay.read, Read::Absent);
    let file = overlay
        .read
        .usable()
        .map_err(|diagnostics| MaterializeError::Unloadable {
            diagnostics: in_overlay(diagnostics, id, &overlay.path),
        })?;
    let (mut merged, problems) = merged_overlay(
        sections,
        character,
        overlay.path,
        file,
        absent,
        overlay.package_version.as_ref(),
    );

    if !problems.is_empty() {
        return Err(MaterializeError::Package {
            diagnostics: problems,
        });
    }

    Ok(settle(home, &mut merged)?)
}

/// Her overlay, `written` being what its file holds and `recorded` the
/// version of her package last merged into it, read with her package's
/// settings merged in while they are still to be merged, at her first
/// start and the first after her package changes version, as her start
/// merges them: what her settings are shown as, and what a change to them
/// edits. Beside it, why her package's settings cannot be merged, when
/// they cannot; she is then read as written.
pub(crate) fn merged_overlay(
    sections: &Sections,
    character: &CharacterDefinition,
    path: PathBuf,
    written: Document,
    absent: bool,
    recorded: Option<&CharacterVersion>,
) -> (Overlay, Vec<Diagnostic>) {
    let pending = absent || recorded != Some(&character.version);
    let (read, merges, problems) =
        match pending.then(|| package_document(sections, &character.plugins)) {
            None => (written.clone(), None, Vec::new()),
            Some(Ok(package)) => (
                Document::parse(merge_package(written.raw(), &package)),
                Some(character.version.clone()),
                Vec::new(),
            ),
            Some(Err(problems)) => (written.clone(), None, problems),
        };

    (
        Overlay {
            character: character.profile.id.clone(),
            path,
            written,
            read,
            merges,
        },
        problems,
    )
}

/// What her package contributes to her settings, as an overlay holding
/// only that: each plugin of this build it requires or recommends switched
/// on, and the values it gives; a plugin this build lacks configures
/// nothing, so nothing of it is copied. Or why it cannot: a package is
/// shared, so a credential in one would reach everyone who installs it,
/// and every value it gives must be one its field takes, set where a
/// character may set it.
pub(crate) fn package_document(
    sections: &Sections,
    expectations: &PluginExpectations,
) -> Result<Map<String, Value>, Vec<Diagnostic>> {
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
    let mut plugins = Map::new();
    let mut problems = Vec::new();

    for id in ids {
        let Some(declared) = sections.find(Namespace::Plugins, id.as_str()) else {
            continue;
        };
        let switches = switched_on.contains(id);
        let config = expectations.config().get(id);
        let mut stanza = Map::new();

        if switches {
            stanza.insert("enabled".to_owned(), Value::Bool(true));
        }

        if let Some(config) = config {
            stanza.insert("config".to_owned(), Value::Object(config.clone()));
        }

        problems.extend(package_problems(declared, switches, config));
        plugins.insert(id.to_string(), Value::Object(stanza));
    }

    if !problems.is_empty() {
        return Err(problems);
    }

    let mut document = Map::new();

    document.insert("version".to_owned(), Value::from(VERSION));

    if !plugins.is_empty() {
        document.insert("plugins".to_owned(), Value::Object(plugins));
    }

    Ok(document)
}

fn package_problems(
    declared: Declared<'_>,
    switches: bool,
    config: Option<&Map<String, Value>>,
) -> Vec<Diagnostic> {
    let id = declared.id().as_str();
    let mut problems = Vec::new();

    if switches && !authorable(declared.config().scope(), Layer::Overlay) {
        problems.push((
            format!("{}.enabled", declared.path()),
            outside_scope(id, None, Layer::Overlay),
        ));
    }

    for (name, value) in config.into_iter().flatten() {
        let path = declared.field_path(name);
        let sentence = match declared.config().field(name) {
            None => format!("Unknown config field \"{name}\" for section \"{id}\"."),
            Some(field) if field.secret() => format!(
                "Character package must not carry a credential for {path}; secret fields are \
                 the operator's to set."
            ),
            Some(field) if !authorable(declared.scope_of(field), Layer::Overlay) => {
                outside_scope(id, Some(name), Layer::Overlay)
            }
            Some(field) if !field.accepts(value) => format!(
                "Config field \"{name}\" of \"{id}\" must be {}.",
                expectation(field)
            ),
            Some(_) => continue,
        };

        problems.push((path, sentence));
    }

    problems
        .into_iter()
        .map(|(path, sentence)| {
            Diagnostic::error(
                Code::CharacterPackagePluginConfigInvalid,
                format!("Character package plugin config is invalid: {sentence}"),
            )
            .at(path)
        })
        .collect()
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
