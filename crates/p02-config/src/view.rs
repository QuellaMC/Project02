//! The settings as their readers are shown them: a settings screen's view,
//! a connector's read, and the report of `inspect`. Only a connector's
//! read carries a secret, since a token is what a connector exists to use.

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;
use std::num::NonZeroU64;

use p02_characters::Discovery;
use p02_contracts::ConfigValueType;
use p02_core::SpeakerName;
use p02_shared::{Fingerprint, Identifier};
use p02_store::Home;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::change::ConfigTarget;
use crate::conceal::conceal;
use crate::declaration::{Namespace, RoleModelProvider, Sections, Source, Target, connectors};
use crate::diagnostic::Diagnostic;
use crate::resolve::{Effective, Field, ReadSettingsError, Resolution, Section, Status};

/// What a settings screen renders: the fingerprint a change must present,
/// the diagnostics, and the host's fields and every section the target may
/// set, all in one field shape. A target whose settings cannot be resolved
/// is refused with the reason, never shown as blank fields.
#[derive(Debug, Serialize)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewRefusal {
    UnknownCharacter,
    ConfigUnloadable,
}

/// One field as a screen shows it: its declaration, what the target's own
/// document holds for it, and the value in effect with where it comes
/// from, a secret's as `[redacted]`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[expect(
    clippy::struct_excessive_bools,
    reason = "each flag is one key of the field's shape on the wire"
)]
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
    reload_required: bool,
    authored: Authored,
    effective_source: Source,
    effective: EffectiveView,
}

/// What the target's own document holds for a field.
#[derive(Debug, Serialize)]
pub struct Authored {
    configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
}

/// The value in effect: authored in a document, `config`; the declared
/// default, `default`; or none, `missing`. A refused value is in effect
/// unresolved, its value shown unless it is a secret's.
#[derive(Debug, Serialize)]
pub struct EffectiveView {
    name: Identifier,
    secret: bool,
    source: ValueSource,
    resolved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueSource {
    Config,
    Default,
    Missing,
}

/// One section as a screen shows it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
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
    /// What a change to this section alone may present.
    fingerprint: Fingerprint,
}

/// Whether a section runs, as its settings decide it, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SectionActivation {
    enabled: bool,
    status: ActivationStatus,
    reasons: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
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
        ReadSettingsError::Storage(_) | ReadSettingsError::Unloadable { .. } => {
            ViewRefusal::ConfigUnloadable
        }
    };

    (reason, error.sentence())
}

impl ReadSettingsError {
    /// What keeps the settings from being read, as the sentence a person
    /// is shown: the first thing keeping a document from loading, which
    /// never repeats a value.
    #[must_use]
    pub fn sentence(&self) -> String {
        match self {
            Self::UnknownCharacter(reason) => sentence(reason),
            Self::Storage(error) => sentence(&chain(error)),
            Self::Unloadable { diagnostics } => diagnostics
                .first()
                .map(|diagnostic| diagnostic.message().to_owned())
                .unwrap_or_default(),
        }
    }
}

impl Resolution<'_> {
    /// The view of these settings: every host field, and every section,
    /// and of each section every field, that the target may set; secrets
    /// never.
    #[must_use]
    pub fn view(&self) -> ConfigView {
        ConfigView::Ok {
            fingerprint: self.fingerprint().clone(),
            diagnostics: self.diagnostics().to_vec(),
            project02: self.host().iter().map(field_view).collect(),
            sections: self
                .sections()
                .iter()
                .filter_map(|section| self.section_shown(section))
                .collect(),
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
                fingerprint: section.fingerprint.clone(),
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
        reload_required: declaration.reload_required(),
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
        Effective::Missing => (ValueSource::Missing, !field.required, None),
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
#[derive(Debug, Serialize)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorRefusal {
    UnknownConnector,
    ConfigUnloadable,
}

/// A connector's section for one target: its activation, and each field
/// that has a value it takes for that target, the home's fields reaching
/// every character's entry.
#[derive(Serialize)]
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterConnectorEntry {
    character_id: Identifier,
    #[serde(flatten)]
    entry: ConnectorEntry,
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

/// The settings part of what `inspect` reports of a character.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigReport {
    runtime_config: RuntimeConfigReport,
    connectors: Vec<ConnectorReport>,
}

/// Where the home's settings come from, the host's values in effect, a
/// secret's as `[redacted]`, the diagnostics, and the fingerprint.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfigReport {
    /// `path` when the home's document exists, `none` when it does not.
    source: &'static str,
    path: String,
    project02: HostReport,
    diagnostics: Vec<Diagnostic>,
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

/// A connector as `inspect` reports it: its switch and activation, its
/// diagnostics, and each field resolved, secrets redacted.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorReport {
    id: Identifier,
    display_name: String,
    version: String,
    enabled: bool,
    activation: SectionActivation,
    diagnostics: Vec<Diagnostic>,
    config: BTreeMap<String, EffectiveView>,
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
                diagnostics: self.diagnostics().to_vec(),
                fingerprint: self.fingerprint().clone(),
            },
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
                    config: section
                        .fields
                        .iter()
                        .map(|field| (field.declaration.name().to_string(), effective_view(field)))
                        .collect(),
                })
                .collect(),
        }
    }
}

/// `fragment`, an error's lowercase words, as a sentence a person reads.
pub(crate) fn sentence(fragment: &str) -> String {
    let mut characters = fragment.chars();
    let mut sentence: String = characters
        .next()
        .map(|first| first.to_uppercase().chain(characters).collect())
        .unwrap_or_default();

    if !sentence.ends_with(['.', '!', '?']) {
        sentence.push('.');
    }

    sentence
}

/// `error` and each error beneath it, as one fragment.
pub(crate) fn chain(error: &dyn Error) -> String {
    let mut words = error.to_string();
    let mut source = error.source();

    while let Some(cause) = source {
        words.push_str(": ");
        words.push_str(&cause.to_string());
        source = cause.source();
    }

    words
}
