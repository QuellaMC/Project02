use std::collections::BTreeMap;
use std::fmt;

use p02_core::{CharacterProfile, LanguageTag, SpeakerName};
use p02_shared::Identifier;
use p02_world::{WORLD_PLUGIN, WorldDefinition, WorldDefinitionError};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const FORMAT: &str = "project02.character.v1";

/// The most a descriptor may weigh.
pub(crate) const MAX_DESCRIPTOR_BYTES: usize = 64 * 1024;

/// A character as her package defines her: who she is, one line about her
/// when it gives one, the language she speaks when it names one, the
/// persona the model is given, the version of that content, the plugins
/// she expects, her translation notes, and the world she comes from when
/// it brings one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CharacterDefinition {
    pub profile: CharacterProfile,
    /// What a person adding her from a file reads of her before she is
    /// added; nothing else reads it.
    pub about: Option<String>,
    /// The language she speaks, as her package writes its tag, when her
    /// story fixes one: it becomes her own setting, where the person can
    /// change it.
    pub language: Option<LanguageTag>,
    pub persona: Persona,
    pub version: CharacterVersion,
    pub plugins: PluginExpectations,
    pub translation: TranslationNotes,
    /// The world she comes from: the home makes its living world from it
    /// the first time it is read, and keeps it from then on.
    pub world: Option<WorldDefinition>,
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
/// such as `1.0.0` as her package states it. It is recorded in her data,
/// read back as it was recorded, and compared as written: any other version
/// is an upgrade.
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

/// The plugins a character's package lists: required ones and recommended
/// ones, and values for their settings, by plugin. Shape only: whether they
/// are installed, and whether the values fit, is judged against the
/// installed plugins when she starts.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PluginExpectations {
    required: Vec<Identifier>,
    recommended: Vec<Identifier>,
    config: BTreeMap<Identifier, Map<String, Value>>,
}

impl PluginExpectations {
    /// Each plugin's values, keyed as the package wrote them.
    #[must_use]
    pub fn config(&self) -> &BTreeMap<Identifier, Map<String, Value>> {
        &self.config
    }
}

/// Her translation notes as her package gives them, each when it does: how
/// some of her words are put for the person, and how she sounds. Shape
/// only: her settings judge them when they become hers.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TranslationNotes {
    words: Option<Value>,
    tone: Option<Value>,
}

impl TranslationNotes {
    #[must_use]
    pub fn words(&self) -> Option<&Value> {
        self.words.as_ref()
    }

    #[must_use]
    pub fn tone(&self) -> Option<&Value> {
        self.tone.as_ref()
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
    #[error(
        "character package identity.about must be one line of 1 to 128 characters with no blank \
         space at either end"
    )]
    InvalidAbout,
    #[error(
        "character package identity.language must be a language tag such as \"ja\" or \"pt-BR\""
    )]
    InvalidLanguage,
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
    #[error("character package {0}")]
    World(WorldDefinitionError),
}

impl ParseDescriptorError {
    /// The rule broken, in plain words, for a person who chose the file
    /// rather than wrote it.
    #[must_use]
    pub fn plainly(&self) -> &'static str {
        match self {
            Self::TooLarge => "This file is too large to be a character file.",
            Self::NotJson(_) | Self::NotAnObject("descriptor") | Self::UnsupportedFormat => {
                "This file is not a character file this app can read."
            }
            Self::NotAnObject("identity") | Self::InvalidId => {
                "This file does not give the character an id the app can use."
            }
            Self::InvalidDisplayName => "This file does not give the character a one-line name.",
            Self::InvalidAbout => {
                "The line about the character in this file is not one line of at most 128 \
                 characters."
            }
            Self::InvalidLanguage => {
                "Her language is not a language tag such as \"ja\" or \"pt-BR\"."
            }
            Self::NotAnObject("persona") | Self::NoPersona | Self::InvalidSection(_) => {
                "This file does not say who the character is."
            }
            Self::NotAnObject("meta") | Self::InvalidVersion => {
                "This file does not give its version as three numbers, such as 1.0.0."
            }
            Self::NotAnObject("translation") => {
                "This file gives the character's translation notes in a way the app cannot read."
            }
            Self::NotAnObject(_)
            | Self::InvalidPluginList(_)
            | Self::ConfigNotAnObject
            | Self::InvalidConfigKey(_)
            | Self::ConfigEntryNotAnObject(_) => {
                "This file lists the character's features in a way the app cannot read."
            }
            Self::World(refusal) => refusal.plainly(),
        }
    }
}

impl CharacterDefinition {
    /// Reads a `project02.character.json`: UTF-8 JSON of at most 64 KiB.
    /// What it holds that a descriptor does not know is not read.
    ///
    /// # Errors
    ///
    /// [`ParseDescriptorError`] naming the first rule `bytes` breaks.
    pub fn from_descriptor(bytes: &[u8]) -> Result<Self, ParseDescriptorError> {
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
            about: about(descriptor)?,
            language: language(descriptor)?,
            persona: persona(descriptor)?,
            version: version(descriptor)?,
            plugins: plugins(descriptor)?,
            translation: translation(descriptor)?,
            world: world(descriptor)?,
        })
    }

    /// The plugins her package switches on, each once: those it requires,
    /// then those it recommends, which do alike, and the world's exactly
    /// when it brings a world, since she lives in it through that plugin.
    #[must_use]
    #[expect(
        clippy::missing_panics_doc,
        reason = "the world's plugin is named by an identifier"
    )]
    pub fn expected_plugins(&self) -> Vec<Identifier> {
        let mut expected: Vec<Identifier> = Vec::new();

        for id in self
            .plugins
            .required
            .iter()
            .chain(&self.plugins.recommended)
        {
            if id.as_str() != WORLD_PLUGIN && !expected.contains(id) {
                expected.push(id.clone());
            }
        }

        if self.world.is_some() {
            expected.push(
                Identifier::new(WORLD_PLUGIN)
                    .expect("the world's plugin is named by an identifier"),
            );
        }

        expected
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

/// One line about her, held to the bound of her name.
fn about(descriptor: &Map<String, Value>) -> Result<Option<String>, ParseDescriptorError> {
    object(descriptor.get("identity"), "identity")?
        .get("about")
        .map(|about| {
            about
                .as_str()
                .filter(|about| SpeakerName::new(about).is_ok())
                .map(str::to_owned)
                .ok_or(ParseDescriptorError::InvalidAbout)
        })
        .transpose()
}

/// The language she speaks, when her package names one.
fn language(descriptor: &Map<String, Value>) -> Result<Option<LanguageTag>, ParseDescriptorError> {
    object(descriptor.get("identity"), "identity")?
        .get("language")
        .map(|language| {
            language
                .as_str()
                .and_then(|language| LanguageTag::parse(language).ok())
                .ok_or(ParseDescriptorError::InvalidLanguage)
        })
        .transpose()
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

/// Her translation notes, read as a plugin's values are: each kept as
/// written.
fn translation(descriptor: &Map<String, Value>) -> Result<TranslationNotes, ParseDescriptorError> {
    if descriptor.get("translation").is_none() {
        return Ok(TranslationNotes::default());
    }

    let notes = object(descriptor.get("translation"), "translation")?;

    Ok(TranslationNotes {
        words: notes.get("words").cloned(),
        tone: notes.get("tone").cloned(),
    })
}

/// The world she comes from, when her package brings one, read by the
/// world's own rules.
fn world(descriptor: &Map<String, Value>) -> Result<Option<WorldDefinition>, ParseDescriptorError> {
    descriptor
        .get("world")
        .map(|world| WorldDefinition::from_value(world).map_err(ParseDescriptorError::World))
        .transpose()
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
                "recommended": ["reply-style"],
                "config": {"reply-style": {"tone": "warm"}},
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
            ("/identity/about", json!("A quiet one, who notices things.")),
            ("/identity/language", json!("pt-BR")),
            ("/persona/system", json!(["First.", "Second."])),
            ("/meta/version", json!("999999999.0.01")),
            (
                "/plugins/required",
                json!(["character-state", "mem0", "character-state", "world"]),
            ),
            (
                "/plugins/config",
                json!({"zeta-plugin": {"b": 1, "a": [true]}, "alpha-plugin": {"z": null, "y": 2}}),
            ),
            (
                "/translation",
                json!({"words": [{"hers": "ダーリン"}], "tone": 42, "voice": "low"}),
            ),
            (
                "/world",
                json!({"id": "the-port", "name": "The Port", "places": [{"id": "flat", "name": "The Flat"}]}),
            ),
        ]);
        let definition = CharacterDefinition::from_descriptor(&bytes).unwrap();
        let config = definition.plugins.config();
        let ids = |plugins: Vec<Identifier>| {
            plugins
                .iter()
                .map(|plugin| plugin.as_str().to_owned())
                .collect::<Vec<_>>()
        };

        assert_eq!(definition.profile.id.as_str(), "nova");
        assert_eq!(definition.profile.display_name.as_str(), emoji.repeat(128));
        assert_eq!(
            definition.about.as_deref(),
            Some("A quiet one, who notices things.")
        );
        assert_eq!(
            definition.language.as_ref().map(LanguageTag::as_str),
            Some("pt-BR")
        );
        assert_eq!(definition.persona.sections(), ["First.", "Second."]);
        assert_eq!(definition.version.as_str(), "999999999.0.01");
        assert_eq!(
            ids(definition.expected_plugins()),
            ["character-state", "mem0", "reply-style", "world"]
        );
        assert_eq!(
            definition.world.as_ref().map(|world| world.id().as_str()),
            Some("the-port")
        );
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
            (
                definition.translation.words(),
                definition.translation.tone()
            ),
            (Some(&json!([{"hers": "ダーリン"}])), Some(&json!(42)))
        );
        assert_eq!(
            CharacterDefinition::from_descriptor(&without("plugins"))
                .unwrap()
                .plugins,
            PluginExpectations::default()
        );
        let plain = CharacterDefinition::from_descriptor(&with(&[(
            "/plugins/recommended",
            json!(["world", "reply-style", "character-state"]),
        )]))
        .unwrap();

        assert_eq!(plain.about, None);
        assert_eq!(plain.language, None);
        assert_eq!(plain.translation, TranslationNotes::default());
        assert_eq!(plain.world, None);
        assert_eq!(
            ids(plain.expected_plugins()),
            ["character-state", "reply-style"]
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
                with(&[("/identity/about", json!("Quiet.\nAnd more."))]),
                "identity.about",
            ),
            (
                with(&[
                    ("/identity/language", json!("ja_JP")),
                    ("/persona/system", json!([])),
                ]),
                "identity.language",
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
                with(&[("/plugins", json!(["reply-style"]))]),
                "plugins must be an object",
            ),
            (
                with(&[("/plugins/recommended", json!(["9starts"]))]),
                "plugins.recommended must be an array of plugin ids",
            ),
            (
                with(&[("/plugins/config", json!(["reply-style"]))]),
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
            (
                with(&[("/translation", json!(["ダーリン", "Darling"]))]),
                "translation must be an object",
            ),
            (
                with(&[("/world", json!({"id": "the-port", "places": []}))]),
                "character package world.name must be one line",
            ),
        ];

        for (bytes, fragment) in cases {
            let refusal = CharacterDefinition::from_descriptor(&bytes).unwrap_err();

            assert!(
                refusal.to_string().contains(fragment),
                "{refusal} lacks {fragment}"
            );
        }

        assert_eq!(
            CharacterDefinition::from_descriptor(&with(&[("/world", json!("The Port"))]))
                .unwrap_err()
                .plainly(),
            "This file gives the character's world in a way the app cannot read."
        );
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
