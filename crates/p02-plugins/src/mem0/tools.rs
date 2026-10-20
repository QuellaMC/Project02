use p02_contracts::{PluginError, ProvidedTool, ToolConcurrency};
use serde_json::json;

use crate::package::tool;

pub(super) const SEARCH: &str = "mem0.search";
pub(super) const ADD: &str = "mem0.add";

/// The two tools. Searches may overlap; an add runs alone.
pub(super) fn provided() -> Result<Vec<ProvidedTool>, PluginError> {
    Ok(vec![
        tool(
            SEARCH,
            "Search your long-term memory for anything relevant.",
            json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query."},
                },
                "required": ["query"],
                "additionalProperties": false,
            }),
        )?
        .with_concurrency(ToolConcurrency::Shared),
        tool(
            ADD,
            "Keep a short memory for later.",
            json!({
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Memory text."},
                },
                "required": ["text"],
                "additionalProperties": false,
            }),
        )?,
    ])
}
