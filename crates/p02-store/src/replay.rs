//! The replay gate: a session's log is valid when every record follows the
//! records before it, and every record enters through the one gate, read
//! back or appended now, checked whole before any of it is taken in.

use std::collections::{BTreeMap, HashMap};
use std::num::NonZeroU32;

use p02_contracts::{DecisionRejectionReason, DecisionResult, ModelToolCall, ToolCallId};
use p02_core::{
    AppendMessageError, ClientStamp, EventId, EventIdentity, MessageId, Session, SessionId,
    Timestamp, TraceId, VisibleText,
};
use p02_shared::Identifier;
use serde_json::{Map, Value};

use crate::history::{ConversationHistory, project};
use crate::record::{
    EventReceived, LogRecord, MessageCommitted, RecordBody, RoundRecord, RuntimeRejection,
    SessionContinuation, ToolCallFinished, ToolCallStarted, TurnCompleted, TurnRejected,
    TurnRejection,
};

/// A session as its log has it: the records that replayed, in order, and
/// the session their visible messages make, each joined through the core
/// session's own gate.
#[derive(Clone, Debug)]
pub struct SessionReplay {
    session: Session,
    records: Vec<LogRecord>,
    turns: Vec<Turn>,
    turn_of: HashMap<(EventId, TraceId), usize>,
    open: Option<usize>,
    calls: HashMap<ToolCallId, Call>,
}

/// Why a record does not follow the records before it.
#[derive(Debug, thiserror::Error)]
pub enum ReplayError {
    #[error("records of event \"{0}\" disagree on when it was created")]
    CreatedAtDiffers(EventId),
    #[error("a session_continued record opens its session, before any other")]
    ContinuationNotFirst,
    #[error("the continuation names session \"{0}\", not its own")]
    ContinuationOfAnotherSession(SessionId),
    #[error("turn \"{0}\" starts a second time")]
    TurnStartedTwice(EventId),
    #[error("event \"{0}\" has no runtime_event_received that starts its turn")]
    NotStarted(EventId),
    #[error("turn \"{0}\" goes on after the record that ended it")]
    AfterEnd(EventId),
    #[error("turn \"{0}\" is not the open turn")]
    Interleaved(EventId),
    #[error("a model round comes after the turn committed the person's line")]
    RoundBeforeLine,
    #[error("model round {round} is out of sequence: the turn has run {ran}")]
    RoundOutOfSequence { round: NonZeroU32, ran: usize },
    #[error(
        "the turn goes on past round {0} before taking up all it gave: every reply it said \
         committed, every call it asked for started and finished"
    )]
    RoundLeftUnfinished(NonZeroU32),
    #[error("the record names model round {round}, which the turn never ran: it has run {ran}")]
    UnknownRound { round: NonZeroU32, ran: usize },
    #[error("a model round was shown another session than its own")]
    EnvelopeOfAnotherSession,
    #[error("a model round was shown another character than the session's")]
    EnvelopeOfAnotherCharacter,
    #[error(
        "a turn's line, as committed and as each round was given it, is the line its event was \
         taken as"
    )]
    InputDisagrees,
    #[error("tool call \"{0}\" starts a second time")]
    CallStartedTwice(ToolCallId),
    #[error("tool call \"{0}\" is not the next call an accepted round of its turn asked for")]
    CallNotAsked(ToolCallId),
    #[error("tool call \"{0}\" finishes but never started")]
    CallNotStarted(ToolCallId),
    #[error("tool call \"{0}\" finishes a second time")]
    CallFinishedTwice(ToolCallId),
    #[error("tool call \"{0}\" finishes as another call than the one that started")]
    CallFinishedOtherwise(ToolCallId),
    #[error("a turn commits exactly one message of the person's, before its replies")]
    UserMessagePlace,
    #[error("message \"{0}\" was not said by an accepted round of its turn")]
    ReplyWithoutAcceptedRound(MessageId),
    #[error("message \"{0}\" is not the next reply its round asked for")]
    ReplyOutOfOrder(MessageId),
    #[error("the session refuses the message")]
    Message(#[source] AppendMessageError),
    #[error("the turn completed with tool call \"{0}\" unfinished")]
    UnfinishedCall(ToolCallId),
    #[error("the record names other messages than its turn committed")]
    MessagesDisagree,
    #[error("the record names other tool calls than its turn finished")]
    CallsDisagree,
    #[error("a completed turn that ran the model judges the round it ended on")]
    Unjudged,
    #[error("the record judges round {round}, not the round the turn ended on, {ran}")]
    JudgedNotLast { round: NonZeroU32, ran: usize },
    #[error("a completed turn ends on a round the parser accepted, which asked for no tool")]
    CompletedOnRefusal,
    #[error("a completed turn anchors the last reply the round it ended on said")]
    AnchorNotSaid,
    #[error(
        "a rejection repeats the refusal of the round it judged, or names a refusal of the \
         runtime itself"
    )]
    RejectionDisagrees,
    #[error(
        "a turn is rejected as \"{0}\" only before it goes further: a line refused before it is \
         committed, a plugin's refusal before any round"
    )]
    RejectionTooLate(&'static str),
    #[error("after_turn_committed follows the record that completed its turn")]
    AfterIncompleteTurn,
}

#[derive(Clone, Debug)]
struct Turn {
    /// When the turn's event was made, which every record of it says.
    created_at: Timestamp,
    /// The line the turn's event was taken as, none when it was refused as
    /// one: the person's message and what each round is given are this one
    /// text.
    input: Option<VisibleText>,
    rounds: Vec<Round>,
    messages: Vec<MessageId>,
    /// The last round a reply was said in, so rows keep their rounds'
    /// order.
    last_reply_round: Option<NonZeroU32>,
    finished: Vec<ToolCallId>,
    unfinished: Vec<ToolCallId>,
    end: Option<End>,
}

/// A round a turn ran: its verdict, and how many of the replies it said
/// and of the calls it asked for the turn has taken up so far, each in the
/// order the round gave them.
#[derive(Clone, Debug)]
struct Round {
    result: DecisionResult,
    replies_said: usize,
    calls_started: usize,
}

impl Round {
    /// Whether the turn has taken up all the round gave: every reply it
    /// said and every call it asked for. A refused round gave nothing.
    fn taken_up(&self) -> bool {
        match &self.result {
            DecisionResult::Rejected { .. } => true,
            DecisionResult::Accepted { decision } => {
                self.replies_said == replies(decision.tool_calls()).count()
                    && self.calls_started == asked(decision.tool_calls()).count()
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum End {
    Completed,
    Rejected,
}

/// A call as it started.
#[derive(Clone, Debug)]
struct Call {
    turn: usize,
    round: NonZeroU32,
    tool_name: Identifier,
    plugin_id: Identifier,
}

/// Where a record goes: it continues the session, starts a turn as it
/// says, or belongs to the turn it names.
#[derive(Clone, Copy, Debug)]
enum Place<'a> {
    Continuation,
    Opening(&'a EventReceived),
    Turn(usize),
}

impl SessionReplay {
    /// A session with no records yet: `session` holds no messages.
    pub(crate) fn new(session: Session) -> Self {
        Self {
            session,
            records: Vec::new(),
            turns: Vec::new(),
            turn_of: HashMap::new(),
            open: None,
            calls: HashMap::new(),
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

    /// The lines the person's client submitted in this session, by the id
    /// it submitted each under, with the message each was committed as.
    #[must_use]
    pub fn user_lines(&self) -> BTreeMap<ClientStamp, MessageId> {
        self.records
            .iter()
            .filter_map(|record| match record.body() {
                RecordBody::MessageCommitted(commit) => commit
                    .client_message_id()
                    .map(|id| (id.clone(), commit.message().id.clone())),
                _ => None,
            })
            .collect()
    }

    /// Takes `record` in after the records before it, or refuses it and
    /// changes nothing: every rule is asked before anything is taken in,
    /// and the session's own gate, the one step that can still refuse,
    /// comes first of what changes.
    pub(crate) fn apply(&mut self, record: LogRecord) -> Result<(), ReplayError> {
        let place = self.check(&record)?;

        if let RecordBody::MessageCommitted(commit) = record.body() {
            self.session
                .append(commit.message().clone())
                .map_err(ReplayError::Message)?;
        }

        self.take(place, &record);
        self.records.push(record);
        Ok(())
    }

    /// Where `record` goes, once it is known to follow the log.
    fn check<'a>(&self, record: &'a LogRecord) -> Result<Place<'a>, ReplayError> {
        let identity = record.identity();
        let key = key_of(identity);

        match record.body() {
            RecordBody::SessionContinued(continued) => {
                self.check_continuation(&continued.session_continuation)?;
                return Ok(Place::Continuation);
            }
            RecordBody::EventReceived(received) => {
                if self.turn_of.contains_key(&key) {
                    return Err(ReplayError::TurnStartedTwice(identity.event_id().clone()));
                }

                return Ok(Place::Opening(received));
            }
            _ => {}
        }

        let index = *self
            .turn_of
            .get(&key)
            .ok_or_else(|| ReplayError::NotStarted(identity.event_id().clone()))?;
        let turn = &self.turns[index];

        if &turn.created_at != identity.created_at() {
            return Err(ReplayError::CreatedAtDiffers(identity.event_id().clone()));
        }

        if let RecordBody::AfterTurnCommitted(_) = record.body() {
            return if turn.end == Some(End::Completed) {
                Ok(Place::Turn(index))
            } else {
                Err(ReplayError::AfterIncompleteTurn)
            };
        }

        if turn.end.is_some() {
            return Err(ReplayError::AfterEnd(identity.event_id().clone()));
        }

        if self.open != Some(index) {
            return Err(ReplayError::Interleaved(identity.event_id().clone()));
        }

        match record.body() {
            RecordBody::ModelRound(round) => self.check_round(turn, round)?,
            RecordBody::ToolCallStarted(call) => self.check_started(turn, call)?,
            RecordBody::ToolCallFinished(call) => self.check_finished(index, turn, call)?,
            RecordBody::MessageCommitted(commit) => check_commit(turn, commit)?,
            RecordBody::TurnCompleted(completed) => check_completed(turn, completed)?,
            RecordBody::TurnRejected(rejected) => check_rejected(turn, rejected)?,
            RecordBody::EventNormalized(_)
            | RecordBody::EventReceived(_)
            | RecordBody::AfterTurnCommitted(_)
            | RecordBody::SessionContinued(_) => {}
        }

        Ok(Place::Turn(index))
    }

    fn check_continuation(&self, continuation: &SessionContinuation) -> Result<(), ReplayError> {
        if !self.records.is_empty() {
            return Err(ReplayError::ContinuationNotFirst);
        }

        if continuation.session_id() != self.session.id() {
            return Err(ReplayError::ContinuationOfAnotherSession(
                continuation.session_id().clone(),
            ));
        }

        Ok(())
    }

    fn check_round(&self, turn: &Turn, round: &RoundRecord) -> Result<(), ReplayError> {
        if turn.messages.is_empty() {
            return Err(ReplayError::RoundBeforeLine);
        }

        if index_of(round.round()) != turn.rounds.len() {
            return Err(ReplayError::RoundOutOfSequence {
                round: round.round(),
                ran: turn.rounds.len(),
            });
        }

        if let Some(before) = NonZeroU32::new(round.round().get() - 1)
            && (!turn.unfinished.is_empty() || !ran(turn, before)?.taken_up())
        {
            return Err(ReplayError::RoundLeftUnfinished(before));
        }

        let envelope = &round.snapshot().input_envelope;

        if envelope.decision_context.session_id() != self.session.id() {
            return Err(ReplayError::EnvelopeOfAnotherSession);
        }

        if envelope.decision_context.character() != self.session.character() {
            return Err(ReplayError::EnvelopeOfAnotherCharacter);
        }

        check_input(turn, &envelope.user_message)
    }

    fn check_started(&self, turn: &Turn, call: &ToolCallStarted) -> Result<(), ReplayError> {
        let round = ran(turn, call.round())?;
        let id = call.tool_call_id();

        if self.calls.contains_key(id) {
            return Err(ReplayError::CallStartedTwice(id.clone()));
        }

        let DecisionResult::Accepted { decision } = &round.result else {
            return Err(ReplayError::CallNotAsked(id.clone()));
        };

        if asked(decision.tool_calls()).nth(round.calls_started)
            != Some((call.tool_name(), call.tool_input()))
        {
            return Err(ReplayError::CallNotAsked(id.clone()));
        }

        Ok(())
    }

    fn check_finished(
        &self,
        index: usize,
        turn: &Turn,
        call: &ToolCallFinished,
    ) -> Result<(), ReplayError> {
        ran(turn, call.round())?;

        let id = call.tool_call_id();
        let started = self
            .calls
            .get(id)
            .ok_or_else(|| ReplayError::CallNotStarted(id.clone()))?;

        if started.turn != index
            || started.round != call.round()
            || &started.tool_name != call.tool_name()
            || &started.plugin_id != call.tool_plugin_id()
        {
            return Err(ReplayError::CallFinishedOtherwise(id.clone()));
        }

        if !turn.unfinished.contains(id) {
            return Err(ReplayError::CallFinishedTwice(id.clone()));
        }

        Ok(())
    }

    /// What `record`, which [`SessionReplay::check`] placed, changes.
    fn take(&mut self, place: Place<'_>, record: &LogRecord) {
        let index = match place {
            Place::Continuation => return,
            Place::Opening(received) => {
                self.open(record.identity(), received);
                return;
            }
            Place::Turn(index) => index,
        };

        match record.body() {
            RecordBody::ModelRound(round) => self.turns[index].rounds.push(Round {
                result: round.result().clone(),
                replies_said: 0,
                calls_started: 0,
            }),
            RecordBody::ToolCallStarted(call) => {
                self.calls.insert(
                    call.tool_call_id().clone(),
                    Call {
                        turn: index,
                        round: call.round(),
                        tool_name: call.tool_name().clone(),
                        plugin_id: call.tool_plugin_id().clone(),
                    },
                );

                let turn = &mut self.turns[index];

                turn.rounds[index_of(call.round())].calls_started += 1;
                turn.unfinished.push(call.tool_call_id().clone());
            }
            RecordBody::ToolCallFinished(call) => {
                let turn = &mut self.turns[index];

                turn.unfinished.retain(|id| id != call.tool_call_id());
                turn.finished.push(call.tool_call_id().clone());
            }
            RecordBody::MessageCommitted(commit) => {
                let turn = &mut self.turns[index];

                turn.messages.push(commit.message().id.clone());

                if let Some(round) = commit.round() {
                    turn.last_reply_round = Some(round);
                    turn.rounds[index_of(round)].replies_said += 1;
                }
            }
            RecordBody::TurnCompleted(_) => self.end(index, End::Completed),
            RecordBody::TurnRejected(_) => self.end(index, End::Rejected),
            RecordBody::EventReceived(_)
            | RecordBody::EventNormalized(_)
            | RecordBody::AfterTurnCommitted(_)
            | RecordBody::SessionContinued(_) => {}
        }
    }

    fn open(&mut self, identity: &EventIdentity, received: &EventReceived) {
        self.turn_of.insert(key_of(identity), self.turns.len());
        self.open = Some(self.turns.len());
        self.turns.push(Turn {
            created_at: identity.created_at().clone(),
            input: received
                .payload_summary
                .normalized_current_user_message
                .clone(),
            rounds: Vec::new(),
            messages: Vec::new(),
            last_reply_round: None,
            finished: Vec::new(),
            unfinished: Vec::new(),
            end: None,
        });
    }

    fn end(&mut self, index: usize, end: End) {
        self.turns[index].end = Some(end);
        self.open = None;
    }
}

fn key_of(identity: &EventIdentity) -> (EventId, TraceId) {
    (identity.event_id().clone(), identity.trace_id().clone())
}

/// Where round `round` is among a turn's rounds, counted from zero.
fn index_of(round: NonZeroU32) -> usize {
    usize::try_from(round.get() - 1).unwrap_or(usize::MAX)
}

/// Round `round` of `turn`, when the turn ran it.
fn ran(turn: &Turn, round: NonZeroU32) -> Result<&Round, ReplayError> {
    turn.rounds
        .get(index_of(round))
        .ok_or(ReplayError::UnknownRound {
            round,
            ran: turn.rounds.len(),
        })
}

fn check_input(turn: &Turn, text: &VisibleText) -> Result<(), ReplayError> {
    if turn.input.as_ref() == Some(text) {
        Ok(())
    } else {
        Err(ReplayError::InputDisagrees)
    }
}

fn check_commit(turn: &Turn, commit: &MessageCommitted) -> Result<(), ReplayError> {
    let message = commit.message();

    match commit.round() {
        None => {
            if !turn.messages.is_empty() {
                return Err(ReplayError::UserMessagePlace);
            }

            check_input(turn, &message.text)
        }
        Some(round) => {
            if turn.messages.is_empty() {
                return Err(ReplayError::UserMessagePlace);
            }

            let ran = ran(turn, round)?;
            let DecisionResult::Accepted { decision } = &ran.result else {
                return Err(ReplayError::ReplyWithoutAcceptedRound(message.id.clone()));
            };
            let next = replies(decision.tool_calls()).nth(ran.replies_said);

            if turn.last_reply_round.is_some_and(|last| round < last) || next != Some(&message.text)
            {
                return Err(ReplayError::ReplyOutOfOrder(message.id.clone()));
            }

            Ok(())
        }
    }
}

fn check_completed(turn: &Turn, completed: &TurnCompleted) -> Result<(), ReplayError> {
    if let Some(unfinished) = turn.unfinished.first() {
        return Err(ReplayError::UnfinishedCall(unfinished.clone()));
    }

    check_summary(
        turn,
        &completed.visible_message_ids,
        &completed.tool_call_ids,
    )?;

    let Some(judgement) = &completed.judgement else {
        return if turn.rounds.is_empty() {
            Ok(())
        } else {
            Err(ReplayError::Unjudged)
        };
    };
    let round = last_round(turn, judgement.round)?;
    let DecisionResult::Accepted { decision } = &round.result else {
        return Err(ReplayError::CompletedOnRefusal);
    };

    if executable(decision.tool_calls()) {
        return Err(ReplayError::CompletedOnRefusal);
    }

    if !round.taken_up() {
        return Err(ReplayError::RoundLeftUnfinished(judgement.round));
    }

    if judgement.accepted_reply.as_ref() == replies(decision.tool_calls()).last() {
        Ok(())
    } else {
        Err(ReplayError::AnchorNotSaid)
    }
}

fn check_rejected(turn: &Turn, rejected: &TurnRejected) -> Result<(), ReplayError> {
    check_summary(turn, &rejected.visible_message_ids, &rejected.tool_call_ids)?;

    let (round, reason) = match rejected.rejection() {
        TurnRejection::Judged { round, reason } => (round, reason),
        TurnRejection::Runtime(rejection) => return check_in_time(turn, rejection),
    };
    let agrees = match &last_round(turn, round)?.result {
        DecisionResult::Rejected { rejection } => {
            rejection.reason == reason
                && rejection.details.as_deref().unwrap_or(reason.as_str()) == rejected.message()
        }
        DecisionResult::Accepted { decision } => {
            reason == DecisionRejectionReason::CommitValidationFailure
                || (reason == DecisionRejectionReason::ToolRoundsExhausted
                    && executable(decision.tool_calls()))
        }
    };

    if agrees {
        Ok(())
    } else {
        Err(ReplayError::RejectionDisagrees)
    }
}

/// The runtime refuses a turn for its own reason only where that reason
/// stops a turn: a line before it is committed, a plugin's refusal before
/// any round, a failure at any point.
fn check_in_time(turn: &Turn, rejection: RuntimeRejection) -> Result<(), ReplayError> {
    let in_time = match rejection {
        RuntimeRejection::InputValidationRejected => turn.messages.is_empty(),
        RuntimeRejection::PluginBeforeRoleModelCallRejected => turn.rounds.is_empty(),
        RuntimeRejection::RuntimeFailure => true,
    };

    if in_time {
        Ok(())
    } else {
        Err(ReplayError::RejectionTooLate(rejection.as_str()))
    }
}

/// A terminal record names exactly what its turn committed and finished,
/// in order.
fn check_summary(
    turn: &Turn,
    messages: &[MessageId],
    calls: &[ToolCallId],
) -> Result<(), ReplayError> {
    if messages != turn.messages {
        return Err(ReplayError::MessagesDisagree);
    }

    if calls != turn.finished {
        return Err(ReplayError::CallsDisagree);
    }

    Ok(())
}

/// The round a terminal record judges, which is the last the turn ran.
fn last_round(turn: &Turn, round: NonZeroU32) -> Result<&Round, ReplayError> {
    if turn.rounds.len().checked_sub(1) != Some(index_of(round)) {
        return Err(ReplayError::JudgedNotLast {
            round,
            ran: turn.rounds.len(),
        });
    }

    ran(turn, round)
}

fn replies(calls: &[ModelToolCall]) -> impl Iterator<Item = &VisibleText> {
    calls.iter().filter_map(|call| match call {
        ModelToolCall::VisibleReply { text } => Some(text),
        ModelToolCall::Plugin { .. } => None,
    })
}

/// The calls of plugin tools a decision asked for, in its order.
fn asked(calls: &[ModelToolCall]) -> impl Iterator<Item = (&Identifier, &Map<String, Value>)> {
    calls.iter().filter_map(|call| match call {
        ModelToolCall::Plugin { name, input } => Some((name, input)),
        ModelToolCall::VisibleReply { .. } => None,
    })
}

fn executable(calls: &[ModelToolCall]) -> bool {
    asked(calls).next().is_some()
}
