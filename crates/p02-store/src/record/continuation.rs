use std::num::NonZeroU32;

use p02_contracts::{ConversationTurn, ProviderName};
use p02_core::{EventId, SessionId};
use serde::{Deserialize, Serialize};

/// How a session began as the continuation of the one before it: what the
/// earlier conversation amounted to, and its newest turns carried over
/// whole, so the character keeps her footing. Carried turns keep their own
/// identities: they are context here, evidence in the session they came
/// from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionContinuation {
    session_id: SessionId,
    continued_from: ContinuedFrom,
    summary: String,
    summarized_turn_count: NonZeroU32,
    carried_turns: Vec<ConversationTurn>,
    summarizer: Summarizer,
}

/// The session continued, and the last event it holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuedFrom {
    pub session_id: SessionId,
    pub last_event_id: EventId,
}

/// Who wrote the summary: a model, or, without one, the runtime itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Summarizer {
    Model { provider: SummaryProvider },
    Fallback { reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SummaryProvider {
    pub name: ProviderName,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl SessionContinuation {
    /// Session `session_id` continuing `continued_from`, the segment before
    /// it: `summary` condenses `summarized_turn_count` turns, and
    /// `carried_turns` follow it whole.
    #[must_use]
    pub fn new(
        session_id: SessionId,
        continued_from: ContinuedFrom,
        summary: String,
        summarized_turn_count: NonZeroU32,
        carried_turns: Vec<ConversationTurn>,
        summarizer: Summarizer,
    ) -> Self {
        Self {
            session_id,
            continued_from,
            summary,
            summarized_turn_count,
            carried_turns,
            summarizer,
        }
    }

    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    #[must_use]
    pub fn continued_from(&self) -> &ContinuedFrom {
        &self.continued_from
    }

    #[must_use]
    pub fn summary(&self) -> &str {
        &self.summary
    }

    #[must_use]
    pub fn summarized_turn_count(&self) -> NonZeroU32 {
        self.summarized_turn_count
    }

    #[must_use]
    pub fn carried_turns(&self) -> &[ConversationTurn] {
        &self.carried_turns
    }

    #[must_use]
    pub fn summarizer(&self) -> &Summarizer {
        &self.summarizer
    }
}
