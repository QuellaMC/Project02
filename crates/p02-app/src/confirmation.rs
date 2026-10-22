//! The confirmer each character's plugin host asks before an approval-gated
//! call takes effect: the question parked under an id any surface answers
//! by, until the person answers, its deadline passes or the character
//! stops.

use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use p02_core::Timestamp;
use p02_plugins::{ConfirmationDecision, ConfirmationRequest, Confirmer};
use p02_shared::Identifier;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize, Serializer};
use tokio::sync::oneshot;
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;
use uuid::Uuid;

use crate::daemon::Events;
use crate::outcome::{
    CancelReason, ConfirmationAnswer, ConfirmationQuestion, Event, PendingConfirmation, Settlement,
    TurnStamp,
};

/// A parked confirmation's id: a fresh UUID, unique across the daemon, by
/// which any surface answers it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, JsonSchema, TS)]
#[schemars(with = "String")]
#[ts(as = "String")]
pub struct ConfirmationId(Uuid);

impl ConfirmationId {
    /// A fresh id: the one way one is minted.
    #[must_use]
    pub fn mint() -> Self {
        Self(Uuid::new_v4())
    }
}

impl fmt::Display for ConfirmationId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl Serialize for ConfirmationId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

/// The person's answer to a parked confirmation or a pairing request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum Answer {
    Approved,
    Denied,
}

/// One character's confirmations: the turn running now, which every
/// question it raises is stamped with, and the questions parked, oldest
/// first. Her stop settles every parked one and every later one at once.
#[derive(Debug)]
pub(crate) struct Broker {
    character: Identifier,
    wait: Duration,
    stop: CancellationToken,
    events: Arc<Events>,
    turn: Mutex<Option<TurnStamp>>,
    parked: Mutex<Vec<Parked>>,
}

#[derive(Debug)]
struct Parked {
    pending: PendingConfirmation,
    answer: oneshot::Sender<ConfirmationDecision>,
}

impl Broker {
    pub(crate) fn new(
        character: Identifier,
        wait: Duration,
        stop: CancellationToken,
        events: Arc<Events>,
    ) -> Self {
        Self {
            character,
            wait,
            stop,
            events,
            turn: Mutex::new(None),
            parked: Mutex::new(Vec::new()),
        }
    }

    /// The turn running now, or none between turns.
    pub(crate) fn running(&self, turn: Option<TurnStamp>) {
        *self.turn.lock().unwrap_or_else(PoisonError::into_inner) = turn;
    }

    pub(crate) fn pending(&self) -> Vec<PendingConfirmation> {
        self.parked()
            .iter()
            .map(|parked| parked.pending.clone())
            .collect()
    }

    /// Settles the confirmation `id` as the person answered it, unless the
    /// deadline they were shown had passed: then it is settled cancelled,
    /// whatever the timer has done so far, since the client never judges
    /// the deadline. The timer runs on a clock of its own, which a suspend
    /// can stop; the deadline is the one shown, on the clock it was shown
    /// on.
    pub(crate) fn answer(&self, id: &str, answer: Answer) -> ConfirmationAnswer {
        let Some(parked) = Uuid::try_parse(id)
            .ok()
            .and_then(|id| self.take(ConfirmationId(id)))
        else {
            return ConfirmationAnswer::Unknown;
        };

        if Timestamp::now().unix_millis() >= parked.pending.deadline_at {
            self.settled(
                parked,
                Settlement::Cancelled {
                    reason: CancelReason::Expired,
                },
            );
            return ConfirmationAnswer::Expired;
        }

        self.settled(
            parked,
            match answer {
                Answer::Approved => Settlement::Approved,
                Answer::Denied => Settlement::Denied,
            },
        );
        ConfirmationAnswer::Answered
    }

    fn parked(&self) -> std::sync::MutexGuard<'_, Vec<Parked>> {
        self.parked.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn take(&self, id: ConfirmationId) -> Option<Parked> {
        let mut parked = self.parked();
        let index = parked.iter().position(|parked| parked.pending.id == id)?;

        Some(parked.remove(index))
    }

    /// Settles `id` as `settlement` says, unless something settled it
    /// first.
    fn settle(&self, id: ConfirmationId, settlement: Settlement) {
        if let Some(parked) = self.take(id) {
            self.settled(parked, settlement);
        }
    }

    /// Announces the settlement of a confirmation taken from the parked
    /// ones, its one announcement, and hands the waiting call the decision.
    fn settled(&self, parked: Parked, settlement: Settlement) {
        self.events.emit(Event::ConfirmationSettled {
            character_id: self.character.clone(),
            id: parked.pending.id,
            settlement,
        });

        let _ = parked.answer.send(match settlement {
            Settlement::Approved => ConfirmationDecision::Approved,
            Settlement::Denied => ConfirmationDecision::Denied,
            Settlement::Cancelled { .. } => ConfirmationDecision::Cancelled,
        });
    }
}

#[async_trait]
impl Confirmer for Broker {
    async fn confirm(&self, request: ConfirmationRequest) -> ConfirmationDecision {
        // A turn draining into a gated call once the stop began must not
        // hold the stop for a deadline.
        if self.stop.is_cancelled() {
            return ConfirmationDecision::Cancelled;
        }

        let id = ConfirmationId::mint();
        let deadline = Instant::now() + self.wait;
        let wait = i64::try_from(self.wait.as_millis()).unwrap_or(i64::MAX);
        let pending = PendingConfirmation {
            character_id: self.character.clone(),
            id,
            request: ConfirmationQuestion {
                plugin_id: request.plugin_id,
                tool_name: request.tool_name,
                summary: request.summary,
                preview: request.preview,
            },
            deadline_at: Timestamp::now().unix_millis().saturating_add(wait),
            turn: self
                .turn
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone(),
        };
        let (answer, mut answered) = oneshot::channel();

        self.parked().push(Parked {
            pending: pending.clone(),
            answer,
        });
        self.events.emit(Event::ConfirmationRequested(pending));

        let abandoned = Abandoned { broker: self, id };
        let decision = tokio::select! {
            decision = &mut answered => decision,
            () = sleep_until(deadline) => {
                self.settle(id, Settlement::Cancelled { reason: CancelReason::Expired });
                answered.await
            }
            () = self.stop.cancelled() => {
                self.settle(id, Settlement::Cancelled { reason: CancelReason::Stopped });
                answered.await
            }
        };

        drop(abandoned);
        decision.unwrap_or(ConfirmationDecision::Cancelled)
    }
}

/// A question whose call stopped waiting for it, the turn abandoned, is
/// settled cancelled rather than left parked.
struct Abandoned<'a> {
    broker: &'a Broker,
    id: ConfirmationId,
}

impl Drop for Abandoned<'_> {
    fn drop(&mut self) {
        self.broker.settle(
            self.id,
            Settlement::Cancelled {
                reason: CancelReason::Stopped,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU64;

    use p02_contracts::{ToolCallId, TurnIdentity};
    use p02_core::{CharacterProfile, ConversationId, EventIdentity, SessionId, SpeakerName};
    use serde_json::Map;

    use super::*;

    fn mira() -> Identifier {
        Identifier::new("mira").unwrap()
    }

    fn request() -> ConfirmationRequest {
        ConfirmationRequest {
            turn: TurnIdentity {
                session_id: SessionId::new(ConversationId::mint(), NonZeroU64::MIN),
                event: EventIdentity::mint(),
                character: CharacterProfile {
                    id: mira(),
                    display_name: SpeakerName::new("Mira").unwrap(),
                },
            },
            plugin_id: Identifier::new("notes").unwrap(),
            tool_name: Identifier::new("notes.save").unwrap(),
            call_id: ToolCallId::new("call-1").unwrap(),
            summary: "Saves a note.".to_owned(),
            preview: Map::new(),
        }
    }

    /// An answer at or past the deadline the person was shown is expired,
    /// though the timer, on a clock of its own, has not fired, as after a
    /// suspend.
    #[tokio::test(start_paused = true)]
    async fn an_answer_past_the_deadline_shown_is_expired_before_the_timer_fires() {
        let broker = Arc::new(Broker::new(
            mira(),
            Duration::from_millis(10),
            CancellationToken::new(),
            Arc::new(Events::default()),
        ));
        let asking = tokio::spawn({
            let broker = Arc::clone(&broker);

            async move { broker.confirm(request()).await }
        });

        tokio::time::sleep(Duration::from_millis(1)).await;

        let id = broker.pending()[0].id.to_string();

        // The wall clock passes the deadline while the paused timer waits.
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(
            broker.answer(&id, Answer::Approved),
            ConfirmationAnswer::Expired
        );
        assert_eq!(asking.await.unwrap(), ConfirmationDecision::Cancelled);
    }
}
