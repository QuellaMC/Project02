//! What the settings may hold beside the host's own fields: each plugin's
//! section as its manifest declares it and each connector's as this build
//! declares it, and from which document a scope lets each target take a
//! value.

use std::sync::LazyLock;

use p02_contracts::{
    AccessMap, ConfigField, ConfigScope, ConfigSection, Manifest, ResolvedConfig, SetupCheck,
};
use p02_shared::Identifier;
use p02_wire::{ConfigValueType, Namespace, PluginPage, Source};
use serde_json::{Map, Value, json};

/// The version a document this build writes names. A document's version is
/// never judged when it is read.
pub(crate) const VERSION: &str = "project02.config.v2";

/// One of the two documents settings are read from: the home's, or a
/// character's overlay above it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Layer {
    Home,
    Overlay,
}

impl Layer {
    pub(crate) fn source(self) -> Source {
        match self {
            Self::Home => Source::Global,
            Self::Overlay => Source::Character,
        }
    }
}

/// Whose settings: the home's, or one character's, read over the home's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Target {
    Home,
    Character(Identifier),
}

impl Target {
    /// The document this target writes.
    pub(crate) fn own_layer(&self) -> Layer {
        match self {
            Self::Home => Layer::Home,
            Self::Character(_) => Layer::Overlay,
        }
    }

    /// The documents a value of `scope` is taken from for this target,
    /// nearest first: those it reads that the scope lets hold the value. A
    /// scope every reader honors is one no hand edit walks around, so the
    /// views, the merge and the writes all take values by it.
    pub(crate) fn layers(&self, scope: ConfigScope) -> Vec<Layer> {
        let read: &[Layer] = match self {
            Self::Home => &[Layer::Home],
            Self::Character(_) => &[Layer::Overlay, Layer::Home],
        };

        read.iter()
            .copied()
            .filter(|layer| authorable(scope, *layer))
            .collect()
    }

    /// Whether this target may set a value of `scope`.
    pub(crate) fn authors(&self, scope: ConfigScope) -> bool {
        authorable(scope, self.own_layer())
    }
}

/// Whether the document of `layer` may hold a value of `scope`: the home's
/// holds all but a character's own, and a character's all but the home's.
pub(crate) fn authorable(scope: ConfigScope, layer: Layer) -> bool {
    match layer {
        Layer::Home => scope != ConfigScope::CharacterOnly,
        Layer::Overlay => scope != ConfigScope::GlobalOnly,
    }
}

/// The sentence for a value `layer` holds that its scope keeps from it, a
/// switch when `field` is `None`, which also refuses a write of one.
pub(crate) fn outside_scope(id: &str, field: Option<&str>, layer: Layer) -> String {
    let (owner, owners, others) = match layer {
        Layer::Home => ("a character", "a character's", "the home's"),
        Layer::Overlay => ("the home", "the home's", "a character's"),
    };

    match field {
        None => format!(
            "The switch of \"{id}\" belongs to {owner}: only {owners} settings may turn it on \
             or off, and {others} choice is never used."
        ),
        Some(field) => format!(
            "Setting \"{field}\" of \"{id}\" belongs to {owner}: only {owners} settings may set \
             it, and {others} value is never used."
        ),
    }
}

/// What a value of `field` must be, as a sentence says it after "must be".
pub(crate) fn expectation(field: &ConfigField) -> String {
    if let Some(allowed) = field.allowed_values() {
        let quoted: Vec<String> = allowed.iter().map(|value| format!("\"{value}\"")).collect();

        return match quoted.split_last() {
            Some((last, rest)) if !rest.is_empty() => {
                format!("one of {} or {last}", rest.join(", "))
            }
            _ => quoted.concat(),
        };
    }

    if field.secret() {
        return "a non-blank string".to_owned();
    }

    match field.value_type() {
        Some(
            ConfigValueType::String
            | ConfigValueType::Path
            | ConfigValueType::Url
            | ConfigValueType::Enum,
        ) => "a string",
        Some(ConfigValueType::Number) => "a number",
        Some(ConfigValueType::Boolean) => "a boolean",
        Some(ConfigValueType::Object) => "an object",
        Some(ConfigValueType::Array) => "an array",
        None => "a JSON value",
    }
    .to_owned()
}

/// A messaging connector this build has: its section of the settings,
/// declared as a plugin's is, and the field pairing writes an approved
/// account into.
#[derive(Debug)]
pub struct Connector {
    id: Identifier,
    display_name: &'static str,
    version: &'static str,
    config: ConfigSection,
    reasons: Vec<String>,
    pairing_field: &'static str,
}

impl Connector {
    #[must_use]
    pub fn id(&self) -> &Identifier {
        &self.id
    }

    /// The field of the home's settings an approved pairing writes its
    /// account into.
    #[must_use]
    pub fn pairing_field(&self) -> &str {
        self.pairing_field
    }
}

fn telegram() -> Connector {
    let config = ConfigSection::from_value(&json!({
        "scope": "global_with_character_overrides",
        "fields": [
            {
                "name": "botToken",
                "label": "Token",
                "description": "This character's bot, as @BotFather gave it. The character \
                    answers in Telegram as that bot.",
                "placeholder": "Paste from @BotFather",
                "scope": "character_only",
                "secret": true,
                "valueType": "string",
                "redactionLabels": ["secret"],
            },
            {
                "name": "managementBotToken",
                "label": "Token",
                "description": "Optional. A bot for the home itself: who is on, what is \
                    waiting for your approval, pairing.",
                "placeholder": "Paste from @BotFather",
                "scope": "global_only",
                "secret": true,
                "valueType": "string",
                "redactionLabels": ["secret"],
            },
            {
                "name": "mirror",
                "label": "Show Other Chats",
                "description": "Show in this chat what you and the character said on other \
                    surfaces, like the web page.",
                "scope": "global_only",
                "secret": false,
                "valueType": "boolean",
                "defaultValue": true,
                "redactionLabels": [],
            },
            {
                "name": "pairedUsers",
                "label": "Paired Accounts",
                "description": "Accounts allowed to talk to your characters, each id with a \
                    name. Pairing adds one; remove a line to unpair it.",
                "scope": "global_only",
                "secret": false,
                "valueType": "object",
                "defaultValue": {},
                "redactionLabels": [],
            },
        ],
    }))
    .expect("the Telegram connector's declaration meets the rules of a manifest");

    Connector {
        id: Identifier::new("telegram").expect("telegram is an identifier"),
        display_name: "Telegram",
        version: "1.0.0",
        config,
        reasons: vec!["built_in_connector".to_owned()],
        pairing_field: "pairedUsers",
    }
}

static CONNECTORS: LazyLock<Vec<Connector>> = LazyLock::new(|| vec![telegram()]);

/// Every connector this build has: a connector is built in, never found.
#[must_use]
pub fn connectors() -> &'static [Connector] {
    &CONNECTORS
}

/// No connector of this build answers to the id asked for.
#[derive(Debug, thiserror::Error)]
#[error("Unknown connector \"{id}\". Connectors: {known}.", known = known_connectors())]
pub struct UnknownConnector {
    id: String,
}

fn known_connectors() -> String {
    let ids: Vec<&str> = connectors()
        .iter()
        .map(|connector| connector.id().as_str())
        .collect();

    ids.join(", ")
}

/// The connector this build has under `id`.
///
/// # Errors
///
/// [`UnknownConnector`] when this build has none of that id.
pub fn connector(id: &str) -> Result<&'static Connector, UnknownConnector> {
    connectors()
        .iter()
        .find(|connector| connector.id().as_str() == id)
        .ok_or_else(|| UnknownConnector { id: id.to_owned() })
}

/// The sections a home's settings are judged against: the plugins this
/// build compiles in, one per id, in the order it lists them, the order
/// her plugins run and are reported in, each with the check of whether its
/// settings are enough to build it, and its connectors.
#[derive(Debug, Default)]
pub struct Sections {
    plugins: Vec<(Manifest, SetupCheck)>,
}

impl Sections {
    /// The sections of `plugins`, the build's list, and of every
    /// connector.
    #[must_use]
    pub fn new(plugins: impl IntoIterator<Item = (Manifest, SetupCheck)>) -> Self {
        Self {
            plugins: plugins.into_iter().collect(),
        }
    }

    /// Every section, the plugins' in the order listed and then the
    /// connectors'.
    pub(crate) fn declared(&self) -> impl Iterator<Item = Declared<'_>> {
        self.plugins
            .iter()
            .map(|(manifest, check)| Declared::Plugin(manifest, *check))
            .chain(connectors().iter().map(Declared::Connector))
    }

    pub(crate) fn find(&self, namespace: Namespace, id: &str) -> Option<Declared<'_>> {
        self.declared()
            .find(|declared| declared.namespace() == namespace && declared.id().as_str() == id)
    }
}

/// A declared section, of a plugin, with the check of its setup, or of a
/// connector.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Declared<'s> {
    Plugin(&'s Manifest, SetupCheck),
    Connector(&'s Connector),
}

impl<'s> Declared<'s> {
    pub(crate) fn namespace(self) -> Namespace {
        match self {
            Self::Plugin(..) => Namespace::Plugins,
            Self::Connector(_) => Namespace::Connectors,
        }
    }

    pub(crate) fn id(self) -> &'s Identifier {
        match self {
            Self::Plugin(manifest, _) => manifest.id(),
            Self::Connector(connector) => &connector.id,
        }
    }

    pub(crate) fn display_name(self) -> &'s str {
        match self {
            Self::Plugin(manifest, _) => manifest.display_name(),
            Self::Connector(connector) => connector.display_name,
        }
    }

    pub(crate) fn version(self) -> &'s str {
        match self {
            Self::Plugin(manifest, _) => manifest.version(),
            Self::Connector(connector) => connector.version,
        }
    }

    pub(crate) fn config(self) -> &'s ConfigSection {
        match self {
            Self::Plugin(manifest, _) => manifest.config(),
            Self::Connector(connector) => &connector.config,
        }
    }

    /// Whether the section is on where no settings switch it.
    pub(crate) fn default_enabled(self) -> bool {
        match self {
            Self::Plugin(manifest, _) => manifest.activation().default_enabled(),
            Self::Connector(_) => true,
        }
    }

    pub(crate) fn reasons(self) -> &'s [String] {
        match self {
            Self::Plugin(manifest, _) => manifest.activation().reasons(),
            Self::Connector(connector) => &connector.reasons,
        }
    }

    /// How a page draws a plugin's row, when its manifest says; a
    /// connector declares none.
    pub(crate) fn page(self) -> Option<&'s PluginPage> {
        match self {
            Self::Plugin(manifest, _) => manifest.page(),
            Self::Connector(_) => None,
        }
    }

    /// What a plugin's manifest requests of the host; a connector
    /// requests nothing.
    pub(crate) fn access(self) -> Option<&'s AccessMap> {
        match self {
            Self::Plugin(manifest, _) => Some(manifest.requested_access()),
            Self::Connector(_) => None,
        }
    }

    /// Whether `values`, the section's in effect, are enough to build it,
    /// as its plugin's own check judges them: a connector needs nothing
    /// more.
    pub(crate) fn setup(self, values: &Map<String, Value>) -> Result<(), String> {
        match self {
            Self::Plugin(manifest, check) => {
                check(&ResolvedConfig::resolve(manifest.config(), values))
            }
            Self::Connector(_) => Ok(()),
        }
    }

    /// The scope of `field`: its own, which may only narrow the section's.
    pub(crate) fn scope_of(self, field: &ConfigField) -> ConfigScope {
        field.scope().unwrap_or(self.config().scope())
    }

    pub(crate) fn path(self) -> String {
        format!("{}.{}", self.namespace().as_str(), self.id())
    }

    pub(crate) fn field_path(self, field: &str) -> String {
        format!("{}.config.{field}", self.path())
    }
}
