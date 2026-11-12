//! The settings on the wire: a settings screen's view, a connector's read,
//! and the one change a client makes to them.

use std::collections::BTreeMap;
use std::fmt;
use std::num::NonZeroU32;

use p02_shared::{Fingerprint, Identifier, vocabulary};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::diagnostic::Diagnostic;

/// What a settings screen renders: the fingerprint a change must present,
/// the diagnostics, whether the target's settings give a character an AI
/// model, the services she can think with, and the host's fields and every
/// section the target may set, all in one field shape. A target whose
/// settings cannot be resolved is refused with the reason, never shown as
/// blank fields.
#[derive(Debug, Serialize, JsonSchema, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ConfigView {
    Ok {
        fingerprint: Fingerprint,
        diagnostics: Vec<Diagnostic>,
        model: Setup,
        /// Every service, in the order a page lists them.
        services: Vec<ModelService>,
        project02: Vec<FieldView>,
        sections: Vec<SectionView>,
    },
    Refused {
        reason: ViewRefusal,
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ViewRefusal {
    UnknownCharacter,
    ConfigUnloadable,
}

vocabulary! {
    /// The services a character can think with, each by the value of
    /// `roleModelProvider` that chooses it, in the order a page lists
    /// them. Only real services are here: the test provider is a test
    /// harness's switch, never a setting, and a home has none until its
    /// person chooses one.
    RoleModelProvider {
        /// A ChatGPT plan the home is signed in to.
        Chatgpt = "chatgpt",
        /// The OpenAI API, on the person's key.
        Openai = "openai",
        /// A model on NVIDIA's cloud, or on a server of the person's own
        /// that speaks its wire.
        Nvidia = "nvidia",
    }
}

/// A service as a settings page lists it: its name, what it is and where a
/// key for it comes from, whether it is connected and as whom, and which of
/// the host's fields are its own, its model's among them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ModelService {
    pub id: RoleModelProvider,
    /// What a page calls it.
    pub name: String,
    /// What it is, in a line a page shows under its name.
    pub summary: String,
    /// Where a key for it comes from, in a sentence; none for the ChatGPT
    /// plan, which takes no key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_from: Option<String>,
    /// Whether it is connected for the target: a credential of it in
    /// effect, its key or for NVIDIA a server of the person's own too; for
    /// the ChatGPT plan, the home signed in, which is no setting.
    pub connected: bool,
    /// Whom the ChatGPT plan is connected as, while the home is signed in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<PlanAccount>,
    /// The one of its fields that names the model she asks it for.
    pub model: Identifier,
    /// Its own fields, in the order a page shows them.
    pub fields: Vec<Identifier>,
}

/// The account a ChatGPT plan is signed in to: its email and its plan, such
/// as `plus`, as OpenAI named them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[ts(optional_fields)]
pub struct PlanAccount {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

/// One field as a screen shows it: its declaration, what the target's own
/// document holds for it, and the value in effect with where it comes
/// from, a secret's as `[redacted]`.
#[derive(Debug, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "RuntimeConfigFieldInspectShape", optional_fields)]
#[schemars(rename = "RuntimeConfigFieldInspectShape")]
pub struct FieldView {
    pub name: Identifier,
    /// What a page calls the field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub description: String,
    /// What an empty box shows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    pub secret: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_type: Option<ConfigValueType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_values: Option<Vec<String>>,
    /// The values a page offers first, while it takes any other of the
    /// field's type too.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_values: Option<Vec<String>>,
    /// The words for each allowed or suggested value, which a page lists
    /// in the order of `allowedValues` or `suggestedValues`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choices: Option<BTreeMap<String, String>>,
    pub agent_mutable: bool,
    pub authored: Authored,
    pub effective_source: Source,
    pub effective: EffectiveView,
}

/// What the target's own document holds for a field.
#[derive(Debug, Serialize, JsonSchema, TS)]
#[ts(optional_fields)]
pub struct Authored {
    pub configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

/// The value in effect: authored in a document, `config`; the declared
/// default, `default`; or none, `missing`. A refused value is in effect
/// unresolved, its value shown unless it is a secret's.
#[derive(Debug, Serialize, JsonSchema, TS)]
#[ts(optional_fields)]
pub struct EffectiveView {
    pub name: Identifier,
    pub secret: bool,
    pub source: ValueSource,
    pub resolved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ValueSource {
    Config,
    Default,
    Missing,
}

/// One section as a screen shows it.
#[derive(Debug, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "RuntimeConfigSectionInspectShape", optional_fields)]
#[schemars(rename = "RuntimeConfigSectionInspectShape")]
pub struct SectionView {
    pub namespace: Namespace,
    pub id: Identifier,
    pub display_name: String,
    pub version: String,
    /// How a plugin's row is drawn, when its manifest says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<PluginPage>,
    /// What a plugin's manifest requests, each access with its level; a
    /// connector has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access: Option<BTreeMap<AccessName, AccessLevel>>,
    pub enabled: bool,
    /// Which document decides `enabled`, or the declaration's default.
    pub enabled_source: Source,
    pub activation: SectionActivation,
    /// Whether its settings are enough to build it, judged switched on or
    /// off: a plugin switched on before they are does not run. A
    /// connector's always are.
    pub setup: Setup,
    pub fields: Vec<FieldView>,
    /// The cards `fields` are drawn in, each field in one at least.
    pub layout: Vec<LayoutCard>,
    pub diagnostics: Vec<Diagnostic>,
}

/// Whether settings are enough for what they set up, a plugin or a
/// character's AI model; while they are not, `message` says what to fill
/// in, in the words of the settings page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[ts(optional_fields)]
pub struct Setup {
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// The settings' own judgement of what they set up: enough, or the
/// sentence saying what to fill in.
impl From<Result<(), String>> for Setup {
    fn from(judged: Result<(), String>) -> Self {
        match judged {
            Ok(()) => Self {
                ready: true,
                message: None,
            },
            Err(message) => Self {
                ready: false,
                message: Some(message),
            },
        }
    }
}

/// How a plugin's row on a settings page is drawn, as its manifest
/// declares it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[ts(optional_fields)]
pub struct PluginPage {
    /// The row's one-line subtitle.
    pub summary: String,
    /// A name of the page's own set, as `tint` is: a page falls back for
    /// one it does not know.
    pub icon: String,
    pub tint: String,
    pub placement: Placement,
    /// Where the row comes among its placement's: by this, then by
    /// display name.
    pub order: NonZeroU32,
    /// What the plugin's entry among a page's connections is called, for
    /// a plugin whose home settings are an account set up once.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
}

vocabulary! {
    /// Where a plugin's row belongs on a settings page.
    Placement {
        /// Among what makes up her mind and body.
        MindBody = "mind_body",
        /// Among what she is permitted to do.
        Permission = "permission",
    }
}

/// One card of a section's layout: rows of its fields, under a title and
/// over a footer when it has them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[ts(optional_fields)]
pub struct LayoutCard {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footer: Option<String>,
    /// Whether the card holds what most people leave as it is: a page may
    /// keep a row of it out of sight while nothing sets its field.
    pub advanced: bool,
    /// When the card's rows have an effect.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when: Option<LayoutWhen>,
    pub rows: Vec<LayoutRow>,
}

/// One row of a card: a field of the section.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[ts(optional_fields)]
pub struct LayoutRow {
    pub field: Identifier,
    /// When the field has an effect, beyond its card's own condition.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when: Option<LayoutWhen>,
}

/// A condition on a field of the same section that lists its allowed
/// values: it holds while that field's value in effect is one of `is`.
/// What it guards has no effect otherwise, so a page may hide it then.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
pub struct LayoutWhen {
    pub field: Identifier,
    pub is: Vec<String>,
}

/// Whether a section runs, as its settings decide it, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[ts(rename = "RuntimeConfigSectionActivationShape")]
#[schemars(rename = "RuntimeConfigSectionActivationShape")]
pub struct SectionActivation {
    pub enabled: bool,
    pub status: ActivationStatus,
    pub reasons: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ActivationStatus {
    Active,
    Disabled,
    Blocked,
}

/// What a connector runs on: an entry for the home and one for each
/// installed character that is switched on, in roster order, each with
/// its section's activation and, while that is active, the values in
/// effect for it, secrets in the clear. The home's switch is a default,
/// not a master switch: each entry is judged by its own.
#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ConnectorConfigView {
    #[serde(rename_all = "camelCase")]
    Ok {
        connector_id: Identifier,
        home: ConnectorEntry,
        characters: Vec<CharacterConnectorEntry>,
    },
    Refused {
        reason: ConnectorRefusal,
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorRefusal {
    UnknownConnector,
    ConfigUnloadable,
}

/// A connector's section for one target: its activation, and each field
/// that has a value it takes for that target, the home's fields reaching
/// every character's entry.
#[derive(Serialize, Deserialize, JsonSchema, TS)]
#[ts(rename = "ConnectorConfigEntry")]
#[schemars(rename = "ConnectorConfigEntry")]
pub struct ConnectorEntry {
    pub activation: SectionActivation,
    pub values: Map<String, Value>,
}

/// Names the fields with a value only: the values are its tokens, in the
/// clear.
impl fmt::Debug for ConnectorEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConnectorEntry")
            .field("activation", &self.activation)
            .field("values", &self.values.keys().collect::<Vec<_>>())
            .finish()
    }
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CharacterConnectorEntry {
    pub character_id: Identifier,
    #[serde(flatten)]
    pub entry: ConnectorEntry,
}

/// Whose settings a view reads or a change writes, and whose bot a
/// connector's is: the home's, or one character's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
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

/// The two stanzas of a document that hold declared sections by id. A
/// plugin and a connector may share an id: their sections never meet.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema, TS,
)]
#[serde(rename_all = "snake_case")]
#[ts(rename = "RuntimeConfigSectionNamespace")]
#[schemars(rename = "RuntimeConfigSectionNamespace")]
pub enum Namespace {
    Plugins,
    Connectors,
}

impl Namespace {
    pub const ALL: [Self; 2] = [Self::Plugins, Self::Connectors];

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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Default,
    Global,
    Character,
}

vocabulary! {
    /// What a plugin's manifest may request: a service the host hands it,
    /// or a declaration of what it does.
    AccessName {
        CharacterFileStore = "character_file_store",
        SessionHistory = "session_history",
        PluginDatabase = "plugin_database",
        TurnContext = "turn_context",
        ModelInput = "model_input",
        TrustedContext = "trusted_context",
        /// The plugin sends what it is given to a service outside the
        /// app. The host hands nothing for it.
        Network = "network",
    }
}

vocabulary! {
    /// How much of a service: ordered, so `Write` satisfies a need for `Read`.
    AccessLevel {
        None = "none",
        Read = "read",
        Write = "write",
    }
}

vocabulary! {
    /// The kind of value a config field holds. Whether it holds a
    /// credential is the field's `secret` flag alone to say.
    ConfigValueType {
        String = "string",
        Number = "number",
        Boolean = "boolean",
        Object = "object",
        Array = "array",
        /// A place on the person's machine.
        Path = "path",
        /// A server the plugin sends to.
        Url = "url",
        Enum = "enum",
    }
}
