use std::num::NonZeroU32;

use p02_contracts::Evidence;
use p02_core::{ClientStamp, MessageId, VisibleMessage, VisibleMessageRole, VisibleText};
use serde::{Deserialize, Serialize};

/// A visible message committed: the person's line, stamped by the client
/// that carried it, or a character's reply, named by the round that said
/// it, with the app it went in. When the two read each other in their own
/// languages, the person's line keeps what they wrote beside what she read,
/// and her reply the same words in the person's language.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "WireCommit", into = "WireCommit")]
pub struct MessageCommitted {
    message: VisibleMessage,
    said: Said,
}

#[derive(Clone, Debug, PartialEq)]
enum Said {
    /// A line an earlier build wrote may lack its stamps.
    ByPerson {
        written: Option<VisibleText>,
        source: Option<ClientStamp>,
        client_message_id: Option<ClientStamp>,
    },
    /// A reply an earlier build wrote names no app.
    ByCharacter {
        translation: Option<VisibleText>,
        round: NonZeroU32,
        app: Option<String>,
        evidence: Vec<Evidence>,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireCommit {
    visible_message_ids: Vec<MessageId>,
    visible_message: VisibleMessage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    written: Option<VisibleText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    translation: Option<VisibleText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<ClientStamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_message_id: Option<ClientStamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    round: Option<NonZeroU32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    runtime_plugin_evidence: Vec<Evidence>,
}

impl MessageCommitted {
    /// The person's line, `message`, as she read it, with what they wrote,
    /// `written`, when she read it in another language; as the surface
    /// `source` carried it and its client submitted it, under
    /// `client_message_id`.
    #[must_use]
    pub fn user(
        message: VisibleMessage,
        written: Option<VisibleText>,
        source: ClientStamp,
        client_message_id: ClientStamp,
    ) -> Self {
        Self {
            message,
            said: Said::ByPerson {
                written,
                source: Some(source),
                client_message_id: Some(client_message_id),
            },
        }
    }

    /// A character's reply, `message`, with the same words in the person's
    /// language, `translation`, when they read another; said in round
    /// `round` and sent in the app `app`, with the evidence that came with
    /// it.
    #[must_use]
    pub fn character(
        message: VisibleMessage,
        translation: Option<VisibleText>,
        round: NonZeroU32,
        app: String,
        evidence: Vec<Evidence>,
    ) -> Self {
        Self {
            message,
            said: Said::ByCharacter {
                translation,
                round,
                app: Some(app),
                evidence,
            },
        }
    }

    /// The message as the character was given it or wrote it.
    #[must_use]
    pub fn message(&self) -> &VisibleMessage {
        &self.message
    }

    /// The person's line as they wrote it, when she read it in another
    /// language; none for a reply.
    #[must_use]
    pub fn written(&self) -> Option<&VisibleText> {
        match &self.said {
            Said::ByPerson { written, .. } => written.as_ref(),
            Said::ByCharacter { .. } => None,
        }
    }

    /// A character's reply in the person's language, when they read
    /// another; none for the person's line.
    #[must_use]
    pub fn translation(&self) -> Option<&VisibleText> {
        match &self.said {
            Said::ByCharacter { translation, .. } => translation.as_ref(),
            Said::ByPerson { .. } => None,
        }
    }

    /// The round that said a character's reply; none for the person's line.
    #[must_use]
    pub fn round(&self) -> Option<NonZeroU32> {
        match &self.said {
            Said::ByCharacter { round, .. } => Some(*round),
            Said::ByPerson { .. } => None,
        }
    }

    /// The id of the app a character's reply went in; none for the
    /// person's line, whose stamp tells its app, and for a reply an earlier
    /// build wrote.
    #[must_use]
    pub fn app(&self) -> Option<&str> {
        match &self.said {
            Said::ByCharacter { app, .. } => app.as_deref(),
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
            (VisibleMessageRole::User, _) => Self {
                message: wire.visible_message,
                said: Said::ByPerson {
                    written: wire.written,
                    source: wire.source,
                    client_message_id: wire.client_message_id,
                },
            },
            (VisibleMessageRole::Character, Some(round)) => Self {
                message: wire.visible_message,
                said: Said::ByCharacter {
                    translation: wire.translation,
                    round,
                    app: wire.app,
                    evidence: wire.runtime_plugin_evidence,
                },
            },
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
                written,
                source,
                client_message_id,
            } => Self {
                visible_message_ids,
                visible_message: commit.message,
                written,
                translation: None,
                source,
                client_message_id,
                app: None,
                round: None,
                runtime_plugin_evidence: Vec::new(),
            },
            Said::ByCharacter {
                translation,
                round,
                app,
                evidence,
            } => Self {
                visible_message_ids,
                visible_message: commit.message,
                written: None,
                translation,
                source: None,
                client_message_id: None,
                app,
                round: Some(round),
                runtime_plugin_evidence: evidence,
            },
        }
    }
}
