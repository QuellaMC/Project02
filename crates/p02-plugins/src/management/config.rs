//! `runtime.plugin.config` and `runtime.plugin.config.update`: one plugin's
//! settings as the character's settings screen shows them, and a change of
//! one field of them, prepared against the fingerprint the model read and
//! made only on the person's yes, in her own settings.

use std::sync::Arc;

use async_trait::async_trait;
use p02_contracts::{
    ConfigField, ConfigValueType, EvidenceKind, EvidenceNote, EvidenceStatus, HookContext,
    Manifest, PluginError, PreparedEffect, ToolCall, ToolCallOutcome, ToolPreparation,
};
use p02_shared::{Identifier, is_credential_key, redact_credentials};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use crate::boundary::described;
use crate::config_control::{
    ConfigControl, FieldChange, FieldChangeOutcome, PluginSettings, Rebuild,
};
use crate::host::HostLink;
use crate::package::{blocking, rejected};

const INSPECT_INVALID: &str = "plugin_config_inspect_invalid";
const UNKNOWN_PLUGIN: &str = "plugin_config_unknown_plugin";
const UPDATE_INVALID: &str = "plugin_config_update_invalid";
const CONFLICT: &str = "plugin_config_fingerprint_conflict";
const UPDATE_FAILED: &str = "plugin_config_update_failed";

const CONFLICT_SENTENCE: &str = "Plugin config changed after it was inspected. Inspect it again \
     with runtime.plugin.config, then ask for the change.";

/// What a client shown the person a change's preview reads it as.
const PREVIEW_KIND: &str = "runtime_plugin_config_change";

/// What a reader of the settings is shown in place of a concealed value,
/// which the model must not write back as one.
const REDACTED: &str = "[redacted]";

pub(super) async fn inspect(
    control: Arc<dyn ConfigControl>,
    call: &ToolCall,
) -> Result<ToolCallOutcome, PluginError> {
    let Inspected { plugin_id } = admitted(call)?;

    if plugin_id.trim().is_empty() {
        let message = blank("pluginId");

        return Ok(rejected(INSPECT_INVALID, message.clone(), &message));
    }

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
    host: HostLink,
    call: &ToolCall,
) -> Result<ToolPreparation, PluginError> {
    let request = match Request::of(call)? {
        Ok(request) => request,
        Err(refusal) => return Ok(unasked(refusal)),
    };
    let settings = settings(Arc::clone(&control), request.plugin.clone()).await?;

    if let Some(error) = first_error(&settings.section) {
        return Ok(unasked(Refusal::invalid(format!(
            "Plugin config cannot be updated while its current settings are invalid: {error}"
        ))));
    }

    if settings.fingerprint.as_str() != request.expected_fingerprint {
        return Ok(unasked(Refusal {
            reason: CONFLICT,
            message: CONFLICT_SENTENCE.to_owned(),
        }));
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
        effect: Box::new(Change {
            control,
            host,
            request,
        }),
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
}

impl Request {
    fn of(call: &ToolCall) -> Result<Result<Self, Refusal>, PluginError> {
        let asked: Asked = admitted(call)?;
        let value = call.input().get("value");

        for (name, text) in [
            ("pluginId", &asked.plugin_id),
            ("fieldName", &asked.field_name),
            ("expectedFingerprint", &asked.expected_fingerprint),
        ] {
            if text.trim().is_empty() {
                return Ok(Err(Refusal::invalid(blank(name))));
            }
        }

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
            match &value {
                None if field.required() => {
                    Some(format!("Required config field \"{name}\" cannot be unset."))
                }
                Some(value) if !field.accepts(value) => Some(expectation(field)),
                Some(value) if concealed(field, value) => Some(format!(
                    "Plugin config field \"{name}\" cannot be set to a value holding a \
                     credential or a redaction."
                )),
                _ => None,
            }
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

    /// Writes the change, its plugin rebuilt live as part of it when its
    /// field takes effect so and the host runs it. A change written is
    /// told as applied, live or at the next launch, whatever keeps it from
    /// being live.
    fn apply(self, control: &dyn ConfigControl, host: &HostLink) -> ToolCallOutcome {
        let live = !self.field.reload_required();
        let mut rebuild_live = |values: &Map<String, Value>| -> Result<(), String> {
            host.core()
                .map_err(|stopped| stopped.to_string())?
                .reload(&self.plugin, values)
                .map_err(|error| described(&error))
        };
        let outcome = control.change(
            &FieldChange {
                plugin: self.plugin.clone(),
                field: self.field.name().clone(),
                value: self.value.clone(),
                expected_fingerprint: self.expected_fingerprint.clone(),
            },
            live.then_some(&mut rebuild_live as Rebuild<'_>),
        );
        let (fingerprint, rebuilt) = match outcome {
            FieldChangeOutcome::Applied {
                fingerprint,
                rebuilt,
            } => (fingerprint, rebuilt),
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
        let waiting = match rebuilt {
            Some(Ok(())) => None,
            Some(Err(why)) => Some(why),
            None if live => Some("her settings do not run the plugin".to_owned()),
            None => {
                Some("the field takes effect only when the plugin is built at launch".to_owned())
            }
        };
        let mut output = Map::from_iter([
            ("status".to_owned(), Value::from("applied")),
            (
                "appliesTo".to_owned(),
                Value::from(if waiting.is_some() {
                    "next_launch"
                } else {
                    "now"
                }),
            ),
        ]);

        if let Some(reason) = waiting {
            output.insert(
                "appliesToNote".to_owned(),
                Value::from(format!(
                    "Applies at the next launch instead of live: {reason}."
                )),
            );
        }

        output.extend([
            ("pluginId".to_owned(), Value::from(self.plugin.as_str())),
            (
                "fieldName".to_owned(),
                Value::from(self.field.name().as_str()),
            ),
            ("operation".to_owned(), Value::from(self.operation())),
            ("fingerprint".to_owned(), Value::from(fingerprint.as_str())),
            (
                "reloadRequired".to_owned(),
                Value::from(self.field.reload_required()),
            ),
        ]);

        ToolCallOutcome::Accepted {
            output: Value::Object(output),
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
    host: HostLink,
    request: Request,
}

#[async_trait]
impl PreparedEffect for Change {
    async fn apply(
        self: Box<Self>,
        _context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        let Self {
            control,
            host,
            request,
        } = *self;

        blocking(move || request.apply(control.as_ref(), &host)).await
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
        .map_err(|error| PluginError::new(described(error)))?
        .iter()
        .map(|(manifest, _)| manifest)
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

/// Whether `value` holds what no reader of the settings is shown: a value
/// under a credential's name, or a redaction read back.
fn concealed(field: &ConfigField, value: &Value) -> bool {
    let mut redacted = value.clone();

    redact_credentials(&mut redacted);
    is_credential_key(field.name().as_str()) || redacted != *value || holds_redaction(value)
}

fn holds_redaction(value: &Value) -> bool {
    match value {
        Value::String(text) => text == REDACTED,
        Value::Array(items) => items.iter().any(holds_redaction),
        Value::Object(entries) => entries.values().any(holds_redaction),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

/// What a value of `field` must be, which never repeats the value refused.
fn expectation(field: &ConfigField) -> String {
    let name = field.name();

    match field.allowed_values() {
        Some(allowed) => format!(
            "Plugin config field \"{name}\" must be one of: {}.",
            allowed.join(", ")
        ),
        None => format!(
            "Plugin config field \"{name}\" must be {}.",
            match field.value_type() {
                Some(ConfigValueType::String | ConfigValueType::Path | ConfigValueType::Enum) =>
                    "a string",
                Some(ConfigValueType::Number) => "a number",
                Some(ConfigValueType::Boolean) => "a boolean",
                Some(ConfigValueType::Object) => "an object",
                Some(ConfigValueType::Array) => "an array",
                None => "a JSON value",
            }
        ),
    }
}

/// The call's input as its tool's contract admits it.
fn admitted<T: DeserializeOwned>(call: &ToolCall) -> Result<T, PluginError> {
    serde_json::from_value(Value::Object(call.input().clone())).map_err(|error| {
        PluginError::with_source(
            format!("{} input is not what its contract admits", call.tool_name()),
            error,
        )
    })
}

fn blank(name: &str) -> String {
    format!("Plugin config tool input \"{name}\" must be a non-empty string.")
}

fn unknown(plugin: &str) -> String {
    format!("Plugin \"{plugin}\" is not installed.")
}

fn unasked(refusal: Refusal) -> ToolPreparation {
    let Refusal { reason, message } = refusal;

    ToolPreparation::Rejected {
        reason: reason.to_owned(),
        evidence: vec![EvidenceNote::new(
            EvidenceKind::ToolInvocation,
            EvidenceStatus::Rejected,
            message.as_str(),
        )],
        message,
    }
}

fn accepted(summary: String) -> EvidenceNote {
    EvidenceNote::new(
        EvidenceKind::ToolInvocation,
        EvidenceStatus::Accepted,
        summary,
    )
}
