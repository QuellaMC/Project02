//! The one way settings change: a change bound to the fingerprint its
//! author read, judged by its own rules alone, made in the target's own
//! document, and written whole.

use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

use p02_characters::{CharacterDefinition, Discovery};
use p02_contracts::ConfigField;
use p02_shared::{Fingerprint, error_sentence, sentence};
use p02_store::{Home, StorageError};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::declaration::{Declared, Namespace, Sections, Target, expectation, outside_scope};
use crate::document::{Document, Read};
use crate::host::{HostField, host_field, host_fields};
use crate::materialize::merged_overlay;
use crate::resolve::{Layers, Overlay, Written, WrittenOverlay, target_fingerprint};
use crate::transaction::{settle, with_character, with_home, write};

/// Whose settings a view reads or a change writes: the home's, or one
/// character's.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, JsonSchema, TS)]
#[serde(tag = "scope", rename_all = "snake_case", deny_unknown_fields)]
pub enum ConfigTarget {
    Global,
    Character {
        #[serde(rename = "characterId")]
        character_id: String,
    },
}

/// One change to one document, bound to the fingerprint its author read.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, TS)]
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
#[derive(Clone, PartialEq, Deserialize, JsonSchema, TS)]
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
        #[serde(default, deserialize_with = "given_switch")]
        #[schemars(with = "bool")]
        #[ts(optional)]
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

/// A switch a change gives: a boolean, or, when `enabled` is absent, none,
/// which leaves the switch to the document beneath. A null is no switch.
fn given_switch<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<bool>, D::Error> {
    bool::deserialize(deserializer).map(Some)
}

/// Says what the change does and where, never the value it sets: that may
/// be a secret.
impl fmt::Debug for Operation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Set { path, .. } => formatter
                .debug_struct("Set")
                .field("path", path)
                .finish_non_exhaustive(),
            Self::Unset { path } => formatter.debug_struct("Unset").field("path", path).finish(),
            Self::SectionEnabled {
                namespace,
                id,
                enabled,
            } => formatter
                .debug_struct("SectionEnabled")
                .field("namespace", namespace)
                .field("id", id)
                .field("enabled", enabled)
                .finish(),
            Self::SectionFieldSet {
                namespace,
                id,
                field,
                ..
            } => formatter
                .debug_struct("SectionFieldSet")
                .field("namespace", namespace)
                .field("id", id)
                .field("field", field)
                .finish_non_exhaustive(),
            Self::SectionFieldUnset {
                namespace,
                id,
                field,
            } => formatter
                .debug_struct("SectionFieldUnset")
                .field("namespace", namespace)
                .field("id", id)
                .field("field", field)
                .finish(),
        }
    }
}

/// What came of a change. `Applied` means the document is on disk, under
/// the fingerprint it now has; `Refused` is the change itself, and
/// `Failed` a write that could not be made, either leaving every document
/// as it was.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(rename = "ConfigChangeOutcome")]
#[schemars(rename = "ConfigChangeOutcome")]
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
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
/// target's: a secret's presence counts in it, its value never, so two
/// people replacing one secret at once both succeed and the later value
/// stands. A change is refused for its own faults alone, never for
/// something else its documents hold. A refused change writes nothing, and
/// makes no data directory for a character who has none; a character's
/// first change makes hers, as her first start does, and is made in her
/// settings as her view shows them, with her package's settings merged in
/// while they are still to be, as her start merges them, so her start
/// finds nothing left to merge. What a running
/// character does about it is the runtime's to judge, by comparing what
/// she would now run on with what she runs on.
#[must_use]
pub fn apply_change(
    home: &Home,
    sections: &Sections,
    discovery: &Discovery,
    change: &ConfigChange,
    wait: Duration,
) -> ChangeOutcome {
    let (character, edit) = match admitted(sections, discovery, change) {
        Ok(admitted) => admitted,
        Err(refusal) => return refusal,
    };
    let expected = change.expected_fingerprint.as_str();
    let committed = match character {
        None => with_home(home, wait, |written| {
            commit(home, sections, Loaded::home(written), &edit, expected)
        }),
        Some(character) => with_character(home, &character.profile.id, wait, |written, overlay| {
            commit(
                home,
                sections,
                Loaded::character(sections, written, character, overlay),
                &edit,
                expected,
            )
        }),
    };

    committed.unwrap_or_else(|error| ChangeOutcome::Failed {
        message: error_sentence(&error),
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

/// The refusal [`apply_change`] would meet before reading any document: no
/// character answers to the change's target, or the change breaks its own
/// rules, a field that does not exist, a scope that does not let its
/// target write it, or a value the field does not take. A caller that asks
/// someone about a change checks it here first.
#[must_use]
pub fn check_change(
    sections: &Sections,
    discovery: &Discovery,
    change: &ConfigChange,
) -> Option<ChangeOutcome> {
    admitted(sections, discovery, change).err()
}

/// The character `change` targets, if any, and the edit it makes.
fn admitted<'d, 's>(
    sections: &'s Sections,
    discovery: &'d Discovery,
    change: &ConfigChange,
) -> Result<(Option<&'d CharacterDefinition>, Edit<'s>), ChangeOutcome> {
    let character = match &change.target {
        ConfigTarget::Global => None,
        ConfigTarget::Character { character_id } => {
            Some(discovery.find(character_id).map_err(|error| {
                refused(
                    ChangeRefusal::UnknownCharacter,
                    sentence(&error.to_string()),
                )
            })?)
        }
    };
    let target = character.map_or(Target::Home, |character| {
        Target::Character(character.profile.id.clone())
    });
    let edit = Edit::new(sections, &target, &change.operation)
        .map_err(|message| refused(ChangeRefusal::Invalid, message))?;

    Ok((character, edit))
}

fn refused(reason: ChangeRefusal, message: String) -> ChangeOutcome {
    ChangeOutcome::Refused { reason, message }
}

/// A change, its own rules met: a field that exists, a target its scope
/// lets write it, and a value it takes.
#[derive(Debug)]
pub(crate) enum Edit<'s> {
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
    /// `operation` on `target`'s own document, or the sentence saying why
    /// it breaks its own rules.
    pub(crate) fn new(
        sections: &'s Sections,
        target: &Target,
        operation: &Operation,
    ) -> Result<Self, String> {
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

    /// Makes the change in `document`, leaving no object empty behind it.
    pub(crate) fn apply(&self, document: &mut Map<String, Value>) -> Result<(), String> {
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

/// The change, made under the locks: the documents must be readable, and
/// the fingerprint still the one read.
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
    let current = target_fingerprint(sections, &loaded.layers());

    if current.as_str() != expected {
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

    let made = Document::parse(raw);

    if loaded.holds(&made) {
        return Ok(ChangeOutcome::Applied {
            fingerprint: current,
        });
    }

    let fingerprint = target_fingerprint(sections, &loaded.layers_with(&made));

    loaded.write(home, &made)?;

    Ok(ChangeOutcome::Applied { fingerprint })
}

/// A target's documents as a change finds them.
struct Loaded {
    home_path: PathBuf,
    home: Document,
    overlay: Option<Overlay>,
}

impl Loaded {
    /// The home's document, which must be readable, as its view must.
    fn home(written: Written) -> Result<Self, String> {
        Ok(Self {
            home: loads(written.read)?,
            home_path: written.path,
            overlay: None,
        })
    }

    /// The home's document and her overlay, which must be readable, as her
    /// view must, her overlay as her view shows it: with her package's
    /// settings merged in while they are still to be.
    fn character(
        sections: &Sections,
        written: Written,
        character: &CharacterDefinition,
        overlay: WrittenOverlay,
    ) -> Result<Self, String> {
        let home = loads(written.read)?;
        let absent = matches!(overlay.read, Read::Absent);
        let document = loads(overlay.read)?;
        let (merged, _) = merged_overlay(
            sections,
            character,
            overlay.path,
            document,
            absent,
            overlay.package_version.as_ref(),
        );

        Ok(Self {
            home_path: written.path,
            home,
            overlay: Some(merged),
        })
    }

    /// The document the change is made in: the home's, or her settings as
    /// her view shows them.
    fn own(&self) -> &Document {
        self.overlay
            .as_ref()
            .map_or(&self.home, |overlay| &overlay.read)
    }

    /// The documents as they read once `made` takes the place of the
    /// target's own.
    fn layers_with(&self, made: &Document) -> Layers {
        let mut layers = self.layers();

        match &mut layers.overlay {
            Some(overlay) => overlay.read = made.clone(),
            None => layers.home = made.clone(),
        }

        layers
    }

    /// Whether the target's files already hold `made`: it is the document
    /// the change started from, and no package settings of hers wait
    /// beneath it to be settled.
    fn holds(&self, made: &Document) -> bool {
        made.raw() == self.own().raw()
            && self
                .overlay
                .as_ref()
                .is_none_or(|overlay| overlay.merges.is_none())
    }

    /// Writes `made` in place of the target's own document. Her package's
    /// settings her view merges in are settled first, as her start settles
    /// them, and the change is written last, unless her file already holds
    /// it: a failure or a crash between the writes leaves her settings as
    /// her view showed them, under the same fingerprint, rather than her
    /// change over a merge her start would make again.
    fn write(self, home: &Home, made: &Document) -> Result<(), StorageError> {
        match self.overlay {
            Some(mut overlay) => {
                settle(home, &mut overlay)?;
                overlay.read = made.clone();
                settle(home, &mut overlay).map(drop)
            }
            None => write(&self.home_path, made.raw()),
        }
    }

    fn layers(&self) -> Layers {
        Layers {
            home_path: self.home_path.clone(),
            home_present: true,
            home: self.home.clone(),
            overlay: self.overlay.clone(),
        }
    }
}

/// The document a change starts from, `read` as its file was found: one
/// that cannot be read is refused, as its view is, saying why, and is left
/// for a person to repair.
fn loads(read: Read) -> Result<Document, String> {
    read.usable()
        .map_err(|diagnostic| diagnostic.message().to_owned())
}
