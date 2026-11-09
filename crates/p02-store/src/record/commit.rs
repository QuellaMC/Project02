use std::num::NonZeroU32;

use p02_contracts::Evidence;
use p02_core::{ClientStamp, MessageId, VisibleMessage, VisibleMessageRole};
use serde::{Deserialize, Serialize};

/// A visible message committed: the person's line, stamped by the client
/// that carried it, or a character's reply, named by the round that said
/// it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "WireCommit", into = "WireCommit")]
pub struct MessageCommitted {
    message: VisibleMessage,
    said: Said,
}

#[derive(Clone, Debug, PartialEq)]
enum Said {
    ByPerson {
        source: Option<ClientStamp>,
        client_message_id: Option<ClientStamp>,
    },
    ByCharacter {
        round: NonZeroU32,
        evidence: Vec<Evidence>,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireCommit {
    visible_message_ids: Vec<MessageId>,
    visible_message: VisibleMessage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<ClientStamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_message_id: Option<ClientStamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    round: Option<NonZeroU32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    runtime_plugin_evidence: Vec<Evidence>,
}

impl MessageCommitted {
    /// The person's line, `message`, as the surface `source` carried it
    /// and its client submitted it, under `client_message_id`.
    #[must_use]
    pub fn user(
        message: VisibleMessage,
        source: Option<ClientStamp>,
        client_message_id: Option<ClientStamp>,
    ) -> Self {
        Self {
            message,
            said: Said::ByPerson {
                source,
                client_message_id,
            },
        }
    }

    /// A character's reply, `message`, said in round `round`, with the
    /// evidence that came with it.
    #[must_use]
    pub fn character(message: VisibleMessage, round: NonZeroU32, evidence: Vec<Evidence>) -> Self {
        Self {
            message,
            said: Said::ByCharacter { round, evidence },
        }
    }

    #[must_use]
    pub fn message(&self) -> &VisibleMessage {
        &self.message
    }

    /// The round that said a character's reply; none for the person's line.
    #[must_use]
    pub fn round(&self) -> Option<NonZeroU32> {
        match &self.said {
            Said::ByCharacter { round, .. } => Some(*round),
            Said::ByPerson { .. } => None,
        }
    }

    #[must_use]
    pub fn source(&self) -> Option<&ClientStamp> {
        match &self.said {
            Said::ByPerson { source, .. } => source.as_ref(),
            Said::ByCharacter { .. } => None,
        }
    }

    #[must_use]
    pub fn client_message_id(&self) -> Option<&ClientStamp> {
        match &self.said {
            Said::ByPerson {
                client_message_id, ..
            } => client_message_id.as_ref(),
            Said::ByCharacter { .. } => None,
        }
    }
}

impl TryFrom<WireCommit> for MessageCommitted {
    type Error = &'static str;

    fn try_from(wire: WireCommit) -> Result<Self, Self::Error> {
        Ok(match (wire.visible_message.role, wire.round) {
            (VisibleMessageRole::User, _) => {
                Self::user(wire.visible_message, wire.source, wire.client_message_id)
            }
            (VisibleMessageRole::Character, Some(round)) => {
                Self::character(wire.visible_message, round, wire.runtime_plugin_evidence)
            }
            (VisibleMessageRole::Character, None) => {
                return Err("a character's reply names the round that said it");
            }
        })
    }
}

impl From<MessageCommitted> for WireCommit {
    fn from(commit: MessageCommitted) -> Self {
        let visible_message_ids = vec![commit.message.id.clone()];

        match commit.said {
            Said::ByPerson {
                source,
                client_message_id,
            } => Self {
                visible_message_ids,
                visible_message: commit.message,
                source,
                client_message_id,
                round: None,
                runtime_plugin_evidence: Vec::new(),
            },
            Said::ByCharacter { round, evidence } => Self {
                visible_message_ids,
                visible_message: commit.message,
                source: None,
                client_message_id: None,
                round: Some(round),
                runtime_plugin_evidence: evidence,
            },
        }
    }
}
