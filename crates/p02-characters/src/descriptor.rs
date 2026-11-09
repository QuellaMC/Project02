use std::collections::BTreeMap;
use std::fmt;

use p02_core::{CharacterProfile, SpeakerName};
use p02_shared::{Fingerprint, Identifier};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

const FORMAT: &str = "project02.character.v1";

/// The most a descriptor may weigh.
pub(crate) const MAX_DESCRIPTOR_BYTES: usize = 64 * 1024;

/// A character as her package defines her: who she is, the persona the
/// model is given, the version of that content, and the plugins she
/// expects.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CharacterDefinition {
    pub profile: CharacterProfile,
    pub persona: Persona,
    pub version: CharacterVersion,
    pub plugins: PluginExpectations,
}

/// Which content of a character a model round ran: her package's version
/// and the fingerprint of her persona, recorded with every round.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterRef {
    pub version: CharacterVersion,
    pub persona_fingerprint: Fingerprint,
}

impl CharacterDefinition {
    /// The content of hers a round runs, as every round records it.
    #[must_use]
    pub fn character_ref(&self) -> CharacterRef {
        CharacterRef {
            version: self.version.clone(),
            persona_fingerprint: Fingerprint::new(
                &json!({"persona": {"system": self.persona.sections()}}),
            ),
        }
    }
}

/// A character's persona: one section or more, in order, none blank.
/// Persona only: the runtime's own instructions are not a package's to
/// change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Persona(Vec<String>);

impl Persona {
    #[must_use]
    pub fn sections(&self) -> &[String] {
        &self.0
    }
}

/// The version of a character's content, three numbers of 1 to 9 digits
/// such as `1.0.0` as her package states it. It is recorded with what she
/// says, read back as it was recorded, and compared as written: any other
/// version is an upgrade.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CharacterVersion(String);

/// Why a text is not a [`CharacterVersion`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("not a character version: three numbers of 1 to 9 digits joined by '.', such as 1.0.0")]
pub struct ParseCharacterVersionError;

impl CharacterVersion {
    /// # Errors
    ///
    /// [`ParseCharacterVersionError`] when `value` is not three numbers of
    /// 1 to 9 ASCII digits joined by `.`.
    pub fn new(value: &str) -> Result<Self, ParseCharacterVersionError> {
        let parts: Vec<&str> = value.split('.').collect();
        let valid = parts.len() == 3
            && parts.iter().all(|part| {
                (1..=9).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_digit())
            });

        if valid {
            Ok(Self(value.to_owned()))
        } else {
            Err(ParseCharacterVersionError)
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CharacterVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// The plugins a character expects: required ones and recommended ones,
/// and values for their settings, by plugin. Shape only: whether they are
/// installed, and whether the values fit, is judged against the installed
/// plugins when she starts.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PluginExpectations {
    required: Vec<Identifier>,
    recommended: Vec<Identifier>,
    config: BTreeMap<Identifier, Map<String, Value>>,
}

impl PluginExpectations {
    /// In the order the package lists them, each once.
    #[must_use]
    pub fn required(&self) -> &[Identifier] {
        &self.required
    }

    /// In the order the package lists them, each once.
    #[must_use]
    pub fn recommended(&self) -> &[Identifier] {
        &self.recommended
    }

    /// Each plugin's values, keyed as the package wrote them.
    #[must_use]
    pub fn config(&self) -> &BTreeMap<Identifier, Map<String, Value>> {
        &self.config
    }
}

/// The first rule a descriptor breaks, in the order they are checked.
#[derive(Debug, thiserror::Error)]
pub enum ParseDescriptorError {
    #[error("character package descriptor exceeds the size limit of 64 KiB")]
    TooLarge,
    #[error("character package descriptor must contain valid JSON")]
    NotJson(#[source] serde_json::Error),
    #[error("character package {0} must be an object")]
    NotAnObject(&'static str),
    #[error("character package format must be \"{FORMAT}\"")]
    UnsupportedFormat,
    #[error(
        "character package identity.id must start with a letter and use only letters, numbers, \
         dots, underscores or hyphens, 128 at most"
    )]
    InvalidId,
    #[error(
        "character package identity.displayName must be one line of 1 to 128 characters with no \
         blank space at either end"
    )]
    InvalidDisplayName,
    #[error("character package persona.system must be an array of one section or more")]
    NoPersona,
    #[error("character package persona.system[{0}] must be a non-blank string")]
    InvalidSection(usize),
    #[error("character package meta.version must be a version such as \"1.0.0\"")]
    InvalidVersion,
    #[error("character package plugins.{0} must be an array of plugin ids")]
    InvalidPluginList(&'static str),
    #[error("character package plugins.config must be an object keyed by plugin id")]
    ConfigNotAnObject,
    #[error("character package plugins.config key \"{0}\" is not a plugin id")]
    InvalidConfigKey(String),
    #[error("character package plugins.config[\"{0}\"] must be an object")]
    ConfigEntryNotAnObject(Identifier),
}

impl CharacterDefinition {
    /// Reads a `project02.character.json`: UTF-8 JSON of at most 64 KiB.
    /// What it holds that a descriptor does not know is not read.
    pub(crate) fn from_descriptor(bytes: &[u8]) -> Result<Self, ParseDescriptorError> {
        if bytes.len() > MAX_DESCRIPTOR_BYTES {
            return Err(ParseDescriptorError::TooLarge);
        }

        let value: Value = serde_json::from_slice(bytes).map_err(ParseDescriptorError::NotJson)?;
        let descriptor = object(Some(&value), "descriptor")?;

        if text(descriptor, "format") != Some(FORMAT) {
            return Err(ParseDescriptorError::UnsupportedFormat);
        }

        Ok(Self {
            profile: profile(descriptor)?,
            persona: persona(descriptor)?,
            version: version(descriptor)?,
            plugins: plugins(descriptor)?,
        })
    }
}

fn profile(descriptor: &Map<String, Value>) -> Result<CharacterProfile, ParseDescriptorError> {
    let identity = object(descriptor.get("identity"), "identity")?;

    Ok(CharacterProfile {
        id: text(identity, "id")
            .and_then(|id| Identifier::new(id).ok())
            .ok_or(ParseDescriptorError::InvalidId)?,
        display_name: text(identity, "displayName")
            .and_then(|name| SpeakerName::new(name).ok())
            .ok_or(ParseDescriptorError::InvalidDisplayName)?,
    })
}

fn persona(descriptor: &Map<String, Value>) -> Result<Persona, ParseDescriptorError> {
    let persona = object(descriptor.get("persona"), "persona")?;
    let sections = match persona.get("system") {
        Some(Value::Array(sections)) if !sections.is_empty() => sections,
        _ => return Err(ParseDescriptorError::NoPersona),
    };

    sections
        .iter()
        .enumerate()
        .map(|(index, section)| {
            section
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .map(str::to_owned)
                .ok_or(ParseDescriptorError::InvalidSection(index))
        })
        .collect::<Result<_, _>>()
        .map(Persona)
}

fn version(descriptor: &Map<String, Value>) -> Result<CharacterVersion, ParseDescriptorError> {
    text(object(descriptor.get("meta"), "meta")?, "version")
        .and_then(|version| CharacterVersion::new(version).ok())
        .ok_or(ParseDescriptorError::InvalidVersion)
}

fn plugins(descriptor: &Map<String, Value>) -> Result<PluginExpectations, ParseDescriptorError> {
    if descriptor.get("plugins").is_none() {
        return Ok(PluginExpectations::default());
    }

    let plugins = object(descriptor.get("plugins"), "plugins")?;

    Ok(PluginExpectations {
        required: plugin_ids(plugins.get("required"), "required")?,
        recommended: plugin_ids(plugins.get("recommended"), "recommended")?,
        config: plugin_config(plugins.get("config"))?,
    })
}

/// The ids of list `list`, each once, in the order the package lists them.
fn plugin_ids(
    value: Option<&Value>,
    list: &'static str,
) -> Result<Vec<Identifier>, ParseDescriptorError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let entries = value
        .as_array()
        .ok_or(ParseDescriptorError::InvalidPluginList(list))?;
    let mut ids: Vec<Identifier> = Vec::with_capacity(entries.len());

    for entry in entries {
        let id = entry
            .as_str()
            .and_then(|id| Identifier::new(id).ok())
            .ok_or(ParseDescriptorError::InvalidPluginList(list))?;

        if !ids.contains(&id) {
            ids.push(id);
        }
    }

    Ok(ids)
}

fn plugin_config(
    value: Option<&Value>,
) -> Result<BTreeMap<Identifier, Map<String, Value>>, ParseDescriptorError> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };

    value
        .as_object()
        .ok_or(ParseDescriptorError::ConfigNotAnObject)?
        .iter()
        .map(|(key, values)| {
            let plugin = Identifier::new(key)
                .map_err(|_| ParseDescriptorError::InvalidConfigKey(key.clone()))?;

            match values {
                Value::Object(values) => Ok((plugin, values.clone())),
                _ => Err(ParseDescriptorError::ConfigEntryNotAnObject(plugin)),
            }
        })
        .collect()
}

/// The object `value` holds, or the refusal naming `part`.
fn object<'a>(
    value: Option<&'a Value>,
    part: &'static str,
) -> Result<&'a Map<String, Value>, ParseDescriptorError> {
    value
        .and_then(Value::as_object)
        .ok_or(ParseDescriptorError::NotAnObject(part))
}

fn text<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn descriptor() -> Value {
        json!({
            "format": "project02.character.v1",
            "identity": {"id": "nova", "displayName": "Nova"},
            "persona": {"system": ["You are Nova."]},
            "meta": {"version": "1.0.0"},
            "plugins": {
                "required": ["character-state"],
                "recommended": ["demo-config"],
                "config": {"demo-config": {"tone": "warm"}},
            },
        })
    }

    fn with(changes: &[(&str, Value)]) -> Vec<u8> {
        let mut value = descriptor();

        for (pointer, replacement) in changes {
            match pointer.rsplit_once('/') {
                Some((parent, key)) => {
                    value
                        .pointer_mut(parent)
                        .and_then(Value::as_object_mut)
                        .unwrap()
                        .insert(key.to_owned(), replacement.clone());
                }
                None => value = replacement.clone(),
            }
        }

        value.to_string().into_bytes()
    }

    fn without(field: &str) -> Vec<u8> {
        let mut value = descriptor();

        value.as_object_mut().unwrap().remove(field);
        value.to_string().into_bytes()
    }

    #[test]
    fn a_descriptor_reads_as_written_each_plugin_once_and_what_it_does_not_know_unread() {
        let emoji = "\u{1f600}";
        let bytes = with(&[
            ("/$schema", json!(42)),
            ("/identity/pronouns", json!("she/her")),
            ("/identity/displayName", json!(emoji.repeat(128))),
            ("/persona/system", json!(["First.", "Second."])),
            ("/meta/version", json!("999999999.0.01")),
            (
                "/plugins/required",
                json!(["character-state", "mem0", "character-state"]),
            ),
            (
                "/plugins/config",
                json!({"zeta-plugin": {"b": 1, "a": [true]}, "alpha-plugin": {"z": null, "y": 2}}),
            ),
        ]);
        let definition = CharacterDefinition::from_descriptor(&bytes).unwrap();
        let config = definition.plugins.config();

        assert_eq!(definition.profile.id.as_str(), "nova");
        assert_eq!(definition.profile.display_name.as_str(), emoji.repeat(128));
        assert_eq!(definition.persona.sections(), ["First.", "Second."]);
        assert_eq!(definition.version.as_str(), "999999999.0.01");
        assert_eq!(
            definition
                .plugins
                .required()
                .iter()
                .map(Identifier::as_str)
                .collect::<Vec<_>>(),
            ["character-state", "mem0"]
        );
        assert_eq!(definition.plugins.recommended()[0].as_str(), "demo-config");
        assert_eq!(
            config.keys().map(Identifier::as_str).collect::<Vec<_>>(),
            ["alpha-plugin", "zeta-plugin"]
        );
        assert_eq!(
            config
                .values()
                .map(|values| values.keys().map(String::as_str).collect::<Vec<_>>())
                .collect::<Vec<_>>(),
            [["z", "y"], ["b", "a"]]
        );
        assert_eq!(
            CharacterDefinition::from_descriptor(&without("plugins"))
                .unwrap()
                .plugins,
            PluginExpectations::default()
        );
    }

    #[test]
    fn a_descriptor_is_refused_by_the_first_rule_it_breaks_naming_its_place() {
        let mut invalid_utf8 = with(&[("/identity/displayName", json!("Nova__"))]);
        let at = invalid_utf8
            .windows(2)
            .position(|pair| pair == b"__")
            .unwrap();

        invalid_utf8[at] = 0xff;

        let cases: Vec<(Vec<u8>, &str)> = vec![
            (
                with(&[("/format", json!("x".repeat(MAX_DESCRIPTOR_BYTES)))]),
                "size limit",
            ),
            (b"{not json".to_vec(), "valid JSON"),
            (invalid_utf8, "valid JSON"),
            (with(&[("", json!([]))]), "descriptor must be an object"),
            (
                with(&[("/format", json!("project02.character.v2"))]),
                "format must be \"project02.character.v1\"",
            ),
            (without("identity"), "identity must be an object"),
            (with(&[("/identity/id", json!("9nova"))]), "identity.id"),
            (
                with(&[("/identity/displayName", json!("   "))]),
                "identity.displayName",
            ),
            (
                with(&[("/identity/displayName", json!("Nova\nError: failed"))]),
                "identity.displayName",
            ),
            (
                with(&[("/persona/system", json!([]))]),
                "persona.system must be an array of one section or more",
            ),
            (
                with(&[("/persona/system", json!(["You are Nova.", "  "]))]),
                "persona.system[1]",
            ),
            (with(&[("/meta", json!("1.0.0"))]), "meta must be an object"),
            (with(&[("/meta/version", json!("v1"))]), "meta.version"),
            (
                with(&[("/plugins", json!(["demo-config"]))]),
                "plugins must be an object",
            ),
            (
                with(&[("/plugins/recommended", json!(["9starts"]))]),
                "plugins.recommended must be an array of plugin ids",
            ),
            (
                with(&[("/plugins/config", json!(["demo-config"]))]),
                "plugins.config must be an object",
            ),
            (
                with(&[("/plugins/config", json!({"9x": {}}))]),
                "plugins.config key \"9x\"",
            ),
            (
                with(&[("/plugins/config", json!({"alpha": "warm"}))]),
                "plugins.config[\"alpha\"] must be an object",
            ),
        ];

        for (bytes, fragment) in cases {
            let refusal = CharacterDefinition::from_descriptor(&bytes).unwrap_err();

            assert!(
                refusal.to_string().contains(fragment),
                "{refusal} lacks {fragment}"
            );
        }
    }

    #[test]
    fn a_character_version_is_accepted_only_in_its_spelling() {
        for (text, accepted) in [
            ("1.0.0", true),
            ("01.20.300", true),
            ("123456789.0.0", true),
            ("1.0", false),
            ("1.0.0.0", false),
            ("1.0.x", false),
            ("1..0", false),
            ("1.0.1234567890", false),
            ("v1.0.0", false),
        ] {
            assert_eq!(CharacterVersion::new(text).is_ok(), accepted, "{text}");
        }
    }
}
