//! What the settings say of themselves: a finding, at the place it
//! concerns.

use std::path::Path;

use p02_shared::Identifier;
use serde::{Serialize, Serializer};

use crate::declaration::Namespace;

/// How much a finding weighs: an error stops what it concerns, a warning
/// only says so.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Warning,
    Error,
}

/// What a finding is, in the one spelling clients read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Code {
    ReadFailed,
    MalformedJson,
    NotObject,
    LimitExceeded,
    VersionUnsupported,
    UnknownTopLevelField,
    Project02NotObject,
    UnknownProject02Field,
    PluginsNotObject,
    ConnectorsNotObject,
    UnknownPlugin,
    UnknownConnector,
    PluginNotObject,
    UnknownPluginWrapperField,
    BooleanInvalid,
    PluginConfigNotObject,
    UnknownPluginConfigField,
    StringInvalid,
    RoleModelProviderInvalid,
    SecretValueInvalid,
    NvidiaBaseUrlInvalid,
    ContextWindowTokensInvalid,
    ValueTypeInvalid,
    RequiredValueMissing,
    RequiredSecretMissing,
    AuthoredOutsideScope,
    CharacterPackagePluginConfigInvalid,
}

impl Code {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ReadFailed => "runtime_config_read_failed",
            Self::MalformedJson => "runtime_config_malformed_json",
            Self::NotObject => "runtime_config_not_object",
            Self::LimitExceeded => "runtime_config_limit_exceeded",
            Self::VersionUnsupported => "runtime_config_version_unsupported",
            Self::UnknownTopLevelField => "runtime_config_unknown_top_level_field",
            Self::Project02NotObject => "runtime_config_project02_not_object",
            Self::UnknownProject02Field => "runtime_config_unknown_project02_field",
            Self::PluginsNotObject => "runtime_config_plugins_not_object",
            Self::ConnectorsNotObject => "runtime_config_connectors_not_object",
            Self::UnknownPlugin => "runtime_config_unknown_plugin",
            Self::UnknownConnector => "runtime_config_unknown_connector",
            Self::PluginNotObject => "runtime_config_plugin_not_object",
            Self::UnknownPluginWrapperField => "runtime_config_unknown_plugin_wrapper_field",
            Self::BooleanInvalid => "runtime_config_boolean_invalid",
            Self::PluginConfigNotObject => "runtime_config_plugin_config_not_object",
            Self::UnknownPluginConfigField => "runtime_config_unknown_plugin_config_field",
            Self::StringInvalid => "runtime_config_string_invalid",
            Self::RoleModelProviderInvalid => "runtime_config_role_model_provider_invalid",
            Self::SecretValueInvalid => "runtime_config_secret_value_invalid",
            Self::NvidiaBaseUrlInvalid => "runtime_config_nvidia_base_url_invalid",
            Self::ContextWindowTokensInvalid => "runtime_config_context_window_tokens_invalid",
            Self::ValueTypeInvalid => "runtime_config_value_type_invalid",
            Self::RequiredValueMissing => "runtime_config_required_value_missing",
            Self::RequiredSecretMissing => "runtime_config_required_secret_missing",
            Self::AuthoredOutsideScope => "runtime_config_authored_outside_scope",
            Self::CharacterPackagePluginConfigInvalid => "character_package_plugin_config_invalid",
        }
    }
}

impl Serialize for Code {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// A finding about the settings: its weight, its code, a sentence for a
/// person that never repeats a value, the place in the document, what it
/// concerns, the settings as a whole or one section, and, for a finding in
/// a character's overlay, whose.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
enum Concerns {
    Global,
    Section {
        namespace: Namespace,
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        field: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
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
