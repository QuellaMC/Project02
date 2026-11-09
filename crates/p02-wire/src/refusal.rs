//! The transport's one refusal, which a request the routes never answered
//! meets under its status.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A transport refusal: the envelope's code and sentence.
#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
pub struct Refusal {
    pub code: String,
    pub message: String,
}

/// The one shape every transport refusal takes; a verb's outcome never
/// uses it.
#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[ts(rename = "GatewayErrorBody")]
#[schemars(rename = "GatewayErrorBody")]
pub struct ErrorBody {
    pub error: Refusal,
}
