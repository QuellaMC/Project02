//! What the settings say of themselves: a finding, at the place it
//! concerns.

use std::path::Path;

use p02_shared::{Identifier, vocabulary};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::config::Namespace;

/// How much a finding weighs: an error stops what it concerns, a warning
/// only says so.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Warning,
    Error,
}

vocabulary! {
    /// What a finding is, in the one spelling clients read.
    Code {
        /// A document that cannot be read, is not JSON, or is no object.
        Unreadable = "runtime_config_unreadable",
        /// A key the settings do not know, or a namespace that is no
        /// object: not used.
        Ignored = "runtime_config_ignored",
        UnknownPlugin = "runtime_config_unknown_plugin",
        UnknownConnector = "runtime_config_unknown_connector",
        /// A value its field does not take: not used, and nothing stands in
        /// for it.
        ValueInvalid = "runtime_config_value_invalid",
        AuthoredOutsideScope = "runtime_config_authored_outside_scope",
        /// A value her package gives that a package may not set.
        PackageValueSkipped = "character_package_value_skipped",
        /// A plugin her package expects that she does not run.
        PluginNotRunning = "character_plugin_not_running",
    }
}

/// A finding about the settings: its weight, its code, a sentence for a
/// person that never repeats a value, the place in the document, what it
/// concerns, the settings as a whole or one section, and, for a finding in
/// a character's overlay, whose.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "scope", rename_all = "snake_case")]
enum Origin {
    Character {
        #[serde(rename = "characterId")]
        character_id: Identifier,
        path: String,
    },
}

impl Diagnostic {
    #[must_use]
    pub fn error(code: Code, message: impl Into<String>) -> Self {
        Self::new(Severity::Error, code, message.into())
    }

    #[must_use]
    pub fn warning(code: Code, message: impl Into<String>) -> Self {
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

    #[must_use]
    pub fn at(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    #[must_use]
    pub fn in_section(mut self, namespace: Namespace, id: &str) -> Self {
        self.concerns = Concerns::Section {
            namespace,
            id: id.to_owned(),
            field: None,
        };
        self
    }

    #[must_use]
    pub fn on_field(mut self, namespace: Namespace, id: &str, field: &str) -> Self {
        self.concerns = Concerns::Section {
            namespace,
            id: id.to_owned(),
            field: Some(field.to_owned()),
        };
        self
    }

    /// The finding as made in `character`'s overlay at `path`.
    #[must_use]
    pub fn in_overlay(mut self, character: &Identifier, path: &Path) -> Self {
        self.origin = Some(Origin::Character {
            character_id: character.clone(),
            path: path.display().to_string(),
        });
        self
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

    #[must_use]
    pub fn is_error(&self) -> bool {
        self.severity == Severity::Error
    }

    /// Whether the finding stops the character whose settings hold it: an
    /// error about her settings as a whole. One about a section blocks that
    /// section alone.
    #[must_use]
    pub fn stops_character(&self) -> bool {
        self.is_error() && matches!(self.concerns, Concerns::Global)
    }

    /// Whether the finding concerns a section of `namespace`.
    #[must_use]
    pub fn about(&self, namespace: Namespace) -> bool {
        matches!(
            &self.concerns,
            Concerns::Section { namespace: found, .. } if *found == namespace
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
