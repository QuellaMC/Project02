//! A connector's bots: the table of them a connector tells the daemon,
//! which health shows while the connector is on the stream, and what came
//! of telling it.

use schemars::JsonSchema;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

use crate::config::ConfigTarget;
use crate::text::BotUsername;

/// The most bots a table holds. A home has one for each character and one
/// of its own, so no home comes near it.
const MAX_BOTS: usize = 256;

/// A connector's bot table, whole every time: the daemon holds it in place
/// of the one it held, never beside it.
#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ConnectorBotsBody {
    #[serde(deserialize_with = "within_bound")]
    #[schemars(length(max = MAX_BOTS))]
    pub bots: Vec<ConnectorBot>,
}

fn within_bound<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<ConnectorBot>, D::Error> {
    let bots = Vec::deserialize(deserializer)?;

    if bots.len() > MAX_BOTS {
        return Err(D::Error::custom(format!(
            "a bot table holds at most {MAX_BOTS} bots"
        )));
    }

    Ok(bots)
}

/// One bot a connector runs, as the connector says it stands: whose it is,
/// the home's own or one character's, the name it goes by once its service
/// has said who it is, and its state. Its token is no part of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConnectorBot {
    pub target: ConfigTarget,
    #[serde(
        default,
        deserialize_with = "given_username",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "BotUsername")]
    pub username: Option<BotUsername>,
    pub state: BotState,
}

/// A username a table gives, or, when `username` is absent, none. A null is
/// no username.
fn given_username<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<BotUsername>, D::Error> {
    BotUsername::deserialize(deserializer).map(Some)
}

/// How a bot stands. A bot that does not know yet is in no table.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum BotState {
    /// It is receiving messages.
    On,
    /// Its service refused its token.
    Refused,
    /// Its service cannot be reached.
    Unreachable,
    /// Another program is polling its token.
    Conflict,
    /// Its token is set to a webhook.
    Webhook,
}

/// What came of a connector's bot table. `kept`: health shows it from now
/// on, until the connector's last stream ends.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ConnectorBotsOutcome {
    Kept,
    Refused {
        reason: ConnectorBotsRefusal,
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorBotsRefusal {
    UnknownConnector,
    /// No stream of the connector is open, and a table is kept only while
    /// one is.
    NotConnected,
}
