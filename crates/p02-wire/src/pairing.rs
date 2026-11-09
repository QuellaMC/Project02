//! Pairing: an account a connector asks the person to let in, waiting
//! under a code for the person's answer, and how that came out.

use p02_core::{ClientStamp, SpeakerName, Timestamp};
use p02_shared::Identifier;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::confirmation::Answer;
use crate::text::Short;

/// The account a connector asks the person to let in, and where it wrote.
#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PairingRequestBody {
    pub subject: PairingSubjectBody,
    /// The connector's endpoint the account wrote to, as the stamp its
    /// lines will carry: for Telegram, `telegram:<bot username>`.
    pub source: ClientStamp,
}

/// The account a pairing is for: its id a stamp, and its name within the
/// bound of a name a person goes by, which the daemon judges further.
#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PairingSubjectBody {
    pub id: ClientStamp,
    pub label: Short,
}

/// An account a connector asks to let in, waiting for the person's answer
/// under a code any surface shows and answers by, until it expires.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PairingRequest {
    pub connector_id: Identifier,
    /// Six digits, unique among the requests waiting.
    pub code: String,
    pub subject: PairingSubject,
    /// The connector's endpoint the account first wrote to, as the stamp
    /// its lines will carry: for Telegram, `telegram:<bot username>`.
    pub source: ClientStamp,
    pub requested_at: Timestamp,
    /// When the request expires, in milliseconds since the Unix epoch.
    pub expires_at: i64,
}

/// The account a pairing is for: the connector's own id for it, and the
/// name the person sees.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct PairingSubject {
    pub id: ClientStamp,
    pub label: SpeakerName,
}

/// What came of a connector's request to let an account in. `paired`: the
/// home lets it in already, so nothing is asked.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(rename = "PairingRequestOutcome")]
#[schemars(rename = "PairingRequestOutcome")]
pub enum PairingOutcome {
    Pending {
        request: PairingRequest,
    },
    Paired,
    Refused {
        reason: PairingRefusal,
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PairingRefusal {
    UnknownConnector,
    ConfigUnloadable,
}

/// What an answer to a pairing request came to. `expired`: the deadline had
/// passed, so the request was settled expired instead, as a confirmation
/// is; `failed`: the approval could not be written, and the request waits
/// on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(rename = "PairingSettleOutcome")]
#[schemars(rename = "PairingSettleOutcome")]
pub enum PairingAnswer {
    Settled { decision: Answer },
    Expired,
    Unknown,
    Failed { message: String },
}

/// How a pairing request ended: with the person's answer, or at its
/// deadline.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PairingDecision {
    Approved,
    Denied,
    Expired,
}
