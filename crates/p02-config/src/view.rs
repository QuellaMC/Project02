//! The settings as their readers are shown them: a settings screen's view,
//! a connector's read, and the report of `inspect`. Only a connector's
//! read carries a secret, since a token is what a connector exists to use.

use std::fmt;
use std::num::NonZeroU64;

use p02_characters::Discovery;
use p02_contracts::{AccessMap, ConfigValueType, Manifest, PluginKind};
use p02_core::SpeakerName;
use p02_shared::{Fingerprint, Identifier, error_sentence, sentence};
use p02_store::Home;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::change::ConfigTarget;
use crate::conceal::conceal;
use crate::declaration::{
    Declared, Namespace, RoleModelProvider, Sections, Source, Target, connectors,
};
use crate::diagnostic::Diagnostic;
use crate::resolve::{Effective, Field, ReadSettingsError, Resolution, Section, Status};

/// What a settings screen renders: the fingerprint a change must present,
/// the diagnostics, and the host's fields and every section the target may
/// set, all in one field shape. A target whose settings cannot be resolved
/// is refused with the reason, never shown as blank fields.
#[derive(Debug, Serialize, JsonSchema, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ConfigView {
    Ok {
        fingerprint: Fingerprint,
        diagnostics: Vec<Diagnostic>,
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

/// One field as a screen shows it: its declaration, what the target's own
/// document holds for it, and the value in effect with where it comes
/// from, a secret's as `[redacted]`.
#[derive(Debug, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "RuntimeConfigFieldInspectShape", optional_fields)]
#[schemars(rename = "RuntimeConfigFieldInspectShape")]
pub struct FieldView {
    name: Identifier,
    description: String,
    required: bool,
    secret: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value_type: Option<ConfigValueType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    allowed_values: Option<Vec<String>>,
    agent_mutable: bool,
    authored: Authored,
    effective_source: Source,
    effective: EffectiveView,
}

/// What the target's own document holds for a field.
#[derive(Debug, Serialize, JsonSchema, TS)]
#[ts(optional_fields)]
pub struct Authored {
    configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
}

/// The value in effect: authored in a document, `config`; the declared
/// default, `default`; or none, `missing`. A refused value is in effect
/// unresolved, its value shown unless it is a secret's.
#[derive(Debug, Serialize, JsonSchema, TS)]
#[ts(optional_fields)]
pub struct EffectiveView {
    name: Identifier,
    secret: bool,
    source: ValueSource,
    resolved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
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
#[ts(rename = "RuntimeConfigSectionInspectShape")]
#[schemars(rename = "RuntimeConfigSectionInspectShape")]
pub struct SectionView {
    namespace: Namespace,
    id: Identifier,
    display_name: String,
    version: String,
    enabled: bool,
    /// Which document decides `enabled`, or the declaration's default.
    enabled_source: Source,
    activation: SectionActivation,
    fields: Vec<FieldView>,
    diagnostics: Vec<Diagnostic>,
}

/// Whether a section runs, as its settings decide it, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[ts(rename = "RuntimeConfigSectionActivationShape")]
#[schemars(rename = "RuntimeConfigSectionActivationShape")]
pub struct SectionActivation {
    enabled: bool,
    status: ActivationStatus,
    reasons: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ActivationStatus {
    Active,
    Disabled,
    Blocked,
}

impl ConfigView {
    /// The view of `target`'s settings.
    #[must_use]
    pub fn read(
        home: &Home,
        sections: &Sections,
        discovery: &Discovery,
        target: &ConfigTarget,
    ) -> Self {
        match Resolution::read(home, sections, discovery, target) {
            Ok(resolution) => resolution.view(),
            Err(error) => Self::refused(&error),
        }
    }

    /// The refusal of a view whose settings `error` keeps from resolving.
    #[must_use]
    pub fn refused(error: &ReadSettingsError) -> Self {
        let (reason, message) = refusal(error);

        Self::Refused { reason, message }
    }
}

/// Why settings cannot be shown, and the sentence that says so.
fn refusal(error: &ReadSettingsError) -> (ViewRefusal, String) {
    let reason = match error {
        ReadSettingsError::UnknownCharacter(_) => ViewRefusal::UnknownCharacter,
        ReadSettingsError::Storage(_) | ReadSettingsError::Unreadable(_) => {
            ViewRefusal::ConfigUnloadable
        }
    };

    (reason, error.sentence())
}

impl ReadSettingsError {
    /// What keeps the settings from being read, as the sentence a person
    /// is shown, which never repeats a value.
    #[must_use]
    pub fn sentence(&self) -> String {
        match self {
            Self::UnknownCharacter(reason) => sentence(reason),
            Self::Storage(error) => error_sentence(error),
            Self::Unreadable(diagnostic) => diagnostic.message().to_owned(),
        }
    }
}

impl Resolution<'_> {
    /// The view of these settings: every host field, and every section,
    /// and of each section every field, that the target may set; secrets
    /// never. A person looks a section up by its name, so the screen lists
    /// the plugins' by id and then the connectors'.
    #[must_use]
    pub fn view(&self) -> ConfigView {
        let mut sections: Vec<SectionView> = self
            .sections()
            .iter()
            .filter_map(|section| self.section_shown(section))
            .collect();

        sections
            .sort_by(|left, right| (left.namespace, &left.id).cmp(&(right.namespace, &right.id)));

        ConfigView::Ok {
            fingerprint: self.fingerprint().clone(),
            diagnostics: self.diagnostics().to_vec(),
            project02: self.host().iter().map(field_view).collect(),
            sections,
        }
    }

    /// The section `id` of `namespace` as the view shows it; none when the
    /// target may not set it.
    #[must_use]
    pub fn section_view(&self, namespace: Namespace, id: &str) -> Option<SectionView> {
        self.section(namespace, id)
            .and_then(|section| self.section_shown(section))
    }

    fn section_shown(&self, section: &Section<'_>) -> Option<SectionView> {
        let target = self.target();

        target
            .authors(section.declared.config().scope())
            .then(|| SectionView {
                namespace: section.declared.namespace(),
                id: section.declared.id().clone(),
                display_name: section.declared.display_name().to_owned(),
                version: section.declared.version().to_owned(),
                enabled: section.enabled(),
                enabled_source: section.switch.source(),
                activation: activation(section),
                fields: section
                    .fields
                    .iter()
                    .filter(|field| target.authors(section.declared.scope_of(field.declaration)))
                    .map(field_view)
                    .collect(),
                diagnostics: section.diagnostics.clone(),
            })
    }
}

impl SectionView {
    /// Whether the section runs, as its settings decide.
    #[must_use]
    pub fn activation_status(&self) -> ActivationStatus {
        self.activation.status
    }
}

fn field_view(field: &Field<'_>) -> FieldView {
    let declaration = field.declaration;
    let name = declaration.name().as_str();
    let secret = declaration.secret();

    FieldView {
        name: declaration.name().clone(),
        description: declaration.description().to_owned(),
        required: declaration.required(),
        secret,
        value_type: declaration.value_type(),
        allowed_values: declaration.allowed_values().map(<[String]>::to_vec),
        agent_mutable: declaration.agent_mutable() && !secret,
        authored: Authored {
            configured: field.authored.is_some(),
            value: field
                .authored
                .as_ref()
                .map(|value| conceal(name, secret, value)),
        },
        effective_source: field.effective.source(),
        effective: effective_view(field),
    }
}

fn effective_view(field: &Field<'_>) -> EffectiveView {
    let declaration = field.declaration;
    let name = declaration.name().as_str();
    let secret = declaration.secret();
    let shown = |value: &Value| Some(conceal(name, secret, value));
    let (source, resolved, value) = match &field.effective {
        Effective::Authored {
            value,
            accepted: true,
            ..
        } => (ValueSource::Config, true, shown(value)),
        Effective::Authored { value, .. } => (
            ValueSource::Config,
            false,
            (!secret).then(|| shown(value)).flatten(),
        ),
        Effective::Default(value) => (ValueSource::Default, true, shown(value)),
        Effective::Missing => (ValueSource::Missing, true, None),
    };

    EffectiveView {
        name: declaration.name().clone(),
        secret,
        source,
        resolved,
        value,
    }
}

fn activation(section: &Section<'_>) -> SectionActivation {
    let declared = section.declared.reasons();
    let (status, reasons) = match section.status {
        Status::Active(reason) => (
            ActivationStatus::Active,
            declared
                .iter()
                .cloned()
                .chain([reason.to_owned()])
                .collect(),
        ),
        Status::Disabled(reason) => (ActivationStatus::Disabled, vec![reason.to_owned()]),
        Status::Blocked => (
            ActivationStatus::Blocked,
            vec!["blocked_by_config_errors".to_owned()],
        ),
    };

    SectionActivation {
        enabled: status == ActivationStatus::Active,
        status,
        reasons,
    }
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
    activation: SectionActivation,
    values: Map<String, Value>,
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
    character_id: Identifier,
    #[serde(flatten)]
    entry: ConnectorEntry,
}

impl ConnectorEntry {
    /// The values in effect, while the section is active: an entry that is
    /// not runs nothing, whatever it holds.
    #[must_use]
    pub fn values(&self) -> Option<&Map<String, Value>> {
        (self.activation.status == ActivationStatus::Active).then_some(&self.values)
    }
}

impl CharacterConnectorEntry {
    #[must_use]
    pub fn character_id(&self) -> &Identifier {
        &self.character_id
    }

    #[must_use]
    pub fn entry(&self) -> &ConnectorEntry {
        &self.entry
    }
}

impl ConnectorConfigView {
    /// The connector `connector_id`'s read. A character whose own documents
    /// do not load cannot start either, and is left out.
    #[must_use]
    pub fn read(
        home: &Home,
        sections: &Sections,
        discovery: &Discovery,
        connector_id: &str,
    ) -> Self {
        let Some(connector) = connectors()
            .iter()
            .find(|connector| connector.id().as_str() == connector_id)
        else {
            let known: Vec<&str> = connectors()
                .iter()
                .map(|connector| connector.id().as_str())
                .collect();

            return Self::Refused {
                reason: ConnectorRefusal::UnknownConnector,
                message: format!(
                    "Unknown connector \"{connector_id}\". Connectors: {}.",
                    known.join(", ")
                ),
            };
        };
        let id = connector.id().as_str();
        let home_settings = match Resolution::home(home, sections) {
            Ok(resolution) => resolution,
            Err(error) => {
                return Self::Refused {
                    reason: ConnectorRefusal::ConfigUnloadable,
                    message: refusal(&error).1,
                };
            }
        };
        let characters = discovery
            .characters
            .iter()
            .filter_map(|character| {
                let resolution = Resolution::character(home, sections, character).ok()?;

                resolution
                    .settings()
                    .host()
                    .enabled
                    .then(|| CharacterConnectorEntry {
                        character_id: character.profile.id.clone(),
                        entry: connector_entry(&resolution, id),
                    })
            })
            .collect();

        Self::Ok {
            connector_id: connector.id().clone(),
            home: connector_entry(&home_settings, id),
            characters,
        }
    }
}

fn connector_entry(resolution: &Resolution<'_>, id: &str) -> ConnectorEntry {
    let section = resolution
        .section(Namespace::Connectors, id)
        .expect("a resolution holds a section of each connector this build has");
    let activation = activation(section);
    let values = if activation.status == ActivationStatus::Active {
        section
            .fields
            .iter()
            .filter_map(|field| {
                field
                    .effective
                    .value()
                    .map(|value| (field.declaration.name().to_string(), value.clone()))
            })
            .collect()
    } else {
        Map::new()
    };

    ConnectorEntry { activation, values }
}

/// The settings part of what `inspect` reports of a character: where they
/// come from and what they hold, what they make of each plugin this build
/// has and of each connector, and the findings about them, a secret only as
/// `[redacted]`. A plugin is reported from its manifest and her settings
/// alone: none is built to report it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigReport {
    runtime_config: RuntimeConfigReport,
    /// The findings about what she runs: every one but a connector's.
    activation_diagnostics: Vec<Diagnostic>,
    plugins: Vec<PluginReport>,
    connectors: Vec<ConnectorReport>,
}

/// Where the home's settings come from, the host's values in effect, a
/// secret's as `[redacted]`, and the fingerprint.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfigReport {
    /// `path` when the home's document exists, `none` when it does not.
    source: &'static str,
    path: String,
    project02: HostReport,
    fingerprint: Fingerprint,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostReport {
    store_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    character: Option<Identifier>,
    enabled: bool,
    user_display_name: SpeakerName,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_memory_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role_model_provider: Option<RoleModelProvider>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nvidia_api_key: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nvidia_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nvidia_base_url: Option<String>,
    context_window_tokens: NonZeroU64,
}

/// A plugin as `inspect` reports it: its kind, whether her settings run it
/// and why, the access its manifest asks for, which running it grants and
/// nothing else, the findings about it, and each field's value in effect.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginReport {
    plugin_id: Identifier,
    kind: PluginKind,
    enabled: bool,
    requested_access: AccessMap,
    activation_status: ActivationStatus,
    activation_reasons: Vec<String>,
    diagnostics: Vec<Diagnostic>,
    #[serde(serialize_with = "by_name")]
    config: Vec<EffectiveView>,
}

/// A connector as `inspect` reports it: its switch and activation, its
/// diagnostics, and each field's value in effect.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorReport {
    id: Identifier,
    display_name: String,
    version: String,
    enabled: bool,
    activation: SectionActivation,
    diagnostics: Vec<Diagnostic>,
    #[serde(serialize_with = "by_name")]
    config: Vec<EffectiveView>,
}

/// A section's fields by name, in the order they are declared.
fn by_name<S: Serializer>(fields: &[EffectiveView], serializer: S) -> Result<S::Ok, S::Error> {
    serializer.collect_map(fields.iter().map(|field| (&field.name, field)))
}

impl Resolution<'_> {
    /// The settings part of `inspect`'s report over these settings, the
    /// settings of `home`.
    #[must_use]
    pub fn report(&self, home: &Home) -> ConfigReport {
        let settings = self.settings();
        let host = settings.host();
        let layers = self.layers();

        ConfigReport {
            runtime_config: RuntimeConfigReport {
                source: if layers.home_present { "path" } else { "none" },
                path: layers.home_path.display().to_string(),
                project02: HostReport {
                    store_root: home.root().display().to_string(),
                    character: match self.target() {
                        Target::Home => None,
                        Target::Character(character) => Some(character.clone()),
                    },
                    enabled: host.enabled,
                    user_display_name: host.user_display_name.clone(),
                    default_memory_provider: host.default_memory_provider.clone(),
                    role_model_provider: host.role_model_provider,
                    nvidia_api_key: host.nvidia_api_key.as_ref().map(|_| "[redacted]"),
                    nvidia_model: host.nvidia_model.clone(),
                    nvidia_base_url: host
                        .nvidia_base_url
                        .as_ref()
                        .map(|base| base.as_str().to_owned()),
                    context_window_tokens: host.context_window_tokens,
                },
                fingerprint: self.fingerprint().clone(),
            },
            activation_diagnostics: self
                .diagnostics()
                .iter()
                .filter(|diagnostic| !diagnostic.about(Namespace::Connectors))
                .cloned()
                .collect(),
            plugins: self
                .sections()
                .iter()
                .filter_map(|section| match section.declared {
                    Declared::Plugin(manifest) => Some(self.plugin_report(section, manifest)),
                    Declared::Connector(_) => None,
                })
                .collect(),
            connectors: self
                .sections()
                .iter()
                .filter(|section| section.declared.namespace() == Namespace::Connectors)
                .map(|section| ConnectorReport {
                    id: section.declared.id().clone(),
                    display_name: section.declared.display_name().to_owned(),
                    version: section.declared.version().to_owned(),
                    enabled: section.enabled(),
                    activation: activation(section),
                    diagnostics: section.diagnostics.clone(),
                    config: section.fields.iter().map(effective_view).collect(),
                })
                .collect(),
        }
    }

    fn plugin_report(&self, section: &Section<'_>, manifest: &Manifest) -> PluginReport {
        let SectionActivation {
            enabled,
            status,
            reasons,
        } = activation(section);
        let id = manifest.id();

        PluginReport {
            plugin_id: id.clone(),
            kind: manifest.kind(),
            enabled,
            requested_access: manifest.requested_access().clone(),
            activation_status: status,
            activation_reasons: reasons,
            diagnostics: self
                .diagnostics()
                .iter()
                .filter(|diagnostic| diagnostic.concerns(Namespace::Plugins, id.as_str()))
                .cloned()
                .collect(),
            config: section.fields.iter().map(effective_view).collect(),
        }
    }
}
