//! The ledger of submissions: one turn per conversation and client message
//! id within this run of the daemon. A connection can drop after the daemon
//! took a line and before its client heard the outcome; the id is what lets
//! the client ask again without saying the line twice.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use p02_core::{ClientStamp, ConversationId};

use crate::outcome::{TurnOutcome, TurnRefusal};

/// How many settled submissions a conversation remembers; older ones are
/// only turns.
const REMEMBERED: usize = 32;

/// What a client message id was first used for: the same id must mean the
/// same line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Line {
    pub(crate) sender: String,
    pub(crate) source: ClientStamp,
    pub(crate) text: String,
}

#[derive(Debug, Default)]
pub(crate) struct Ledger {
    conversations: Mutex<HashMap<ConversationId, Vec<Submission>>>,
}

/// A submission's turn, which every repeat of it joins, oldest first.
struct Submission {
    id: ClientStamp,
    line: Line,
    outcome: Shared<BoxFuture<'static, TurnOutcome>>,
    settled: bool,
}

impl std::fmt::Debug for Submission {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Submission")
            .field("id", &self.id)
            .field("settled", &self.settled)
            .finish_non_exhaustive()
    }
}

impl Ledger {
    /// The outcome of `line` submitted as `id` on `conversation`, whose turn
    /// `start` begins, once: a repeat joins the turn while it runs and gets
    /// its outcome after, and an id reused for another line is refused, so
    /// no line is ever swallowed by an old one. A new submission's turn is
    /// begun at once, the ledger held, so turns begin in the order their
    /// lines came, and runs as a task of its own, which settles the
    /// submission however it ends: a client that stops waiting abandons
    /// nothing. Only an outcome whose line is in the log is remembered: a
    /// line that never reached the log is its client's to send again, under
    /// the same id.
    pub(crate) fn submit<F>(
        self: &Arc<Self>,
        conversation: ConversationId,
        id: ClientStamp,
        line: Line,
        start: impl FnOnce() -> F,
    ) -> BoxFuture<'static, TurnOutcome>
    where
        F: Future<Output = TurnOutcome> + Send + 'static,
    {
        let mut conversations = self.conversations();
        let submissions = conversations.entry(conversation.clone()).or_default();

        if let Some(known) = submissions.iter().find(|submission| submission.id == id) {
            return if known.line == line {
                known.outcome.clone().boxed()
            } else {
                std::future::ready(reused(&id)).boxed()
            };
        }

        let turn = start();
        let settling = Settling {
            ledger: Arc::clone(self),
            conversation,
            id: id.clone(),
            committed: false,
        };
        let task = tokio::spawn(async move {
            let mut settling = settling;
            let outcome = turn.await;

            settling.committed = outcome.committed();
            outcome
        });
        let outcome = async move { task.await.unwrap_or_else(|_| interrupted()) }
            .boxed()
            .shared();

        submissions.push(Submission {
            id,
            line,
            outcome: outcome.clone(),
            settled: false,
        });
        outcome.boxed()
    }

    fn conversations(&self) -> std::sync::MutexGuard<'_, HashMap<ConversationId, Vec<Submission>>> {
        self.conversations
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Remembers how the submission `id` ended, or forgets it when its line
    /// never reached the log, and lets the oldest settled ones go past the
    /// bound.
    fn settle(&self, conversation: &ConversationId, id: &ClientStamp, committed: bool) {
        let mut conversations = self.conversations();
        let Some(submissions) = conversations.get_mut(conversation) else {
            return;
        };

        if committed {
            if let Some(submission) = submissions
                .iter_mut()
                .find(|submission| submission.id == *id)
            {
                submission.settled = true;
            }
        } else {
            submissions.retain(|submission| submission.id != *id);
        }

        let mut excess = submissions
            .iter()
            .filter(|submission| submission.settled)
            .count()
            .saturating_sub(REMEMBERED);

        submissions.retain(|submission| {
            let forgotten = excess > 0 && submission.settled;

            excess -= usize::from(forgotten);
            !forgotten
        });
    }
}

/// A new submission while its turn runs, settled once the turn's task ends,
/// however it ends, so that no client need still be waiting for it; its
/// outcome is remembered only when its line reached the log.
struct Settling {
    ledger: Arc<Ledger>,
    conversation: ConversationId,
    id: ClientStamp,
    committed: bool,
}

impl Drop for Settling {
    fn drop(&mut self) {
        self.ledger
            .settle(&self.conversation, &self.id, self.committed);
    }
}

fn reused(id: &ClientStamp) -> TurnOutcome {
    TurnOutcome::refused(
        TurnRefusal::InvalidMessage,
        format!(
            "clientMessageId \"{id}\" was already used for a different message on this \
             conversation; give each message its own."
        ),
    )
}

/// What a turn whose task ended before it answered comes to: the line may
/// have landed, and its client asks again under the same id, which the
/// thread then answers.
fn interrupted() -> TurnOutcome {
    TurnOutcome::refused(
        TurnRefusal::CharacterUnavailable,
        "The turn was interrupted before it answered; send the message again.".to_owned(),
    )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use p02_shared::Identifier;
    use tokio::sync::oneshot;

    use super::*;

    fn hello() -> Line {
        Line {
            sender: "local-user".to_owned(),
            source: ClientStamp::new("web").unwrap(),
            text: "Hello.".to_owned(),
        }
    }

    /// A client that stops waiting abandons nothing: the turn runs on and
    /// settles its submission, so a line the turn left out of the log is its
    /// client's to send again under the same id, and runs again.
    #[tokio::test(start_paused = true)]
    async fn a_submission_settles_though_its_client_stopped_waiting() {
        let ledger = Arc::new(Ledger::default());
        let conversation = ConversationId::new("conv_a").unwrap();
        let id = ClientStamp::new("hello").unwrap();
        let (answer, answered) = oneshot::channel();

        drop(ledger.submit(
            conversation.clone(),
            id.clone(),
            hello(),
            move || async move { answered.await.unwrap() },
        ));
        answer
            .send(TurnOutcome::refused(
                TurnRefusal::CharacterUnavailable,
                "Not yet.".to_owned(),
            ))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(1)).await;

        let again = ledger
            .submit(conversation.clone(), id, hello(), move || async move {
                TurnOutcome::Completed {
                    character_id: Identifier::new("mira").unwrap(),
                    conversation_id: conversation,
                    messages: Vec::new(),
                }
            })
            .await;

        assert!(matches!(again, TurnOutcome::Completed { .. }), "{again:?}");
    }
}
