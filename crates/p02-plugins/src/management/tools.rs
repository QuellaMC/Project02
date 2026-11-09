use p02_contracts::{Confirmation, PLUGIN_LIST_TOOL, PluginError, ProvidedTool, ToolConcurrency};
use serde_json::json;

use crate::package::tool;

pub(super) const CONFIG: &str = "runtime.plugin.config";
pub(super) const UPDATE: &str = "runtime.plugin.config.update";

const LIST_DESCRIPTION: &str = "List plugins available to you in the current turn or inspect the \
     installed plugin catalog. Call this when you need canonical plugin inventory.";

const CONFIG_DESCRIPTION: &str = "Inspect one installed plugin config using manifest metadata and \
     redacted authored and effective values. Secret values are never returned.";

const UPDATE_DESCRIPTION: &str = "Set or unset one declared non-secret, agent-mutable plugin config \
     field after exact user approval. This cannot change activation, permissions, paths, secrets, \
     or Project02 host settings. An approved change is written at once and is in effect from \
     your very next response on.";

const VALUE_DESCRIPTION: &str = "New JSON value. Required for set and unavailable for unset. Must \
     match the target field's declared valueType and allowedValues as returned by \
     runtime.plugin.config (e.g. a plain string for a string field, not a JSON-encoded array).";

/// The list, which changes nothing, so its calls overlap.
pub(super) fn list() -> Result<ProvidedTool, PluginError> {
    Ok(tool(
        PLUGIN_LIST_TOOL,
        LIST_DESCRIPTION,
        json!({
            "type": "object",
            "properties": {
                "includeDisabled": {
                    "type": "boolean",
                    "description": "Include disabled or unavailable plugins when true.",
                },
                "scope": {
                    "type": "string",
                    "description": "Use \"enabled\" for current-turn plugins or \"all\" for every \
                                    installed plugin.",
                    "enum": ["enabled", "all"],
                },
            },
            "required": [],
            "additionalProperties": false,
        }),
    )?
    .with_concurrency(ToolConcurrency::Shared))
}

/// The config tools: a read, which overlaps as the list does, and a change,
/// which runs alone, and only on the person's yes.
pub(super) fn config() -> Result<[ProvidedTool; 2], PluginError> {
    Ok([
        tool(
            CONFIG,
            CONFIG_DESCRIPTION,
            json!({
                "type": "object",
                "properties": {
                    "pluginId": {
                        "type": "string",
                        "description": "Exact installed plugin id to inspect.",
                    },
                },
                "required": ["pluginId"],
                "additionalProperties": false,
            }),
        )?
        .with_concurrency(ToolConcurrency::Shared),
        tool(
            UPDATE,
            UPDATE_DESCRIPTION,
            json!({
                "type": "object",
                "properties": {
                    "pluginId": {
                        "type": "string",
                        "description": "Exact installed plugin id to update.",
                    },
                    "fieldName": {
                        "type": "string",
                        "description": "Exact manifest-declared config field name.",
                    },
                    "operation": {
                        "type": "string",
                        "description": "Apply exactly one set or unset operation.",
                        "enum": ["set", "unset"],
                    },
                    "value": {"description": VALUE_DESCRIPTION},
                    "expectedFingerprint": {
                        "type": "string",
                        "description": "Authored config fingerprint returned by \
                                        runtime.plugin.config.",
                    },
                },
                "required": ["pluginId", "fieldName", "operation", "expectedFingerprint"],
                "additionalProperties": false,
            }),
        )?
        .with_confirmation(Confirmation::Required),
    ])
}
