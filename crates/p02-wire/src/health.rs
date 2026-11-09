//! Health: the daemon's whole state in one read, each installed character
//! as it reports her, and what an explicit start of one came to.

use p02_core::{SpeakerName, Timestamp};
use p02_shared::{Identifier, vocabulary};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::diagnostic::Diagnostic;
use crate::protocol::ProtocolVersion;

/// The daemon's whole state in one read.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "GatewayHealth")]
#[schemars(rename = "GatewayHealth")]
pub struct Health {
    pub protocol_version: ProtocolVersion,
    pub home_root: String,
    /// What the home's settings document says of itself.
    pub config: ConfigHealth,
    /// The packages discovery could not publish, which the roster lacks.
    pub packages: PackagesHealth,
    pub characters: Vec<CharacterSummary>,
    pub connectors: Vec<ConnectorPresence>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
pub struct ConfigHealth {
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
pub struct PackagesHealth {
    pub diagnostics: Vec<PackageReport>,
}

/// A package discovery could not publish, and why, where.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
pub struct PackageReport {
    pub message: String,
    pub path: String,
}

/// Whether a process of a built-in connector is on the event stream now.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
pub struct ConnectorPresence {
    pub id: Identifier,
    pub connected: bool,
}

/// One installed character, as health reports her.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct CharacterSummary {
    pub id: Identifier,
    pub display_name: SpeakerName,
    pub enabled: bool,
    pub state: RosterState,
    /// Why she failed, or what her start warned of.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    /// The latest background failure since she started.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maintenance: Option<MaintenanceFailure>,
}

/// Where an installed character stands as health reports her: her
/// runtime's state, or `not_started` until the daemon built it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum RosterState {
    NotStarted,
    Starting,
    Ready,
    Stopping,
    Stopped,
    Failed,
}

impl From<Option<CharacterState>> for RosterState {
    fn from(state: Option<CharacterState>) -> Self {
        match state {
            None => Self::NotStarted,
            Some(CharacterState::Starting) => Self::Starting,
            Some(CharacterState::Ready) => Self::Ready,
            Some(CharacterState::Stopping) => Self::Stopping,
            Some(CharacterState::Stopped) => Self::Stopped,
            Some(CharacterState::Failed) => Self::Failed,
        }
    }
}

vocabulary! {
    /// Where a character's runtime stands.
    #[ts(rename = "CharacterRuntimeState")]
    #[schemars(rename = "CharacterRuntimeState")]
    CharacterState {
        Starting = "starting",
        Ready = "ready",
        Stopping = "stopping",
        Stopped = "stopped",
        Failed = "failed",
    }
}

/// A background failure the conversation never sees: the plugins' work
/// after a turn's commit, a segment rotation that failed, which the next
/// turn plans again, what closing a segment left undone, or what opening
/// her thread skipped because it could not be read.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, TS)]
pub struct MaintenanceFailure {
    pub at: Timestamp,
    pub message: String,
}

/// What an explicit start came to: `settled` says it ran, and the summary's
/// state says how it ended.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum StartOutcome {
    Settled {
        character: CharacterSummary,
    },
    Refused {
        reason: StartRefusal,
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum StartRefusal {
    UnknownCharacter,
    GatewayStopped,
}
