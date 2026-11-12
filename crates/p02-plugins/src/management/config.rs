//! `runtime.plugin.config` and `runtime.plugin.config.update`: one plugin's
//! settings as the character's settings screen shows them, and a change of
//! one field of them, prepared against the fingerprint the model read and
//! made only on the person's yes, in her own settings, which she runs on
//! from her next request.

use std::sync::Arc;

use async_trait::async_trait;
use p02_contracts::{
    ConfigField, EvidenceKind, EvidenceNote, EvidenceStatus, HookContext, Manifest, PluginError,
    PreparedEffect, ToolCall, ToolCallOutcome, ToolPreparation,
};
use p02_shared::{Identifier, error_chain};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::config_control::{ConfigControl, FieldChange, FieldChangeOutcome, PluginSettings};
use crate::package::{admitted, blocking, rejected, unasked};

const UNKNOWN_PLUGIN: &str = "plugin_config_unknown_plugin";
const UPDATE_INVALID: &str = "plugin_config_update_invalid";
const CONFLICT: &str = "plugin_config_fingerprint_conflict";
const UPDATE_FAILED: &str = "plugin_config_update_failed";

const CONFLICT_SENTENCE: &str = "Plugin config changed after it was inspected. Inspect it again \
     with runtime.plugin.config, then ask for the change.";

/// What a client shown the person a change's preview reads it as.
const PREVIEW_KIND: &str = "runtime_plugin_config_change";

pub(super) async fn inspect(
    control: Arc<dyn ConfigControl>,
    call: &ToolCall,
) -> Result<ToolCallOutcome, PluginError> {
    let Inspected { plugin_id } = admitted(call)?;
    let Some(manifest) = installed(&plugin_id)? else {
        let message = unknown(&plugin_id);

        return Ok(rejected(UNKNOWN_PLUGIN, message.clone(), &message));
    };
    let plugin = manifest.id().clone();
    let settings = settings(control, plugin.clone()).await?;

    Ok(ToolCallOutcome::Accepted {
        output: Value::Object(shown(settings)),
        evidence: vec![accepted(format!(
            "Inspected the settings of plugin \"{plugin}\"."
        ))],
    })
}

pub(super) async fn prepare(
    control: Arc<dyn ConfigControl>,
    call: &ToolCall,
) -> Result<ToolPreparation, PluginError> {
    let request = match Request::of(call)? {
        Ok(request) => request,
        Err(refusal) => return Ok(refusal.unasked()),
    };
    let settings = settings(Arc::clone(&control), request.plugin.clone()).await?;

    if let Some(error) = first_error(&settings.section) {
        return Ok(Refusal::invalid(format!(
            "Plugin config cannot be updated while its current settings are invalid: {error}"
        ))
        .unasked());
    }

    if settings.fingerprint.as_str() != request.expected_fingerprint {
        return Ok(Refusal {
            reason: CONFLICT,
            message: CONFLICT_SENTENCE.to_owned(),
        }
        .unasked());
    }

    let change = request.change();

    // The person is asked only about a change her settings would take.
    if let Err(message) = blocking({
        let control = Arc::clone(&control);

        move || control.check(&change)
    })
    .await?
    {
        return Ok(Refusal::invalid(message).unasked());
    }

    let field = request.field.name();
    let before = authored(&settings.section, field.as_str())
        .cloned()
        .unwrap_or_else(|| json!({"configured": false}));
    let after = match &request.value {
        Some(value) => json!({"configured": true, "value": value}),
        None => json!({"configured": false}),
    };
    let summary = format!(
        "Prepared a change of plugin \"{}\" field \"{field}\" for approval.",
        request.plugin
    );

    Ok(ToolPreparation::Prepared {
        preview: Map::from_iter([
            ("kind".to_owned(), Value::from(PREVIEW_KIND)),
            (
                "targetPluginId".to_owned(),
                Value::from(request.plugin.as_str()),
            ),
            ("fieldName".to_owned(), Value::from(field.as_str())),
            ("operation".to_owned(), Value::from(request.operation())),
            (
                "expectedFingerprint".to_owned(),
                Value::from(request.expected_fingerprint.as_str()),
            ),
            ("before".to_owned(), before),
            ("after".to_owned(), after),
        ]),
        effect: Box::new(Change { control, request }),
        evidence: vec![accepted(summary)],
    })
}

/// A change the model asked for, its own rules met: a field of an
/// installed plugin the model may change, and a value it takes.
#[derive(Debug)]
struct Request {
    plugin: Identifier,
    field: ConfigField,
    value: Option<Value>,
    expected_fingerprint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Inspected {
    plugin_id: String,
}

/// An update's input but its `value`, which is read apart, since a set of
/// `null` is a set.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Asked {
    plugin_id: String,
    field_name: String,
    operation: Kind,
    expected_fingerprint: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Set,
    Unset,
}

/// Why a change is refused unasked, as the model is told.
struct Refusal {
    reason: &'static str,
    message: String,
}

impl Refusal {
    fn invalid(message: String) -> Self {
        Self {
            reason: UPDATE_INVALID,
            message,
        }
    }

    /// The change refused before anyone was asked.
    fn unasked(self) -> ToolPreparation {
        unasked(self.reason, self.message.clone(), &self.message)
    }
}

impl Request {
    fn of(call: &ToolCall) -> Result<Result<Self, Refusal>, PluginError> {
        let asked: Asked = admitted(call)?;
        let value = call.input().get("value");
        let Some(manifest) = installed(&asked.plugin_id)? else {
            return Ok(Err(Refusal {
                reason: UNKNOWN_PLUGIN,
                message: unknown(&asked.plugin_id),
            }));
        };
        let value = match (asked.operation, value) {
            (Kind::Set, Some(value)) => Some(value.clone()),
            (Kind::Set, None) => {
                return Ok(Err(Refusal::invalid(
                    "Plugin config set input must include value.".to_owned(),
                )));
            }
            (Kind::Unset, None) => None,
            (Kind::Unset, Some(_)) => {
                return Ok(Err(Refusal::invalid(
                    "Plugin config unset input must not include value.".to_owned(),
                )));
            }
        };
        let plugin = manifest.id();
        let name = &asked.field_name;
        let Some(field) = manifest.config().field(name) else {
            return Ok(Err(Refusal::invalid(format!(
                "Plugin \"{plugin}\" declares no config field \"{name}\"."
            ))));
        };
        let refusal = if field.secret() {
            Some(format!(
                "Plugin config field \"{name}\" is secret; only its operator may change it."
            ))
        } else if !field.agent_mutable() {
            Some(format!(
                "Plugin config field \"{name}\" is not one you may change."
            ))
        } else {
            None
        };

        Ok(match refusal {
            Some(message) => Err(Refusal::invalid(message)),
            None => Ok(Self {
                plugin: plugin.clone(),
                field: field.clone(),
                value,
                expected_fingerprint: asked.expected_fingerprint,
            }),
        })
    }

    fn operation(&self) -> &'static str {
        if self.value.is_some() { "set" } else { "unset" }
    }

    /// The change of her settings this request asks for.
    fn change(&self) -> FieldChange {
        FieldChange {
            plugin: self.plugin.clone(),
            field: self.field.name().clone(),
            value: self.value.clone(),
            expected_fingerprint: self.expected_fingerprint.clone(),
        }
    }

    /// Writes the change.
    fn apply(self, control: &dyn ConfigControl) -> ToolCallOutcome {
        let fingerprint = match control.change(&self.change()) {
            FieldChangeOutcome::Applied { fingerprint } => fingerprint,
            FieldChangeOutcome::Conflict => {
                return rejected(CONFLICT, CONFLICT_SENTENCE.to_owned(), CONFLICT_SENTENCE);
            }
            FieldChangeOutcome::Refused { message } => {
                return rejected(UPDATE_INVALID, message.clone(), &message);
            }
            FieldChangeOutcome::Failed { message } => {
                return rejected(UPDATE_FAILED, message.clone(), &message);
            }
        };

        ToolCallOutcome::Accepted {
            output: json!({
                "status": "applied",
                "pluginId": self.plugin.as_str(),
                "fieldName": self.field.name().as_str(),
                "operation": self.operation(),
                "fingerprint": fingerprint.as_str(),
            }),
            evidence: vec![accepted(format!(
                "Changed plugin \"{}\" field \"{}\".",
                self.plugin,
                self.field.name()
            ))],
        }
    }
}

/// A change the person approved, made in her settings.
#[derive(Debug)]
struct Change {
    control: Arc<dyn ConfigControl>,
    request: Request,
}

#[async_trait]
impl PreparedEffect for Change {
    async fn apply(
        self: Box<Self>,
        _context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        let Self { control, request } = *self;

        blocking(move || request.apply(control.as_ref())).await
    }
}

/// Plugin `plugin`'s settings, read on the blocking pool.
async fn settings(
    control: Arc<dyn ConfigControl>,
    plugin: Identifier,
) -> Result<PluginSettings, PluginError> {
    Ok(blocking(move || control.inspect(&plugin)).await??)
}

/// The plugin this build has under the id `text`.
fn installed(text: &str) -> Result<Option<&'static Manifest>, PluginError> {
    Ok(crate::list::plugins()
        .map_err(|error| PluginError::new(error_chain(error)))?
        .iter()
        .map(|(manifest, ..)| manifest)
        .find(|manifest| manifest.id().as_str() == text))
}

/// The settings as the model reads them: under the fingerprint a change
/// presents, and each `secret` flag named `sensitive`, since the output
/// boundary redacts whatever a credential-named key holds, a flag too.
fn shown(settings: PluginSettings) -> Map<String, Value> {
    let PluginSettings {
        fingerprint,
        section,
    } = settings;
    let mut shown: Map<String, Value> = section
        .into_iter()
        .map(|(key, value)| match (key.as_str(), value) {
            ("fields", Value::Array(fields)) => (
                key,
                Value::Array(fields.into_iter().map(sensitive).collect()),
            ),
            (_, value) => (key, value),
        })
        .collect();

    shown.insert("fingerprint".to_owned(), Value::from(fingerprint.as_str()));
    shown
}

fn sensitive(view: Value) -> Value {
    match view {
        Value::Object(entries) => Value::Object(
            entries
                .into_iter()
                .map(|(key, value)| match key.as_str() {
                    "secret" => ("sensitive".to_owned(), value),
                    "effective" => (key, sensitive(value)),
                    _ => (key, value),
                })
                .collect(),
        ),
        view => view,
    }
}

/// The sentence of the first error among the section's findings.
fn first_error(section: &Map<String, Value>) -> Option<&str> {
    section
        .get("diagnostics")?
        .as_array()?
        .iter()
        .find(|finding| finding.get("severity").and_then(Value::as_str) == Some("error"))?
        .get("message")?
        .as_str()
}

/// What her own settings hold for field `name`, as the section shows it.
fn authored<'a>(section: &'a Map<String, Value>, name: &str) -> Option<&'a Value> {
    section
        .get("fields")?
        .as_array()?
        .iter()
        .find(|field| field.get("name").and_then(Value::as_str) == Some(name))?
        .get("authored")
}

fn unknown(plugin: &str) -> String {
    format!("Plugin \"{plugin}\" is not installed.")
}

fn accepted(summary: String) -> EvidenceNote {
    EvidenceNote::new(
        EvidenceKind::ToolInvocation,
        EvidenceStatus::Accepted,
        summary,
    )
}
