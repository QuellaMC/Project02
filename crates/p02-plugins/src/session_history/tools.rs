use std::error::Error;

use p02_contracts::{PluginError, ProvidedTool, ToolInputContract};
use p02_shared::Identifier;
use serde_json::{Value, json};

pub(super) const SEARCH: &str = "sessions.search";
pub(super) const READ: &str = "sessions.read";

/// A session id as the model writes one, which is a session id's rule.
const SESSION_ID_PATTERN: &str = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";

const SEARCH_DESCRIPTION: &str = "Search your own past conversations. Use it whenever they mention \
     an earlier conversation or the answer may sit further back than you can see, before asking \
     them to repeat themselves. The query is matched as literal text, spaces included (no \
     operators). Messages you can currently see never match, so results always add to your \
     context, including older parts of this conversation. Each matching session returns its \
     opening messages, a window around the best match, and its closing messages; scroll further \
     with sessions.read.";

const READ_DESCRIPTION: &str = "Read a window of messages from one of your past conversations, \
     oldest-first. Without anchorMessageId it returns the latest messages. To scroll, pass a \
     returned messageId as anchorMessageId to get the messages around it; hasBefore and hasAfter \
     say whether more exist beyond the window.";

/// The two tools. Each call has the index to itself, so they are
/// exclusive: a call's budget starts when it runs, not while an earlier
/// call holds the index.
pub(super) fn provided() -> Result<Vec<ProvidedTool>, PluginError> {
    Ok(vec![
        tool(
            SEARCH,
            SEARCH_DESCRIPTION,
            json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 256,
                        "description": "Literal text to find in past messages.",
                    },
                    "sessionId": {
                        "type": "string",
                        "pattern": SESSION_ID_PATTERN,
                        "description": "Restrict the search to one session.",
                    },
                    "sessionLimit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 5,
                        "description": "Maximum sessions to return (default 3).",
                    },
                },
                "required": ["query"],
                "additionalProperties": false,
            }),
        )?,
        tool(
            READ,
            READ_DESCRIPTION,
            json!({
                "type": "object",
                "properties": {
                    "sessionId": {
                        "type": "string",
                        "pattern": SESSION_ID_PATTERN,
                        "description": "The session to read, from sessions.search results.",
                    },
                    "anchorMessageId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "Center the window on this messageId.",
                    },
                    "window": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 15,
                        "description": "Messages on each side of the anchor (default 8).",
                    },
                },
                "required": ["sessionId"],
                "additionalProperties": false,
            }),
        )?,
    ])
}

fn tool(name: &str, description: &str, contract: Value) -> Result<ProvidedTool, PluginError> {
    ProvidedTool::new(
        Identifier::new(name).map_err(refused(name))?,
        description,
        ToolInputContract::new(contract).map_err(refused(name))?,
    )
    .map_err(refused(name))
}

fn refused<E: Error + Send + Sync + 'static>(name: &str) -> impl Fn(E) -> PluginError + '_ {
    move |error| PluginError::with_source(format!("tool \"{name}\" was refused"), error)
}
