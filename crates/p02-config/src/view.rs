//! The settings as their readers are shown them: a settings screen's view,
//! a connector's read, and the report of `inspect`. Only a connector's
//! read carries a secret, since a token is what a connector exists to use.

use std::num::{NonZeroU32, NonZeroU64};

use p02_characters::Discovery;
use p02_contracts::{AccessMap, Manifest, PluginKind};
use p02_core::SpeakerName;
use p02_shared::{Fingerprint, Identifier, error_sentence, sentence};
use p02_store::Home;
use p02_wire::{
    ActivationStatus, Authored, CharacterConnectorEntry, ConfigTarget, ConfigView,
    ConnectorConfigView, ConnectorEntry, ConnectorRefusal, Diagnostic, EffectiveView, FieldView,
    LayoutCard, Namespace, PlanAccount, RoleModelProvider, SectionActivation, SectionView,
    ValueSource, ViewRefusal,
};
use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

use crate::conceal::conceal;
use crate::declaration::{Declared, Sections, Target, connector};
use crate::host::{HostSettings, host_fields, plan_shaped, services};
use crate::resolve::{
    Effective, Field, ReadSettingsError, Resolution, Section, Status, values_in_effect,
};

/// The view of `target`'s settings, `model` judging whether the host's
/// values in effect give a character an AI model, as her start judges it,
/// and `account` the one the home is signed in to a ChatGPT plan as, if it
/// is: neither is a setting.
#[must_use]
pub fn config_view(
    home: &Home,
    sections: &Sections,
    discovery: &Discovery,
    target: &ConfigTarget,
    model: impl FnOnce(&HostSettings) -> Result<(), String>,
    account: Option<&PlanAccount>,
) -> ConfigView {
    match Resolution::read(home, sections, discovery, target) {
        Ok(resolution) => resolution.view(model, account),
        Err(error) => {
            let (reason, message) = refusal(&error);

            ConfigView::Refused { reason, message }
        }
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
    /// The view of these settings: whether their host values give a
    /// character a model, as `model` judges them, every service and which
    /// are connected, the ChatGPT plan's while the home is signed in, as
    /// `account`, and every host field, and every section, and of each
    /// section every field, that the target may set; secrets never. A
    /// person looks a section up by its name, so the screen lists the
    /// plugins' by id and then the connectors'.
    #[must_use]
    pub fn view(
        &self,
        model: impl FnOnce(&HostSettings) -> Result<(), String>,
        account: Option<&PlanAccount>,
    ) -> ConfigView {
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
            model: model(&HostSettings::of(self.host())).into(),
            services: services(self.host(), account),
            project02: host_fields()
                .iter()
                .zip(self.host())
                .filter(|(declared, _)| self.target().authors(declared.scope()))
                .map(|(_, field)| plan_shaped(field_view(field), account))
                .collect(),
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
        let declared = section.declared;

        target.authors(declared.config().scope()).then(|| {
            let fields: Vec<FieldView> = section
                .fields
                .iter()
                .filter(|field| target.authors(declared.scope_of(field.declaration)))
                .map(field_view)
                .collect();

            SectionView {
                namespace: declared.namespace(),
                id: declared.id().clone(),
                display_name: declared.display_name().to_owned(),
                version: declared.version().to_owned(),
                page: declared.page().cloned(),
                access: declared.access().map(|access| access.levels().clone()),
                enabled: section.enabled(),
                enabled_source: section.switch.source(),
                activation: activation(section),
                setup: section.setup.clone().into(),
                layout: layout(declared.config().layout(), &fields),
                fields,
                diagnostics: section.diagnostics.clone(),
            }
        })
    }
}

/// The cards of a section's layout with the rows of `fields`, those a view
/// lists; a card left without rows is not one of the view's.
fn layout(cards: &[LayoutCard], fields: &[FieldView]) -> Vec<LayoutCard> {
    cards
        .iter()
        .filter_map(|card| {
            let rows: Vec<_> = card
                .rows
                .iter()
                .filter(|row| fields.iter().any(|field| field.name == row.field))
                .cloned()
                .collect();

            (!rows.is_empty()).then(|| LayoutCard {
                title: card.title.clone(),
                footer: card.footer.clone(),
                advanced: card.advanced,
                when: card.when.clone(),
                rows,
            })
        })
        .collect()
}

fn field_view(field: &Field<'_>) -> FieldView {
    let declaration = field.declaration;
    let name = declaration.name().as_str();
    let secret = declaration.secret();

    FieldView {
        name: declaration.name().clone(),
        label: declaration.label().map(str::to_owned),
        description: declaration.description().to_owned(),
        placeholder: declaration.placeholder().map(str::to_owned),
        secret,
        value_type: declaration.value_type(),
        allowed_values: declaration.allowed_values().map(<[String]>::to_vec),
        suggested_values: declaration.suggested_values().map(<[String]>::to_vec),
        choices: declaration.choices().cloned(),
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
        Status::NotSetUp => (ActivationStatus::Disabled, vec!["not_set_up".to_owned()]),
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

/// The connector `connector_id`'s read. A character whose own documents do
/// not load cannot start either, and is left out.
#[must_use]
pub fn connector_config_view(
    home: &Home,
    sections: &Sections,
    discovery: &Discovery,
    connector_id: &str,
) -> ConnectorConfigView {
    let connector = match connector(connector_id) {
        Ok(connector) => connector,
        Err(unknown) => {
            return ConnectorConfigView::Refused {
                reason: ConnectorRefusal::UnknownConnector,
                message: unknown.to_string(),
            };
        }
    };
    let id = connector.id().as_str();
    let home_settings = match Resolution::home(home, sections) {
        Ok(resolution) => resolution,
        Err(error) => {
            return ConnectorConfigView::Refused {
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

    ConnectorConfigView::Ok {
        connector_id: connector.id().clone(),
        home: connector_entry(&home_settings, id),
        characters,
    }
}

fn connector_entry(resolution: &Resolution<'_>, id: &str) -> ConnectorEntry {
    let section = resolution
        .section(Namespace::Connectors, id)
        .expect("a resolution holds a section of each connector this build has");
    let activation = activation(section);
    let values = if activation.status == ActivationStatus::Active {
        values_in_effect(&section.fields)
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
    role_model_provider: Option<RoleModelProvider>,
    /// Absent until one is set: the plan's first is the sign-in's to say.
    #[serde(skip_serializing_if = "Option::is_none")]
    chatgpt_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    openai_api_key: Option<&'static str>,
    openai_model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    anthropic_api_key: Option<&'static str>,
    anthropic_model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    nvidia_api_key: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nvidia_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nvidia_base_url: Option<String>,
    context_window_tokens: NonZeroU64,
    /// Absent while her heartbeat is off.
    #[serde(skip_serializing_if = "Option::is_none")]
    heartbeat_minutes: Option<NonZeroU32>,
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
                    role_model_provider: host.role_model_provider,
                    chatgpt_model: host.chatgpt_model.clone(),
                    openai_api_key: host.openai_api_key.as_ref().map(|_| "[redacted]"),
                    openai_model: host.openai_model.clone(),
                    anthropic_api_key: host.anthropic_api_key.as_ref().map(|_| "[redacted]"),
                    anthropic_model: host.anthropic_model.clone(),
                    nvidia_api_key: host.nvidia_api_key.as_ref().map(|_| "[redacted]"),
                    nvidia_model: host.nvidia_model.clone(),
                    nvidia_base_url: host
                        .nvidia_base_url
                        .as_ref()
                        .map(|base| base.as_str().to_owned()),
                    context_window_tokens: host.context_window_tokens,
                    heartbeat_minutes: host.heartbeat,
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
                    Declared::Plugin(manifest, _) => Some(self.plugin_report(section, manifest)),
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
