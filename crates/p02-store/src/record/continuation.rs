use std::num::NonZeroU32;

use p02_contracts::{ConversationTurn, ProviderName};
use p02_core::{EventId, SessionId};
use serde::{Deserialize, Serialize};

use super::RecordError;

/// The most a continuation's summary holds, in characters.
pub const MAX_SUMMARY_CHARS: usize = 6_000;

/// How a session began as the continuation of the one before it: what the
/// earlier conversation amounted to, and its newest turns carried over
/// whole, so the character keeps her footing. Carried turns keep their own
/// identities: they are context here, evidence in the session they came
/// from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "WireContinuation")]
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
pub struct SummaryProvider {
    pub name: ProviderName,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireContinuation {
    session_id: SessionId,
    continued_from: ContinuedFrom,
    summary: String,
    summarized_turn_count: NonZeroU32,
    carried_turns: Vec<ConversationTurn>,
    summarizer: Summarizer,
}

impl SessionContinuation {
    /// Session `session_id` continuing `continued_from`, which is the
    /// segment before it: `summary`, trimmed, condenses
    /// `summarized_turn_count` turns, and `carried_turns` follow it whole.
    ///
    /// # Errors
    ///
    /// [`RecordError`] when the summary trims to nothing or to more than
    /// [`MAX_SUMMARY_CHARS`] characters, `continued_from` is not the
    /// previous segment, or the summarizer is not named.
    pub fn new(
        session_id: SessionId,
        continued_from: ContinuedFrom,
        summary: &str,
        summarized_turn_count: NonZeroU32,
        carried_turns: Vec<ConversationTurn>,
        summarizer: Summarizer,
    ) -> Result<Self, RecordError> {
        let summary = summary.trim();

        if summary.is_empty() || summary.chars().count() > MAX_SUMMARY_CHARS {
            return Err(RecordError::Summary);
        }

        let previous = session_id
            .segment()
            .get()
            .checked_sub(1)
            .and_then(std::num::NonZeroU64::new)
            .map(|segment| SessionId::new(session_id.conversation_id().clone(), segment));

        if previous.as_ref() != Some(&continued_from.session_id) {
            return Err(RecordError::ContinuedFrom);
        }

        let named = match &summarizer {
            Summarizer::Model { provider } => provider
                .model
                .as_deref()
                .is_none_or(|model| !model.trim().is_empty()),
            Summarizer::Fallback { reason } => !reason.trim().is_empty(),
        };

        if !named {
            return Err(RecordError::Summarizer);
        }

        Ok(Self {
            session_id,
            continued_from,
            summary: summary.to_owned(),
            summarized_turn_count,
            carried_turns,
            summarizer,
        })
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

impl TryFrom<WireContinuation> for SessionContinuation {
    type Error = RecordError;

    /// A record is judged as it stands: its summary is already trimmed.
    fn try_from(wire: WireContinuation) -> Result<Self, Self::Error> {
        if wire.summary.trim() != wire.summary {
            return Err(RecordError::Summary);
        }

        Self::new(
            wire.session_id,
            wire.continued_from,
            &wire.summary,
            wire.summarized_turn_count,
            wire.carried_turns,
            wire.summarizer,
        )
    }
}
