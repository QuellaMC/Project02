use p02_contracts::{PluginError, ProvidedTool};
use serde_json::json;

use crate::package::tool;

pub(super) const SEARCH: &str = "sessions.search";
pub(super) const READ: &str = "sessions.read";

/// A session id as the model writes one, which is a session id's rule.
const SESSION_ID_PATTERN: &str = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";

const SEARCH_DESCRIPTION: &str = "Look back through your messages with the one you write with for \
     something that was said. Do it before asking them to say it again. query is matched as you \
     write it, with no operators. Messages in front of you never match, so what it finds always \
     adds to what you have in front of you, older parts of this conversation too; matchesInView \
     counts those in front of you that hold query. When nothing comes back and matchesInView is \
     above zero, what you look for is already in front of you. For each conversation it finds, you \
     see how it began, the messages around the best match, and how it ended; read on with \
     sessions.read.";

const READ_DESCRIPTION: &str = "Read the messages around one of them, oldest first, as you would \
     scroll back. Without anchorMessageId you see the latest messages. To scroll, give a messageId \
     you have seen as anchorMessageId, and you see the messages around it; hasBefore and hasAfter \
     say whether there are more before and after them.";

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
                        "description": "What to find, word for word.",
                    },
                    "sessionId": {
                        "type": "string",
                        "pattern": SESSION_ID_PATTERN,
                        "description": "One conversation to look through, and no other.",
                    },
                    "sessionLimit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 5,
                        "description": "How many conversations to show at most; 3 when left \
                                        out.",
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
                        "description": "The conversation to read, as sessions.search showed it.",
                    },
                    "anchorMessageId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "description": "The messageId to read around.",
                    },
                    "window": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 15,
                        "description": "How many messages to see on each side of it; 8 when \
                                        left out.",
                    },
                },
                "required": ["sessionId"],
                "additionalProperties": false,
            }),
        )?,
    ])
}
