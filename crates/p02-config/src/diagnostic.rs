//! What the settings say of themselves: a finding, at the place it
//! concerns.

use std::path::Path;

use p02_contracts::vocabulary;
use p02_shared::Identifier;
use schemars::JsonSchema;
use serde::Serialize;
use ts_rs::TS;

use crate::declaration::Namespace;

/// How much a finding weighs: an error stops what it concerns, a warning
/// only says so.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Warning,
    Error,
}

vocabulary! {
    /// What a finding is, in the one spelling clients read.
    Code {
        ReadFailed = "runtime_config_read_failed",
        MalformedJson = "runtime_config_malformed_json",
        NotObject = "runtime_config_not_object",
        LimitExceeded = "runtime_config_limit_exceeded",
        VersionUnsupported = "runtime_config_version_unsupported",
        UnknownTopLevelField = "runtime_config_unknown_top_level_field",
        Project02NotObject = "runtime_config_project02_not_object",
        UnknownProject02Field = "runtime_config_unknown_project02_field",
        PluginsNotObject = "runtime_config_plugins_not_object",
        ConnectorsNotObject = "runtime_config_connectors_not_object",
        UnknownPlugin = "runtime_config_unknown_plugin",
        UnknownConnector = "runtime_config_unknown_connector",
        PluginNotObject = "runtime_config_plugin_not_object",
        UnknownPluginWrapperField = "runtime_config_unknown_plugin_wrapper_field",
        BooleanInvalid = "runtime_config_boolean_invalid",
        PluginConfigNotObject = "runtime_config_plugin_config_not_object",
        UnknownPluginConfigField = "runtime_config_unknown_plugin_config_field",
        StringInvalid = "runtime_config_string_invalid",
        RoleModelProviderInvalid = "runtime_config_role_model_provider_invalid",
        SecretValueInvalid = "runtime_config_secret_value_invalid",
        NvidiaBaseUrlInvalid = "runtime_config_nvidia_base_url_invalid",
        ContextWindowTokensInvalid = "runtime_config_context_window_tokens_invalid",
        ValueTypeInvalid = "runtime_config_value_type_invalid",
        RequiredValueMissing = "runtime_config_required_value_missing",
        RequiredSecretMissing = "runtime_config_required_secret_missing",
        AuthoredOutsideScope = "runtime_config_authored_outside_scope",
        CharacterPackagePluginConfigInvalid = "character_package_plugin_config_invalid",
        DefaultMemoryProviderUnavailable = "default_memory_provider_unavailable",
        DefaultMemoryProviderNotMemoryProvider = "default_memory_provider_not_memory_provider",
        AmbiguousMemoryProviderSelection = "ambiguous_memory_provider_selection",
        CharacterRequiredPluginMissing = "character_required_plugin_missing",
        CharacterRequiredPluginDisabled = "character_required_plugin_disabled",
        CharacterRecommendedPluginMissing = "character_recommended_plugin_missing",
        CharacterRecommendedPluginDisabled = "character_recommended_plugin_disabled",
    }
}

/// A finding about the settings: its weight, its code, a sentence for a
/// person that never repeats a value, the place in the document, what it
/// concerns, the settings as a whole or one section, and, for a finding in
/// a character's overlay, whose.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "RuntimeConfigDiagnostic", optional_fields)]
#[schemars(rename = "RuntimeConfigDiagnostic")]
pub struct Diagnostic {
    severity: Severity,
    code: Code,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(flatten)]
    concerns: Concerns,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<Origin>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(tag = "scope", rename_all = "snake_case")]
#[ts(optional_fields)]
enum Concerns {
    Global,
    Section {
        namespace: Namespace,
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        field: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(tag = "scope", rename_all = "snake_case")]
enum Origin {
    Character {
        #[serde(rename = "characterId")]
        character_id: Identifier,
        path: String,
    },
}

impl Diagnostic {
    pub(crate) fn error(code: Code, message: impl Into<String>) -> Self {
        Self::new(Severity::Error, code, message.into())
    }

    pub(crate) fn warning(code: Code, message: impl Into<String>) -> Self {
        Self::new(Severity::Warning, code, message.into())
    }

    fn new(severity: Severity, code: Code, message: String) -> Self {
        Self {
            severity,
            code,
            message,
            path: None,
            concerns: Concerns::Global,
            origin: None,
        }
    }

    pub(crate) fn at(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub(crate) fn in_section(mut self, namespace: Namespace, id: &str) -> Self {
        self.concerns = Concerns::Section {
            namespace,
            id: id.to_owned(),
            field: None,
        };
        self
    }

    pub(crate) fn on_field(mut self, namespace: Namespace, id: &str, field: &str) -> Self {
        self.concerns = Concerns::Section {
            namespace,
            id: id.to_owned(),
            field: Some(field.to_owned()),
        };
        self
    }

    /// The finding as made in `character`'s overlay at `path`.
    pub(crate) fn in_overlay(mut self, character: &Identifier, path: &Path) -> Self {
        self.origin = Some(Origin::Character {
            character_id: character.clone(),
            path: path.display().to_string(),
        });
        self
    }

    #[must_use]
    pub fn severity(&self) -> Severity {
        self.severity
    }

    #[must_use]
    pub fn code(&self) -> Code {
        self.code
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// The place in the document, as `plugins.mem0.config.apiKey`.
    #[must_use]
    pub fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    /// The character whose overlay holds what it found; `None` for the
    /// home's document.
    #[must_use]
    pub fn character(&self) -> Option<&Identifier> {
        self.origin
            .as_ref()
            .map(|Origin::Character { character_id, .. }| character_id)
    }

    pub(crate) fn is_error(&self) -> bool {
        self.severity == Severity::Error
    }

    /// Whether the finding stops the character whose settings hold it: an
    /// error about anything she runs, which a connector, a process of its
    /// own, is not.
    pub(crate) fn stops_character(&self) -> bool {
        self.is_error() && !self.about_connector()
    }

    /// Whether the finding concerns a connector's section.
    pub(crate) fn about_connector(&self) -> bool {
        matches!(
            self.concerns,
            Concerns::Section {
                namespace: Namespace::Connectors,
                ..
            }
        )
    }

    /// Whether the finding concerns the section `id` of `namespace`.
    #[must_use]
    pub fn concerns(&self, namespace: Namespace, id: &str) -> bool {
        matches!(
            &self.concerns,
            Concerns::Section { namespace: found, id: concerned, .. }
                if *found == namespace && concerned == id
        )
    }
}
