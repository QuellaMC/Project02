use std::num::NonZeroU32;

use p02_contracts::Evidence;
use p02_core::{ClientStamp, MessageId, VisibleMessage, VisibleMessageRole};
use serde::{Deserialize, Serialize};

use super::RecordError;

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
    /// The person's line, `message`.
    ///
    /// # Errors
    ///
    /// [`RecordError::Commit`] when `message` is not the person's.
    pub fn user(message: VisibleMessage) -> Result<Self, RecordError> {
        if message.role != VisibleMessageRole::User {
            return Err(RecordError::Commit);
        }

        Ok(Self {
            message,
            said: Said::ByPerson {
                source: None,
                client_message_id: None,
            },
        })
    }

    /// A character's reply, `message`, said in round `round`, with the
    /// evidence that came with it.
    ///
    /// # Errors
    ///
    /// [`RecordError::Commit`] when `message` is not a character's.
    pub fn character(
        message: VisibleMessage,
        round: NonZeroU32,
        evidence: Vec<Evidence>,
    ) -> Result<Self, RecordError> {
        if message.role != VisibleMessageRole::Character {
            return Err(RecordError::Commit);
        }

        Ok(Self {
            message,
            said: Said::ByCharacter { round, evidence },
        })
    }

    /// The person's line as the surface `source` carried it.
    ///
    /// # Errors
    ///
    /// [`RecordError::Commit`] for a character's reply, which no client
    /// stamps.
    pub fn with_source(mut self, stamp: ClientStamp) -> Result<Self, RecordError> {
        match &mut self.said {
            Said::ByPerson { source, .. } => *source = Some(stamp),
            Said::ByCharacter { .. } => return Err(RecordError::Commit),
        }

        Ok(self)
    }

    /// The person's line as its client submitted it, under `stamp`.
    ///
    /// # Errors
    ///
    /// [`RecordError::Commit`] for a character's reply, which no client
    /// stamps.
    pub fn with_client_message_id(mut self, stamp: ClientStamp) -> Result<Self, RecordError> {
        match &mut self.said {
            Said::ByPerson {
                client_message_id, ..
            } => *client_message_id = Some(stamp),
            Said::ByCharacter { .. } => return Err(RecordError::Commit),
        }

        Ok(self)
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

    #[must_use]
    pub fn evidence(&self) -> &[Evidence] {
        match &self.said {
            Said::ByCharacter { evidence, .. } => evidence,
            Said::ByPerson { .. } => &[],
        }
    }
}

impl TryFrom<WireCommit> for MessageCommitted {
    type Error = RecordError;

    fn try_from(wire: WireCommit) -> Result<Self, Self::Error> {
        if wire.visible_message_ids != [wire.visible_message.id.clone()] {
            return Err(RecordError::Commit);
        }

        match (wire.round, wire.visible_message.role) {
            (None, VisibleMessageRole::User) if wire.runtime_plugin_evidence.is_empty() => {
                Ok(Self {
                    message: wire.visible_message,
                    said: Said::ByPerson {
                        source: wire.source,
                        client_message_id: wire.client_message_id,
                    },
                })
            }
            (Some(round), VisibleMessageRole::Character)
                if wire.source.is_none() && wire.client_message_id.is_none() =>
            {
                Self::character(wire.visible_message, round, wire.runtime_plugin_evidence)
            }
            _ => Err(RecordError::Commit),
        }
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
