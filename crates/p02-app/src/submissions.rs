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
    /// Runs `turn` once for `line` submitted as `id` on `conversation`: a
    /// repeat joins the turn while it runs and gets its outcome after, and
    /// an id reused for another line is refused, so no line is ever
    /// swallowed by an old one. The turn runs as a task of its own, so a
    /// client that stops waiting abandons nothing, and the first to read its
    /// outcome settles it. Only an outcome whose line is in the log is
    /// remembered: a line that never reached the log is its client's to send
    /// again, under the same id.
    pub(crate) async fn submit(
        self: &Arc<Self>,
        conversation: ConversationId,
        id: ClientStamp,
        line: Line,
        turn: impl Future<Output = TurnOutcome> + Send + 'static,
    ) -> TurnOutcome {
        let outcome = {
            let mut conversations = self.conversations();
            let submissions = conversations.entry(conversation.clone()).or_default();

            match submissions.iter().find(|submission| submission.id == id) {
                Some(known) if known.line != line => return reused(&id),
                Some(known) => known.outcome.clone(),
                None => {
                    // The ledger holds this outcome, so the outcome holds the
                    // ledger only weakly.
                    let ledger = Arc::downgrade(self);
                    let settled_id = id.clone();
                    let task = tokio::spawn(turn);
                    let outcome = async move {
                        let outcome = task.await.unwrap_or_else(|_| interrupted());

                        if let Some(ledger) = ledger.upgrade() {
                            ledger.settle(&conversation, &settled_id, &outcome);
                        }

                        outcome
                    }
                    .boxed()
                    .shared();

                    submissions.push(Submission {
                        id,
                        line,
                        outcome: outcome.clone(),
                        settled: false,
                    });
                    outcome
                }
            }
        };

        outcome.await
    }

    fn conversations(&self) -> std::sync::MutexGuard<'_, HashMap<ConversationId, Vec<Submission>>> {
        self.conversations
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Remembers how the submission `id` ended, or forgets it when its line
    /// never reached the log, and lets the oldest settled ones go past the
    /// bound.
    fn settle(&self, conversation: &ConversationId, id: &ClientStamp, outcome: &TurnOutcome) {
        let mut conversations = self.conversations();
        let Some(submissions) = conversations.get_mut(conversation) else {
            return;
        };

        if outcome.committed() {
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
