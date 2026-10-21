//! The one way settings change: a change bound to the fingerprint its
//! author read, made in the target's own document, judged as the document
//! it makes over the documents beside it, and written whole.

use std::path::{Path, PathBuf};
use std::time::Duration;

use p02_characters::Discovery;
use p02_contracts::ConfigField;
use p02_shared::{Fingerprint, Identifier};
use p02_store::{CharacterData, Home, StorageError};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::declaration::{
    Declared, HostField, Namespace, Sections, Target, expectation, host_field, host_fields,
    outside_scope,
};
use crate::document::{Document, Read};
use crate::resolve::{Layers, Overlay, Resolution, Written, WrittenOverlay, target_fingerprint};
use crate::transaction::{with_character, with_home, write};
use crate::view::{chain, sentence};

/// Whose settings a view reads or a change writes: the home's, or one
/// character's.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "scope", rename_all = "snake_case", deny_unknown_fields)]
pub enum ConfigTarget {
    Global,
    Character {
        #[serde(rename = "characterId")]
        character_id: String,
    },
}

/// One change to one document, bound to the fingerprint its author read.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigChange {
    pub target: ConfigTarget,
    pub expected_fingerprint: String,
    pub operation: Operation,
}

/// What a change does: sets or unsets a host field, by its path
/// `project02.<name>`; switches a section on or off, or leaves it to the
/// document beneath when `enabled` is absent; or sets or unsets one field
/// of a section.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Set {
        path: String,
        value: Value,
    },
    Unset {
        path: String,
    },
    SectionEnabled {
        namespace: Namespace,
        id: String,
        #[serde(default)]
        enabled: Option<bool>,
    },
    SectionFieldSet {
        namespace: Namespace,
        id: String,
        field: String,
        value: Value,
    },
    SectionFieldUnset {
        namespace: Namespace,
        id: String,
        field: String,
    },
}

/// What came of a change. `Applied` means the document is on disk, under
/// the fingerprint it now has; `Refused` is the change itself, and
/// `Failed` a write that could not be made, either leaving every document
/// as it was.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ChangeOutcome {
    Applied {
        fingerprint: Fingerprint,
    },
    Refused {
        reason: ChangeRefusal,
        message: String,
    },
    Failed {
        message: String,
    },
}

/// Why a change was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeRefusal {
    /// The documents changed after its author read them.
    Conflict,
    /// The change, or the settings it would leave, is not one to make.
    Invalid,
    /// No installed character answers to its target.
    UnknownCharacter,
}

/// Makes `change`, waiting for a document another writer holds as long as
/// `wait` while it changes hands. The fingerprint presented is the
/// target's, or for a change to one section that section's: a secret's
/// presence counts in either, its value never, so two people replacing one
/// secret at once both succeed and the later value stands. A refused
/// change writes nothing, and makes no data directory for a character who
/// has none; a character's first change makes hers, as her first start
/// does. What a running character does about it is the runtime's to judge,
/// by comparing what she would now run on with what she runs on.
#[must_use]
pub fn apply_change(
    home: &Home,
    sections: &Sections,
    discovery: &Discovery,
    change: &ConfigChange,
    wait: Duration,
) -> ChangeOutcome {
    let target = match &change.target {
        ConfigTarget::Global => Target::Home,
        ConfigTarget::Character { character_id } => match discovery.find(character_id) {
            Ok(character) => Target::Character(character.profile.id.clone()),
            Err(error) => {
                return refused(
                    ChangeRefusal::UnknownCharacter,
                    sentence(&error.to_string()),
                );
            }
        },
    };
    let edit = match Edit::new(sections, &target, &change.operation) {
        Ok(edit) => edit,
        Err(message) => return refused(ChangeRefusal::Invalid, message),
    };
    let expected = change.expected_fingerprint.as_str();
    let committed = match &target {
        Target::Home => with_home(home, wait, |written| {
            commit(home, sections, Loaded::home(written), &edit, expected)
        }),
        Target::Character(character) => {
            with_character(home, character, wait, |written, overlay| {
                commit(
                    home,
                    sections,
                    Loaded::character(written, character, overlay),
                    &edit,
                    expected,
                )
            })
        }
    };

    committed.unwrap_or_else(|error| ChangeOutcome::Failed {
        message: sentence(&chain(&error)),
    })
}

/// Writes the home's document as a new home holds it, naming its version
/// and nothing else, unless a file is already there: whatever one holds,
/// it is the person's and stays as it is.
///
/// # Errors
///
/// [`StorageError`] when the store refuses the home, its document's lock
/// is not had within `wait`, or the write fails.
pub fn create_home_document(home: &Home, wait: Duration) -> Result<(), StorageError> {
    with_home(home, wait, |written| match written.read {
        Read::Absent => write(&written.path, Document::empty().raw()),
        Read::Unreadable(_) | Read::Document(_) => Ok(()),
    })
}

fn refused(reason: ChangeRefusal, message: String) -> ChangeOutcome {
    ChangeOutcome::Refused { reason, message }
}

/// A change, its own rules met: a field that exists, a target its scope
/// lets write it, and a value it takes.
#[derive(Debug)]
enum Edit<'s> {
    Host {
        field: &'static HostField,
        value: Option<Value>,
    },
    Switch {
        declared: Declared<'s>,
        enabled: Option<bool>,
    },
    Field {
        declared: Declared<'s>,
        field: &'s ConfigField,
        value: Option<Value>,
    },
}

impl<'s> Edit<'s> {
    fn new(sections: &'s Sections, target: &Target, operation: &Operation) -> Result<Self, String> {
        match operation {
            Operation::Set { path, value } => host_edit(path, Some(value)),
            Operation::Unset { path } => host_edit(path, None),
            Operation::SectionEnabled {
                namespace,
                id,
                enabled,
            } => {
                let declared = declared(sections, *namespace, id)?;

                if !target.authors(declared.config().scope()) {
                    return Err(outside_scope(id, None, target.own_layer()));
                }

                Ok(Self::Switch {
                    declared,
                    enabled: *enabled,
                })
            }
            Operation::SectionFieldSet {
                namespace,
                id,
                field,
                value,
            } => field_edit(sections, target, *namespace, id, field, Some(value)),
            Operation::SectionFieldUnset {
                namespace,
                id,
                field,
            } => field_edit(sections, target, *namespace, id, field, None),
        }
    }

    fn section(&self) -> Option<Declared<'s>> {
        match self {
            Self::Host { .. } => None,
            Self::Switch { declared, .. } | Self::Field { declared, .. } => Some(*declared),
        }
    }

    /// Makes the change in `document`, leaving no object empty behind it.
    fn apply(&self, document: &mut Map<String, Value>) -> Result<(), String> {
        match self {
            Self::Host { field, value } => {
                edit(document, &["project02"], field.name(), value.as_ref())
            }
            Self::Switch { declared, enabled } => edit(
                document,
                &[declared.namespace().as_str(), declared.id().as_str()],
                "enabled",
                enabled.map(Value::Bool).as_ref(),
            ),
            Self::Field {
                declared,
                field,
                value,
            } => edit(
                document,
                &[
                    declared.namespace().as_str(),
                    declared.id().as_str(),
                    "config",
                ],
                field.name().as_str(),
                value.as_ref(),
            ),
        }
    }
}

fn host_edit(path: &str, value: Option<&Value>) -> Result<Edit<'static>, String> {
    let field = path
        .strip_prefix("project02.")
        .and_then(host_field)
        .ok_or_else(|| {
            let paths: Vec<String> = host_fields().iter().map(HostField::path).collect();

            format!(
                "Unknown config field \"{path}\". Fields: {}.",
                paths.join(", ")
            )
        })?;

    if let Some(value) = value
        && !field.accepts(value)
    {
        return Err(format!("{} Path: {path}.", field.sentence));
    }

    Ok(Edit::Host {
        field,
        value: value.cloned(),
    })
}

fn declared<'s>(
    sections: &'s Sections,
    namespace: Namespace,
    id: &str,
) -> Result<Declared<'s>, String> {
    sections.find(namespace, id).ok_or_else(|| {
        format!(
            "Section \"{id}\" under {} does not exist.",
            namespace.as_str()
        )
    })
}

fn field_edit<'s>(
    sections: &'s Sections,
    target: &Target,
    namespace: Namespace,
    id: &str,
    name: &str,
    value: Option<&Value>,
) -> Result<Edit<'s>, String> {
    let declared = declared(sections, namespace, id)?;
    let field = declared.config().field(name).ok_or_else(|| {
        let names: Vec<&str> = declared
            .config()
            .fields()
            .iter()
            .map(|field| field.name().as_str())
            .collect();

        format!(
            "Section \"{id}\" does not declare config field \"{name}\". Declared fields: {}.",
            if names.is_empty() {
                "none".to_owned()
            } else {
                names.join(", ")
            }
        )
    })?;

    if !target.authors(declared.scope_of(field)) {
        return Err(outside_scope(id, Some(name), target.own_layer()));
    }

    if let Some(value) = value
        && !field.accepts(value)
    {
        return Err(if field.secret() {
            format!(
                "Secret config field \"{name}\" of \"{id}\" must be a non-blank string; unset it \
                 to remove it."
            )
        } else {
            format!(
                "Config field \"{name}\" of \"{id}\" must be {}.",
                expectation(field)
            )
        });
    }

    Ok(Edit::Field {
        declared,
        field,
        value: value.cloned(),
    })
}

/// Sets `key` to `value`, or removes it when `value` is `None`, in the
/// object at `parents` below `object`, making the objects on the way to a
/// value and removing those a removal leaves empty.
fn edit(
    object: &mut Map<String, Value>,
    parents: &[&str],
    key: &str,
    value: Option<&Value>,
) -> Result<(), String> {
    let Some((first, rest)) = parents.split_first() else {
        match value {
            Some(value) => {
                object.insert(key.to_owned(), value.clone());
            }
            None => {
                object.shift_remove(key);
            }
        }

        return Ok(());
    };

    if value.is_some() && !object.contains_key(*first) {
        object.insert((*first).to_owned(), Value::Object(Map::new()));
    }

    match object.get_mut(*first) {
        None => Ok(()),
        Some(Value::Object(inner)) => {
            edit(inner, rest, key, value)?;

            if inner.is_empty() {
                object.shift_remove(*first);
            }

            Ok(())
        }
        Some(_) => Err(format!(
            "\"{first}\" is not an object in this document, so nothing in it can change."
        )),
    }
}

/// The change, made under the locks: the documents must load, the
/// target's own only as far as its file holds an object a change may
/// repair; the fingerprint must still be the one read; and the document
/// made must be valid, and leave the section it changes without an error
/// over the documents beside it.
fn commit(
    home: &Home,
    sections: &Sections,
    loaded: Result<Loaded, String>,
    edit: &Edit<'_>,
    expected: &str,
) -> Result<ChangeOutcome, StorageError> {
    let loaded = match loaded {
        Ok(loaded) => loaded,
        Err(message) => return Ok(refused(ChangeRefusal::Invalid, message)),
    };
    let current = Resolution::new(sections, loaded.layers(), Vec::new());
    let bound = current.fingerprint().as_str() == expected
        || edit.section().is_some_and(|declared| {
            current
                .section(declared.namespace(), declared.id().as_str())
                .is_some_and(|section| section.fingerprint.as_str() == expected)
        });

    if !bound {
        return Ok(refused(
            ChangeRefusal::Conflict,
            "The settings changed after they were read: read them again, then make the change."
                .to_owned(),
        ));
    }

    let mut raw = loaded.own().raw().clone();

    if let Err(message) = edit.apply(&mut raw) {
        return Ok(refused(ChangeRefusal::Invalid, message));
    }

    let unchanged = raw == *loaded.own().raw();
    let made = Document::parse(raw);

    if let Some(problem) = made.problems().first() {
        return Ok(refused(
            ChangeRefusal::Invalid,
            format!(
                "The change would leave the settings invalid: {}",
                problem.message()
            ),
        ));
    }

    let after = loaded.with_own(made);

    if let Some(declared) = edit.section() {
        let judged = Resolution::new(sections, after.layers(), Vec::new());
        let error = judged
            .section(declared.namespace(), declared.id().as_str())
            .and_then(|section| section.diagnostics.iter().find(|found| found.is_error()));

        if let Some(error) = error {
            return Ok(refused(
                ChangeRefusal::Invalid,
                format!("Cannot change \"{}\": {}", declared.id(), error.message()),
            ));
        }
    }

    if unchanged {
        return Ok(ChangeOutcome::Applied {
            fingerprint: current.fingerprint().clone(),
        });
    }

    if let Some((character, _, _)) = &after.overlay {
        CharacterData::ensure(home, character)?;
    }

    write(after.own_path(), after.own().raw())?;

    Ok(ChangeOutcome::Applied {
        fingerprint: target_fingerprint(sections, &after.layers()),
    })
}

/// A target's documents as a change finds them.
struct Loaded {
    home_path: PathBuf,
    home: Document,
    overlay: Option<(Identifier, PathBuf, Document)>,
}

impl Loaded {
    /// The home's document, which a change may repair while its file holds
    /// an object.
    fn home(written: Written) -> Result<Self, String> {
        Ok(Self {
            home: repairable(written.read)
                .map_err(|message| format!("The home's settings failed to load: {message}"))?,
            home_path: written.path,
            overlay: None,
        })
    }

    /// The home's document, which must load for a change to her settings to
    /// be judged over it, and her overlay, which a change may repair.
    fn character(
        written: Written,
        character: &Identifier,
        overlay: WrittenOverlay,
    ) -> Result<Self, String> {
        let home = written.read.usable().map_err(|diagnostics| {
            let reason = diagnostics
                .first()
                .map(|diagnostic| diagnostic.message().to_owned())
                .unwrap_or_default();

            format!("The home's settings failed to load: {reason}")
        })?;
        let document = repairable(overlay.read).map_err(|message| {
            format!("The settings of \"{character}\" failed to load: {message}")
        })?;

        Ok(Self {
            home_path: written.path,
            home,
            overlay: Some((character.clone(), overlay.path, document)),
        })
    }

    /// The document the change is made in.
    fn own(&self) -> &Document {
        self.overlay
            .as_ref()
            .map_or(&self.home, |(_, _, document)| document)
    }

    fn own_path(&self) -> &Path {
        self.overlay
            .as_ref()
            .map_or(&self.home_path, |(_, path, _)| path)
    }

    fn with_own(mut self, made: Document) -> Self {
        match &mut self.overlay {
            Some((_, _, document)) => *document = made,
            None => self.home = made,
        }

        self
    }

    fn layers(&self) -> Layers {
        Layers {
            home_path: self.home_path.clone(),
            home_present: true,
            home: self.home.clone(),
            overlay: self
                .overlay
                .as_ref()
                .map(|(character, path, document)| Overlay {
                    character: character.clone(),
                    path: path.clone(),
                    written: document.clone(),
                    read: document.clone(),
                }),
        }
    }
}

/// The document a change starts from: an absent file's empty one, or what
/// the file holds, though invalid, so a change can repair it; a file that
/// holds no document is refused with what keeps it from loading.
fn repairable(read: Read) -> Result<Document, String> {
    match read {
        Read::Absent => Ok(Document::empty()),
        Read::Document(document) => Ok(document),
        Read::Unreadable(diagnostic) => Err(diagnostic.message().to_owned()),
    }
}
