//! The drafts one model round speaks, and how each ends.

use std::fmt;
use std::num::NonZeroU32;
use std::sync::{Mutex, PoisonError};

use p02_contracts::ReplyDelta;

use super::TurnSink;

/// The id the draft of one reply carries, written `<round>.<reply>`: its
/// round, and its place among the round's replies, counted from zero.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DraftId {
    round: NonZeroU32,
    reply: usize,
}

impl DraftId {
    #[must_use]
    pub fn round(self) -> NonZeroU32 {
        self.round
    }

    #[must_use]
    pub fn reply(self) -> usize {
        self.reply
    }
}

impl fmt::Display for DraftId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{}", self.round, self.reply)
    }
}

/// What becomes of a draft: a reply the model is still writing, shown
/// before it is said, never a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DraftEvent {
    /// The next piece of the draft, after what came before.
    Delta { draft: DraftId, text: String },
    /// The draft ended unsaid: no commit named it before its round moved
    /// on.
    Withdrawn { draft: DraftId },
}

/// A round's drafts. A draft opens with its first piece and ends once:
/// the commit that names its id replaces it, and closing the round
/// withdraws whatever it opened that no commit named: a refused round's
/// text, a reply whose commit failed, a draft the decision did not make.
#[derive(Debug)]
pub(super) struct Drafts<'s, S> {
    round: NonZeroU32,
    sink: &'s S,
    ledger: Mutex<Ledger>,
}

#[derive(Debug, Default)]
struct Ledger {
    opened: Vec<usize>,
    settled: Vec<usize>,
    closed: bool,
}

impl<'s, S: TurnSink> Drafts<'s, S> {
    pub(super) fn new(round: NonZeroU32, sink: &'s S) -> Self {
        Self {
            round,
            sink,
            ledger: Mutex::default(),
        }
    }

    pub(super) fn round(&self) -> NonZeroU32 {
        self.round
    }

    pub(super) fn id(&self, reply: usize) -> DraftId {
        DraftId {
            round: self.round,
            reply,
        }
    }

    /// Passes a piece of a draft on, opening the draft with its first; a
    /// closed round says nothing more.
    pub(super) fn speak(&self, delta: ReplyDelta) {
        {
            let mut ledger = self.ledger.lock().unwrap_or_else(PoisonError::into_inner);

            if ledger.closed || delta.text.is_empty() {
                return;
            }

            if !ledger.opened.contains(&delta.reply) {
                ledger.opened.push(delta.reply);
            }
        }

        self.sink.draft(DraftEvent::Delta {
            draft: self.id(delta.reply),
            text: delta.text,
        });
    }

    /// The reply was committed under its draft's id.
    pub(super) fn settle(&self, reply: usize) {
        self.ledger
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .settled
            .push(reply);
    }

    /// Withdraws, in the order they opened, the drafts no commit named.
    /// Closing again does nothing.
    pub(super) fn close(&self) {
        let unsaid: Vec<usize> = {
            let mut ledger = self.ledger.lock().unwrap_or_else(PoisonError::into_inner);

            if ledger.closed {
                return;
            }

            ledger.closed = true;
            ledger
                .opened
                .iter()
                .copied()
                .filter(|reply| !ledger.settled.contains(reply))
                .collect()
        };

        for reply in unsaid {
            self.sink.draft(DraftEvent::Withdrawn {
                draft: self.id(reply),
            });
        }
    }
}
