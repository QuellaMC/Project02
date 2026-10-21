//! What the settings may hold: the host's own fields, each plugin's section
//! as its manifest declares it and each connector's as this build declares
//! it, and from which document a scope lets each target take a value.

use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::sync::LazyLock;

use p02_contracts::{
    ConfigField, ConfigScope, ConfigSection, ConfigValueType, Manifest, PluginKind,
};
use p02_core::SpeakerName;
use p02_shared::{BASE_URL_RULE, BaseUrl, Identifier};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::diagnostic::Code;

/// The version every settings document names, and the only one read.
pub(crate) const VERSION: &str = "project02.config.v2";

/// The two stanzas of a document that hold declared sections by id. A
/// plugin and a connector may share an id: their sections never meet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Namespace {
    Plugins,
    Connectors,
}

impl Namespace {
    pub(crate) const ALL: [Self; 2] = [Self::Plugins, Self::Connectors];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Plugins => "plugins",
            Self::Connectors => "connectors",
        }
    }
}

/// Where a value in effect comes from: its field's declared default, the
/// home's settings, or the character's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Default,
    Global,
    Character,
}

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
        Some(ConfigValueType::String | ConfigValueType::Path | ConfigValueType::Enum) => "a string",
        Some(ConfigValueType::Number) => "a number",
        Some(ConfigValueType::Boolean) => "a boolean",
        Some(ConfigValueType::Object) => "an object",
        Some(ConfigValueType::Array) => "an array",
        None => "a JSON value",
    }
    .to_owned()
}

/// Who answers as a character. Only real providers are here: the test
/// provider is a test harness's switch, never a setting, and a home has no
/// provider until its person chooses one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RoleModelProvider {
    /// A model on NVIDIA's cloud, or on a server of the person's own that
    /// speaks its wire.
    Nvidia,
}

impl RoleModelProvider {
    pub const ALL: [Self; 1] = [Self::Nvidia];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Nvidia => "nvidia",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|provider| provider.as_str() == text)
    }
}

/// One of the host's own fields: its declaration, as a plugin's field is
/// declared, and the rule its values meet beyond their type, with the code
/// and the sentence a value that breaks it is reported by.
#[derive(Debug)]
pub(crate) struct HostField {
    pub(crate) declaration: ConfigField,
    rule: fn(&Value) -> bool,
    pub(crate) code: Code,
    pub(crate) sentence: String,
}

impl HostField {
    pub(crate) fn name(&self) -> &str {
        self.declaration.name().as_str()
    }

    pub(crate) fn path(&self) -> String {
        format!("project02.{}", self.name())
    }

    /// The one judge of a value of this field, for the loader and every
    /// writer alike. A blank text is never a value: unsetting is its own
    /// operation.
    pub(crate) fn accepts(&self, value: &Value) -> bool {
        self.declaration.accepts(value) && (self.rule)(value)
    }
}

/// The name a person goes by, trimmed, as a speaker takes it.
pub(crate) fn user_display_name(value: &Value) -> Option<SpeakerName> {
    value
        .as_str()
        .and_then(|text| SpeakerName::new(text.trim()).ok())
}

pub(crate) fn role_model_provider(value: &Value) -> Option<RoleModelProvider> {
    value.as_str().and_then(RoleModelProvider::parse)
}

pub(crate) fn base_url(value: &Value) -> Option<BaseUrl> {
    value.as_str().and_then(|text| BaseUrl::parse(text).ok())
}

pub(crate) fn context_window_tokens(value: &Value) -> Option<NonZeroU64> {
    value.as_u64().and_then(NonZeroU64::new)
}

pub(crate) fn text(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.trim().is_empty())
}

/// The rule each host field meets beyond its declaration, and what a value
/// that breaks it must be instead when its declaration does not say.
struct HostRule {
    name: &'static str,
    accepts: fn(&Value) -> bool,
    code: Code,
    must_be: Option<&'static str>,
}

const HOST_RULES: [HostRule; 8] = [
    HostRule {
        name: "userDisplayName",
        accepts: |value| user_display_name(value).is_some(),
        code: Code::StringInvalid,
        must_be: Some("a non-empty single-line string of at most 128 characters"),
    },
    HostRule {
        name: "roleModelProvider",
        accepts: |value| role_model_provider(value).is_some(),
        code: Code::RoleModelProviderInvalid,
        must_be: None,
    },
    HostRule {
        name: "nvidiaApiKey",
        accepts: |_| true,
        code: Code::SecretValueInvalid,
        must_be: Some("a non-empty string"),
    },
    HostRule {
        name: "nvidiaModel",
        accepts: |value| text(value).is_some(),
        code: Code::StringInvalid,
        must_be: Some("a non-empty string"),
    },
    HostRule {
        name: "nvidiaBaseUrl",
        accepts: |value| base_url(value).is_some(),
        code: Code::NvidiaBaseUrlInvalid,
        must_be: Some(BASE_URL_RULE),
    },
    HostRule {
        name: "contextWindowTokens",
        accepts: |value| context_window_tokens(value).is_some(),
        code: Code::ContextWindowTokensInvalid,
        must_be: Some("a positive whole number of tokens"),
    },
    HostRule {
        name: "defaultMemoryProvider",
        accepts: |value| text(value).is_some(),
        code: Code::StringInvalid,
        must_be: Some("a non-empty string"),
    },
    HostRule {
        name: "enabled",
        accepts: |_| true,
        code: Code::BooleanInvalid,
        must_be: None,
    },
];

/// The host's fields in the order the settings page shows them: what a
/// person decides first, then the knobs, then the switch.
fn host_declaration() -> Value {
    let providers: Vec<&str> = RoleModelProvider::ALL
        .iter()
        .map(|provider| provider.as_str())
        .collect();

    json!({
        "scope": "global_with_character_overrides",
        "fields": [
            {
                "name": "userDisplayName",
                "description": "The name you go by in conversation. Applies to new \
                    conversations; earlier ones keep the name they were started with.",
                "required": false,
                "secret": false,
                "valueType": "string",
                "defaultValue": "You",
                "redactionLabels": [],
            },
            {
                "name": "roleModelProvider",
                "description": "Who answers as the character: nvidia is a model on NVIDIA's \
                    cloud, or on the server nvidiaBaseUrl names. No character starts until one \
                    is chosen.",
                "required": false,
                "secret": false,
                "valueType": "enum",
                "allowedValues": providers,
                "redactionLabels": [],
            },
            {
                "name": "nvidiaApiKey",
                "description": "Your NVIDIA API key. Needed when the provider is nvidia; never \
                    shown back once saved.",
                "required": false,
                "secret": true,
                "valueType": "string",
                "redactionLabels": ["secret"],
            },
            {
                "name": "nvidiaModel",
                "description": "The NVIDIA model to talk to; the provider's default when left \
                    unset.",
                "required": false,
                "secret": false,
                "valueType": "string",
                "redactionLabels": [],
            },
            {
                "name": "nvidiaBaseUrl",
                "description": "Where the model runs: the base address of an NVIDIA NIM or any \
                    OpenAI-compatible server, such as http://localhost:1234/v1. NVIDIA's cloud \
                    when left unset. Use https:// for a server on another machine: http:// \
                    sends the key and the conversation in the clear.",
                "required": false,
                "secret": false,
                "valueType": "string",
                "redactionLabels": [],
            },
            {
                "name": "contextWindowTokens",
                "description": "How much conversation the model can hold at once, in tokens; up \
                    to half of it replays past messages. Lower it if the model runs out of room.",
                "required": false,
                "secret": false,
                "valueType": "number",
                "defaultValue": 32768,
                "redactionLabels": [],
            },
            {
                "name": "defaultMemoryProvider",
                "description": "Which enabled memory plugin keeps what the character remembers, \
                    when more than one is enabled.",
                "required": false,
                "secret": false,
                "valueType": "string",
                "redactionLabels": [],
            },
            {
                "name": "enabled",
                "description": "Whether the character is switched on. A character that is off \
                    is not started and cannot be reached; turning it back on starts it.",
                "required": false,
                "secret": false,
                "valueType": "boolean",
                "defaultValue": true,
                "redactionLabels": [],
            },
        ],
    })
}

static HOST: LazyLock<Vec<HostField>> = LazyLock::new(|| {
    // The declaration is this build's own, so a refusal is a defect a test
    // of the registry shows before any build ships it.
    let section = ConfigSection::from_value(&host_declaration())
        .expect("the host's declaration meets the rules of a manifest");

    section
        .fields()
        .iter()
        .map(|declaration| {
            let rule = HOST_RULES
                .iter()
                .find(|rule| rule.name == declaration.name().as_str())
                .expect("every host field has its rule");
            let must_be = rule
                .must_be
                .map_or_else(|| expectation(declaration), str::to_owned);

            HostField {
                sentence: format!("Project02 {} must be {must_be}.", declaration.name()),
                declaration: declaration.clone(),
                rule: rule.accepts,
                code: rule.code,
            }
        })
        .collect()
});

/// The host's fields, in page order.
pub(crate) fn host_fields() -> &'static [HostField] {
    &HOST
}

pub(crate) fn host_field(name: &str) -> Option<&'static HostField> {
    host_fields().iter().find(|field| field.name() == name)
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
                "description": "This character's bot, as @BotFather gave it. The character \
                    answers in Telegram as that bot.",
                "scope": "character_only",
                "required": false,
                "secret": true,
                "valueType": "string",
                "reloadRequired": false,
                "redactionLabels": ["secret"],
            },
            {
                "name": "managementBotToken",
                "description": "Optional. A bot for the home itself: who is on, what is \
                    waiting for your approval, pairing.",
                "scope": "global_only",
                "required": false,
                "secret": true,
                "valueType": "string",
                "reloadRequired": false,
                "redactionLabels": ["secret"],
            },
            {
                "name": "mirror",
                "description": "Show in this chat what you and the character said on other \
                    surfaces, like the web page.",
                "required": false,
                "secret": false,
                "valueType": "boolean",
                "defaultValue": true,
                "reloadRequired": false,
                "redactionLabels": [],
            },
            {
                "name": "pairedUsers",
                "description": "Accounts allowed to talk to your characters, each id with a \
                    name. Pairing adds one; remove a line to unpair it.",
                "scope": "global_only",
                "required": false,
                "secret": false,
                "valueType": "object",
                "defaultValue": {},
                "reloadRequired": false,
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

/// The sections a home's settings are judged against: the plugins this
/// build compiles in, one per id, and its connectors.
#[derive(Debug, Default)]
pub struct Sections {
    plugins: BTreeMap<Identifier, Manifest>,
}

impl Sections {
    /// The sections of `plugins` and of every connector. A later manifest
    /// of an id stands for it: a section has one declaration.
    #[must_use]
    pub fn new(plugins: impl IntoIterator<Item = Manifest>) -> Self {
        Self {
            plugins: plugins
                .into_iter()
                .map(|manifest| (manifest.id().clone(), manifest))
                .collect(),
        }
    }

    /// Every section, the plugins' in id order and then the connectors'.
    pub(crate) fn declared(&self) -> impl Iterator<Item = Declared<'_>> {
        self.plugins
            .values()
            .map(Declared::Plugin)
            .chain(connectors().iter().map(Declared::Connector))
    }

    pub(crate) fn find(&self, namespace: Namespace, id: &str) -> Option<Declared<'_>> {
        self.declared()
            .find(|declared| declared.namespace() == namespace && declared.id().as_str() == id)
    }
}

/// A declared section, of a plugin or of a connector.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Declared<'s> {
    Plugin(&'s Manifest),
    Connector(&'s Connector),
}

impl<'s> Declared<'s> {
    pub(crate) fn namespace(self) -> Namespace {
        match self {
            Self::Plugin(_) => Namespace::Plugins,
            Self::Connector(_) => Namespace::Connectors,
        }
    }

    pub(crate) fn id(self) -> &'s Identifier {
        match self {
            Self::Plugin(manifest) => manifest.id(),
            Self::Connector(connector) => &connector.id,
        }
    }

    pub(crate) fn display_name(self) -> &'s str {
        match self {
            Self::Plugin(manifest) => manifest.display_name(),
            Self::Connector(connector) => connector.display_name,
        }
    }

    pub(crate) fn version(self) -> &'s str {
        match self {
            Self::Plugin(manifest) => manifest.version(),
            Self::Connector(connector) => connector.version,
        }
    }

    pub(crate) fn config(self) -> &'s ConfigSection {
        match self {
            Self::Plugin(manifest) => manifest.config(),
            Self::Connector(connector) => &connector.config,
        }
    }

    /// Whether the section is on where no settings switch it.
    pub(crate) fn default_enabled(self) -> bool {
        match self {
            Self::Plugin(manifest) => manifest.activation().default_enabled(),
            Self::Connector(_) => true,
        }
    }

    pub(crate) fn reasons(self) -> &'s [String] {
        match self {
            Self::Plugin(manifest) => manifest.activation().reasons(),
            Self::Connector(connector) => &connector.reasons,
        }
    }

    pub(crate) fn is_memory_provider(self) -> bool {
        matches!(self, Self::Plugin(manifest) if manifest.kind() == PluginKind::MemoryProvider)
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
