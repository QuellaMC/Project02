//! The replay: a session's log read back into the session it makes. A
//! record belongs to the turn its event started, or opens the session as
//! its continuation; one that belongs nowhere, or a message the session
//! refuses, does not fit, so a read skips it and an append refuses it.

use std::collections::{BTreeMap, HashSet};

use p02_contracts::ConversationTurn;
use p02_core::{
    AppendMessageError, ClientStamp, EventId, EventIdentity, MessageId, Session, TraceId,
};

use crate::history::{ConversationHistory, project};
use crate::jsonl::SkippedLines;
use crate::record::{LogRecord, RecordBody};

/// A session as its log has it: the records that fit, in order, the
/// session their visible messages make, and the lines the read skipped.
#[derive(Clone, Debug)]
pub struct SessionReplay {
    session: Session,
    records: Vec<LogRecord>,
    /// The turns the log started, by the identity of each one's event.
    turns: HashSet<(EventId, TraceId)>,
    user_lines: BTreeMap<ClientStamp, MessageId>,
    skipped_lines: SkippedLines,
}

/// Why a record does not fit the records before it.
#[derive(Debug, thiserror::Error)]
pub enum ReplayError {
    #[error("event \"{0}\" started no turn of the session, so no record of it belongs to one")]
    NotStarted(EventId),
    #[error("the session refuses the message")]
    Message(#[source] AppendMessageError),
}

impl SessionReplay {
    /// A session with no records yet: `session` holds no messages.
    pub(crate) fn new(session: Session) -> Self {
        Self {
            session,
            records: Vec::new(),
            turns: HashSet::new(),
            user_lines: BTreeMap::new(),
            skipped_lines: SkippedLines::default(),
        }
    }

    /// The session the log's visible messages make.
    #[must_use]
    pub fn session(&self) -> &Session {
        &self.session
    }

    #[must_use]
    pub fn records(&self) -> &[LogRecord] {
        &self.records
    }

    /// The turns the model replays, and the summary a continued session
    /// opens with: the one projection of the log, whether the session is
    /// running now or was read back.
    #[must_use]
    pub fn history(&self) -> ConversationHistory {
        project(&self.records)
    }

    /// The turn of event `event` as the model replays it, projected from
    /// its records alone; none before the person's line is committed.
    #[must_use]
    pub fn turn(&self, event: &EventIdentity) -> Option<ConversationTurn> {
        project(
            self.records
                .iter()
                .filter(|record| record.identity() == event),
        )
        .turns
        .pop()
    }

    /// The lines the person's client submitted in this session, by the id
    /// it submitted each under, with the message each was first committed
    /// as.
    #[must_use]
    pub fn user_lines(&self) -> &BTreeMap<ClientStamp, MessageId> {
        &self.user_lines
    }

    /// The committed lines of the log its read skipped: each was no
    /// record, or a record that did not fit.
    #[must_use]
    pub fn skipped_lines(&self) -> &SkippedLines {
        &self.skipped_lines
    }

    /// Takes committed line `line` of the log, `bytes`, in, or skips it:
    /// whether it was taken.
    pub(crate) fn read_line(&mut self, line: usize, bytes: &[u8]) -> bool {
        let taken = LogRecord::from_line(bytes).is_ok_and(|record| self.apply(record).is_ok());

        if !taken {
            self.skipped_lines.push(line);
        }

        taken
    }

    /// Takes `record` in after the records before it, or refuses it and
    /// changes nothing.
    pub(crate) fn apply(&mut self, record: LogRecord) -> Result<(), ReplayError> {
        let key = key_of(record.identity());

        match record.body() {
            RecordBody::EventReceived(_) => {
                self.turns.insert(key);
            }
            RecordBody::SessionContinued(_) if self.records.is_empty() => {}
            _ if !self.turns.contains(&key) => {
                return Err(ReplayError::NotStarted(
                    record.identity().event_id().clone(),
                ));
            }
            RecordBody::MessageCommitted(commit) => {
                self.session
                    .append(commit.message().clone())
                    .map_err(ReplayError::Message)?;

                if let Some(stamp) = commit.client_message_id() {
                    self.user_lines
                        .entry(stamp.clone())
                        .or_insert_with(|| commit.message().id.clone());
                }
            }
            _ => {}
        }

        self.records.push(record);
        Ok(())
    }
}

fn key_of(identity: &EventIdentity) -> (EventId, TraceId) {
    (identity.event_id().clone(), identity.trace_id().clone())
}
