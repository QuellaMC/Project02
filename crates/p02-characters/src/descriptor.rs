use std::collections::BTreeMap;
use std::fmt;

use p02_core::{CharacterProfile, SpeakerName};
use p02_shared::{BoundJsonError, Credentials, Identifier, JsonLimits, bound_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const FORMAT: &str = "project02.character.v1";

/// The most a descriptor may weigh.
pub(crate) const MAX_DESCRIPTOR_BYTES: usize = 64 * 1024;

const MAX_SECTIONS: usize = 16;
const MAX_SECTION_CHARS: usize = 4_000;
const MAX_PLUGINS: usize = 32;

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

/// A character's persona: 1 to 16 sections in order, each of 1 to 4,000
/// characters and not blank. Persona only: the runtime's own instructions
/// are not a package's to change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Persona(Vec<String>);

impl Persona {
    #[must_use]
    pub fn sections(&self) -> &[String] {
        &self.0
    }
}

/// The version of a character's content, three numbers of 1 to 9 digits
/// such as `1.0.0`. It is recorded with what she says, and compared as
/// written: any other version is an upgrade.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
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

impl TryFrom<String> for CharacterVersion {
    type Error = ParseCharacterVersionError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl fmt::Display for CharacterVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// The plugins a character expects: required ones she cannot start
/// without, recommended ones she warns without, and values for their
/// settings, by plugin. Shape only: whether they are installed, and whether
/// the values fit, is judged against the installed plugins when she starts.
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

/// A part of the descriptor, which names the code its refusals are
/// reported under.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DescriptorPart {
    Descriptor,
    Identity,
    Persona,
    Meta,
    Plugins,
}

impl fmt::Display for DescriptorPart {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Descriptor => "descriptor",
            Self::Identity => "identity",
            Self::Persona => "persona",
            Self::Meta => "meta",
            Self::Plugins => "plugins",
        })
    }
}

/// One of a character's two lists of plugin ids.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PluginList {
    Required,
    Recommended,
}

impl fmt::Display for PluginList {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Required => "required",
            Self::Recommended => "recommended",
        })
    }
}

/// The first rule a descriptor breaks, in the order they are checked.
#[derive(Debug, thiserror::Error)]
pub enum ParseDescriptorError {
    #[error("character package descriptor exceeds the size limit of 64 KiB")]
    TooLarge,
    #[error("character package descriptor must contain valid JSON")]
    NotJson(#[source] serde_json::Error),
    #[error("character package descriptor exceeds safe JSON limits")]
    PastLimits(#[source] BoundJsonError),
    #[error("character package {0} must be an object")]
    NotAnObject(DescriptorPart),
    #[error("character package {part} contains unknown field \"{field}\"")]
    UnknownField { part: DescriptorPart, field: String },
    #[error("character package descriptor \"$schema\" must be a string")]
    SchemaNotAString,
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
    #[error("character package persona.system must be an array of 1 to {MAX_SECTIONS} sections")]
    SectionCount,
    #[error(
        "character package persona.system[{0}] must be a non-blank string of at most \
         {MAX_SECTION_CHARS} characters"
    )]
    InvalidSection(usize),
    #[error("character package meta.version must be a version such as \"1.0.0\"")]
    InvalidVersion,
    #[error("character package plugins.{0} must be an array of at most {MAX_PLUGINS} plugin ids")]
    InvalidPluginList(PluginList),
    #[error("character package plugins.{0} entries must be plugin ids")]
    InvalidPluginId(PluginList),
    #[error("character package plugins.{list} lists plugin \"{plugin}\" more than once")]
    RepeatedPlugin {
        list: PluginList,
        plugin: Identifier,
    },
    #[error("character package plugins.config must be an object keyed by plugin id")]
    ConfigNotAnObject,
    #[error("character package plugins.config key \"{0}\" is not a plugin id")]
    InvalidConfigKey(String),
    #[error("character package plugins.config[\"{0}\"] must be an object")]
    ConfigEntryNotAnObject(Identifier),
}

impl ParseDescriptorError {
    /// The code a refusal is reported under, one for each part of the
    /// descriptor.
    #[must_use]
    pub fn code(&self) -> &'static str {
        let part = match self {
            Self::NotAnObject(part) | Self::UnknownField { part, .. } => *part,
            Self::TooLarge
            | Self::NotJson(_)
            | Self::PastLimits(_)
            | Self::SchemaNotAString
            | Self::UnsupportedFormat => DescriptorPart::Descriptor,
            Self::InvalidId | Self::InvalidDisplayName => DescriptorPart::Identity,
            Self::SectionCount | Self::InvalidSection(_) => DescriptorPart::Persona,
            Self::InvalidVersion => DescriptorPart::Meta,
            Self::InvalidPluginList(_)
            | Self::InvalidPluginId(_)
            | Self::RepeatedPlugin { .. }
            | Self::ConfigNotAnObject
            | Self::InvalidConfigKey(_)
            | Self::ConfigEntryNotAnObject(_) => DescriptorPart::Plugins,
        };

        match part {
            DescriptorPart::Descriptor => "invalid_descriptor",
            DescriptorPart::Identity => "invalid_identity",
            DescriptorPart::Persona => "invalid_persona",
            DescriptorPart::Meta => "invalid_meta",
            DescriptorPart::Plugins => "invalid_plugins",
        }
    }
}

impl CharacterDefinition {
    /// Reads a `project02.character.json`: UTF-8 JSON of at most 64 KiB,
    /// held to the JSON limits, each of its objects closed, with a
    /// `$schema` for editors that is otherwise ignored.
    pub(crate) fn from_descriptor(bytes: &[u8]) -> Result<Self, ParseDescriptorError> {
        if bytes.len() > MAX_DESCRIPTOR_BYTES {
            return Err(ParseDescriptorError::TooLarge);
        }

        let value = serde_json::from_slice(bytes).map_err(ParseDescriptorError::NotJson)?;
        let value = bound_json(
            value,
            "descriptor",
            JsonLimits::default(),
            Credentials::Keep,
        )
        .map_err(ParseDescriptorError::PastLimits)?;
        let descriptor = Object::of(
            Some(&value),
            DescriptorPart::Descriptor,
            &[
                "$schema", "format", "identity", "persona", "meta", "plugins",
            ],
        )?;

        if descriptor
            .get("$schema")
            .is_some_and(|schema| !schema.is_string())
        {
            return Err(ParseDescriptorError::SchemaNotAString);
        }

        if descriptor.get("format").and_then(Value::as_str) != Some(FORMAT) {
            return Err(ParseDescriptorError::UnsupportedFormat);
        }

        Ok(Self {
            profile: profile(&descriptor)?,
            persona: persona(&descriptor)?,
            version: version(&descriptor)?,
            plugins: plugins(&descriptor)?,
        })
    }
}

fn profile(descriptor: &Object<'_>) -> Result<CharacterProfile, ParseDescriptorError> {
    let identity =
        descriptor.object("identity", DescriptorPart::Identity, &["id", "displayName"])?;

    Ok(CharacterProfile {
        id: identity
            .text("id")
            .and_then(|id| Identifier::new(id).ok())
            .ok_or(ParseDescriptorError::InvalidId)?,
        display_name: identity
            .text("displayName")
            .and_then(|name| SpeakerName::new(name).ok())
            .ok_or(ParseDescriptorError::InvalidDisplayName)?,
    })
}

fn persona(descriptor: &Object<'_>) -> Result<Persona, ParseDescriptorError> {
    let persona = descriptor.object("persona", DescriptorPart::Persona, &["system"])?;
    let sections = match persona.get("system") {
        Some(Value::Array(sections)) if (1..=MAX_SECTIONS).contains(&sections.len()) => sections,
        _ => return Err(ParseDescriptorError::SectionCount),
    };

    sections
        .iter()
        .enumerate()
        .map(|(index, section)| {
            section
                .as_str()
                .filter(|text| !text.trim().is_empty() && text.chars().count() <= MAX_SECTION_CHARS)
                .map(str::to_owned)
                .ok_or(ParseDescriptorError::InvalidSection(index))
        })
        .collect::<Result<_, _>>()
        .map(Persona)
}

fn version(descriptor: &Object<'_>) -> Result<CharacterVersion, ParseDescriptorError> {
    descriptor
        .object("meta", DescriptorPart::Meta, &["version"])?
        .text("version")
        .and_then(|version| CharacterVersion::new(version).ok())
        .ok_or(ParseDescriptorError::InvalidVersion)
}

fn plugins(descriptor: &Object<'_>) -> Result<PluginExpectations, ParseDescriptorError> {
    if descriptor.get("plugins").is_none() {
        return Ok(PluginExpectations::default());
    }

    let plugins = descriptor.object(
        "plugins",
        DescriptorPart::Plugins,
        &["required", "recommended", "config"],
    )?;

    Ok(PluginExpectations {
        required: plugin_ids(plugins.get("required"), PluginList::Required)?,
        recommended: plugin_ids(plugins.get("recommended"), PluginList::Recommended)?,
        config: plugin_config(plugins.get("config"))?,
    })
}

fn plugin_ids(
    value: Option<&Value>,
    list: PluginList,
) -> Result<Vec<Identifier>, ParseDescriptorError> {
    let entries = match value {
        None => return Ok(Vec::new()),
        Some(Value::Array(entries)) if entries.len() <= MAX_PLUGINS => entries,
        Some(_) => return Err(ParseDescriptorError::InvalidPluginList(list)),
    };
    let mut ids: Vec<Identifier> = Vec::with_capacity(entries.len());

    for entry in entries {
        let id = entry
            .as_str()
            .and_then(|id| Identifier::new(id).ok())
            .ok_or(ParseDescriptorError::InvalidPluginId(list))?;

        if ids.contains(&id) {
            return Err(ParseDescriptorError::RepeatedPlugin { list, plugin: id });
        }

        ids.push(id);
    }

    Ok(ids)
}

/// Judged in plugin-id order, so the first refusal is the same whatever
/// order the package wrote its plugins in.
fn plugin_config(
    value: Option<&Value>,
) -> Result<BTreeMap<Identifier, Map<String, Value>>, ParseDescriptorError> {
    let entries = match value {
        None => return Ok(BTreeMap::new()),
        Some(Value::Object(entries)) => entries,
        Some(_) => return Err(ParseDescriptorError::ConfigNotAnObject),
    };
    let mut sorted: Vec<(&String, &Value)> = entries.iter().collect();

    sorted.sort_by_key(|(key, _)| *key);
    sorted
        .into_iter()
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

/// One closed object of the descriptor.
struct Object<'a> {
    entries: &'a Map<String, Value>,
}

impl<'a> Object<'a> {
    fn of(
        value: Option<&'a Value>,
        part: DescriptorPart,
        keys: &[&str],
    ) -> Result<Self, ParseDescriptorError> {
        let Some(Value::Object(entries)) = value else {
            return Err(ParseDescriptorError::NotAnObject(part));
        };

        if let Some(field) = entries
            .keys()
            .filter(|key| !keys.contains(&key.as_str()))
            .min()
        {
            return Err(ParseDescriptorError::UnknownField {
                part,
                field: field.clone(),
            });
        }

        Ok(Self { entries })
    }

    fn object(
        &self,
        key: &str,
        part: DescriptorPart,
        keys: &[&str],
    ) -> Result<Object<'a>, ParseDescriptorError> {
        Object::of(self.get(key), part, keys)
    }

    fn get(&self, key: &str) -> Option<&'a Value> {
        self.entries.get(key)
    }

    fn text(&self, key: &str) -> Option<&'a str> {
        self.get(key).and_then(Value::as_str)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn descriptor() -> Value {
        json!({
            "$schema": "../../../../schemas/project02.character.schema.json",
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
    fn a_descriptor_at_every_limit_reads_whole_and_as_written() {
        let emoji = "\u{1f600}";
        let mut sections = vec![json!(emoji.repeat(MAX_SECTION_CHARS))];

        sections.extend((1..MAX_SECTIONS).map(|index| json!(format!("Section {index}."))));

        let required: Vec<String> = (0..MAX_PLUGINS).map(|index| format!("p{index}")).collect();
        let bytes = with(&[
            ("/identity/displayName", json!(emoji.repeat(128))),
            ("/persona/system", Value::from(sections)),
            ("/meta/version", json!("999999999.0.01")),
            ("/plugins/required", json!(required)),
            (
                "/plugins/config",
                json!({"zeta-plugin": {"b": 1, "a": [true]}, "alpha-plugin": {"z": null, "y": 2}}),
            ),
        ]);
        let definition = CharacterDefinition::from_descriptor(&bytes).unwrap();
        let config = definition.plugins.config();

        assert_eq!(definition.profile.id.as_str(), "nova");
        assert_eq!(definition.profile.display_name.as_str(), emoji.repeat(128));
        assert_eq!(definition.persona.sections().len(), MAX_SECTIONS);
        assert_eq!(definition.version.as_str(), "999999999.0.01");
        assert_eq!(definition.plugins.required().len(), MAX_PLUGINS);
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
    #[expect(
        clippy::too_many_lines,
        reason = "one table of every refusal, read top to bottom"
    )]
    fn a_descriptor_is_refused_by_the_first_rule_it_breaks_naming_its_place() {
        let crowded: Map<String, Value> = (0..257)
            .map(|index| (format!("field-{index}"), json!(index)))
            .collect();
        let mut invalid_utf8 = with(&[("/identity/displayName", json!("Nova__"))]);
        let at = invalid_utf8
            .windows(2)
            .position(|pair| pair == b"__")
            .unwrap();

        invalid_utf8[at] = 0xff;

        let cases: Vec<(Vec<u8>, &str, &str)> = vec![
            (
                with(&[("/$schema", json!("x".repeat(MAX_DESCRIPTOR_BYTES)))]),
                "invalid_descriptor",
                "size limit",
            ),
            (b"{not json".to_vec(), "invalid_descriptor", "valid JSON"),
            (invalid_utf8, "invalid_descriptor", "valid JSON"),
            (
                with(&[("/plugins/config/demo-config", Value::from(crowded))]),
                "invalid_descriptor",
                "safe JSON limits",
            ),
            (
                with(&[("", json!([]))]),
                "invalid_descriptor",
                "descriptor must be an object",
            ),
            (
                with(&[("/zeta", json!({})), ("/alpha", json!({}))]),
                "invalid_descriptor",
                "descriptor contains unknown field \"alpha\"",
            ),
            (
                with(&[("/$schema", json!(42))]),
                "invalid_descriptor",
                "\"$schema\" must be a string",
            ),
            (
                with(&[("/format", json!("project02.character.v2"))]),
                "invalid_descriptor",
                "format must be \"project02.character.v1\"",
            ),
            (
                without("identity"),
                "invalid_identity",
                "identity must be an object",
            ),
            (
                with(&[("/identity/pronouns", json!("she/her"))]),
                "invalid_identity",
                "identity contains unknown field \"pronouns\"",
            ),
            (
                with(&[("/identity/id", json!("9nova"))]),
                "invalid_identity",
                "identity.id",
            ),
            (
                with(&[("/identity/displayName", json!("   "))]),
                "invalid_identity",
                "identity.displayName",
            ),
            (
                with(&[("/identity/displayName", json!("Nova\nError: failed"))]),
                "invalid_identity",
                "identity.displayName",
            ),
            (
                with(&[("/persona/system", json!([]))]),
                "invalid_persona",
                "persona.system must be an array of 1 to 16",
            ),
            (
                with(&[("/persona/system", json!(vec!["Section."; 17]))]),
                "invalid_persona",
                "persona.system must be an array of 1 to 16",
            ),
            (
                with(&[("/persona/system", json!(["You are Nova.", "  "]))]),
                "invalid_persona",
                "persona.system[1]",
            ),
            (
                with(&[(
                    "/persona/system",
                    json!(["x".repeat(MAX_SECTION_CHARS + 1)]),
                )]),
                "invalid_persona",
                "persona.system[0]",
            ),
            (
                with(&[("/persona/examples", json!([]))]),
                "invalid_persona",
                "persona contains unknown field \"examples\"",
            ),
            (
                with(&[("/meta", json!("1.0.0"))]),
                "invalid_meta",
                "meta must be an object",
            ),
            (
                with(&[("/meta/version", json!("v1"))]),
                "invalid_meta",
                "meta.version",
            ),
            (
                with(&[("/plugins", json!(["demo-config"]))]),
                "invalid_plugins",
                "plugins must be an object",
            ),
            (
                with(&[("/plugins/autoInstall", json!(true))]),
                "invalid_plugins",
                "plugins contains unknown field \"autoInstall\"",
            ),
            (
                with(&[("/plugins/required", json!(vec!["p"; MAX_PLUGINS + 1]))]),
                "invalid_plugins",
                "plugins.required must be an array of at most 32",
            ),
            (
                with(&[("/plugins/recommended", json!(["9starts"]))]),
                "invalid_plugins",
                "plugins.recommended entries",
            ),
            (
                with(&[("/plugins/required", json!(["demo-config", "demo-config"]))]),
                "invalid_plugins",
                "plugins.required lists plugin \"demo-config\" more than once",
            ),
            (
                with(&[("/plugins/config", json!(["demo-config"]))]),
                "invalid_plugins",
                "plugins.config must be an object",
            ),
            (
                with(&[("/plugins/config", json!({"z-plugin": {}, "9x": {}}))]),
                "invalid_plugins",
                "plugins.config key \"9x\"",
            ),
            (
                with(&[("/plugins/config", json!({"zeta": "warm", "alpha": "warm"}))]),
                "invalid_plugins",
                "plugins.config[\"alpha\"] must be an object",
            ),
        ];

        for (bytes, code, fragment) in cases {
            let refusal = CharacterDefinition::from_descriptor(&bytes).unwrap_err();

            assert_eq!(refusal.code(), code, "{refusal}");
            assert!(
                refusal.to_string().contains(fragment),
                "{refusal} lacks {fragment}"
            );
        }
    }

    #[test]
    fn a_character_version_is_accepted_only_in_its_spelling_whether_built_or_read() {
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
            assert_eq!(
                serde_json::from_value::<CharacterVersion>(json!(text)).is_ok(),
                accepted,
                "{text}"
            );
        }
    }
}
