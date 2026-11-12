//! The one projection of a session log into the turns its model replays:
//! a live turn and a reopened session run it over the same records, so what
//! the model is shown never depends on how the session was reached.

use std::collections::{BTreeMap, HashMap};
use std::num::NonZeroU32;

use p02_contracts::{
    ConversationToolCall, ConversationTurn, DecisionResult, Occasion, Rang, ToolCallId,
    ToolCallResult, ToolRound,
};
use p02_core::{EventId, EventIdentity, TraceId, VisibleMessage, VisibleMessageRole};

use crate::record::{LogRecord, RecordBody, ToolCallStarted};

/// What the model is shown of a session before its next turn.
#[derive(Clone, Debug, PartialEq)]
pub struct ConversationHistory {
    /// The turns carried over from the session this one continues, then
    /// the session's own, oldest first.
    pub turns: Vec<ConversationTurn>,
    /// The earlier conversation, condensed, when the session continues one.
    pub summary: Option<String>,
}

/// One turn's records, gathered as they come.
struct Gathered<'a> {
    identity: &'a EventIdentity,
    /// What its event says began it: a line, unless it says otherwise.
    occasion: Occasion,
    /// What rang on her phone, when its ringing began a moment.
    rang: &'a [Rang],
    user_message: Option<&'a VisibleMessage>,
    replies: Vec<(&'a VisibleMessage, NonZeroU32)>,
    started: Vec<&'a ToolCallStarted>,
    results: HashMap<&'a ToolCallId, &'a ToolCallResult>,
    notes: HashMap<NonZeroU32, &'a str>,
}

/// A turn the person's line began is one once it committed their message,
/// and a moment of the character's own once she said something or a call
/// of hers came back: a moment that did neither is left in the log alone.
/// A moment carries what rang on her phone, as its event says. A round of
/// tool calls is one once a call it started came back, so a call that never
/// answered is never shown to the model.
pub(crate) fn project<'a>(records: impl IntoIterator<Item = &'a LogRecord>) -> ConversationHistory {
    let mut records = records.into_iter().peekable();
    let (mut turns, summary) = match records.peek().map(|record| record.body()) {
        Some(RecordBody::SessionContinued(continued)) => (
            continued.session_continuation.carried_turns().to_vec(),
            Some(continued.session_continuation.summary().to_owned()),
        ),
        _ => (Vec::new(), None),
    };
    let mut gathered: Vec<Gathered<'_>> = Vec::new();
    let mut index: HashMap<(&EventId, &TraceId), usize> = HashMap::new();

    for record in records {
        let identity = record.identity();
        let at = *index
            .entry((identity.event_id(), identity.trace_id()))
            .or_insert_with(|| {
                gathered.push(Gathered {
                    identity,
                    occasion: Occasion::Line,
                    rang: &[],
                    user_message: None,
                    replies: Vec::new(),
                    started: Vec::new(),
                    results: HashMap::new(),
                    notes: HashMap::new(),
                });
                gathered.len() - 1
            });
        let turn = &mut gathered[at];

        match record.body() {
            RecordBody::EventReceived(received) => {
                turn.occasion = received.occasion();
                turn.rang = received.rang();
            }
            RecordBody::MessageCommitted(commit) => match (commit.message().role, commit.round()) {
                (VisibleMessageRole::Character, Some(round)) => {
                    turn.replies.push((commit.message(), round));
                }
                _ => {
                    turn.user_message.get_or_insert(commit.message());
                }
            },
            RecordBody::ModelRound(round) => {
                if let DecisionResult::Accepted { decision } = round.result()
                    && let Some(note) = decision.text()
                {
                    turn.notes.insert(round.round(), note);
                }
            }
            RecordBody::ToolCallStarted(call) => turn.started.push(call),
            RecordBody::ToolCallFinished(call) => {
                turn.results.insert(call.tool_call_id(), call.tool_result());
            }
            _ => {}
        }
    }

    turns.extend(gathered.into_iter().filter_map(Gathered::into_turn));

    ConversationHistory { turns, summary }
}

impl Gathered<'_> {
    fn into_turn(self) -> Option<ConversationTurn> {
        let mut rounds: BTreeMap<NonZeroU32, Vec<ConversationToolCall>> = BTreeMap::new();

        for call in &self.started {
            let Some(result) = self.results.get(call.tool_call_id()) else {
                continue;
            };
            let finished = ConversationToolCall::new(
                call.tool_call_id().clone(),
                call.tool_plugin_id().clone(),
                call.tool_name().clone(),
                call.tool_input().clone(),
                (*result).clone(),
            );

            rounds.entry(call.round()).or_default().push(finished);
        }

        let tool_rounds = rounds
            .iter()
            .map(|(round, calls)| ToolRound {
                round: *round,
                text: self.notes.get(round).map(|note| (*note).to_owned()),
                interim_replies: self
                    .replies
                    .iter()
                    .filter(|(_, said_in)| said_in == round)
                    .map(|(message, _)| (*message).clone())
                    .collect(),
                tool_calls: calls.clone(),
            })
            .collect();
        let final_replies = self
            .replies
            .iter()
            .filter(|(_, said_in)| !rounds.contains_key(said_in))
            .map(|(message, _)| (*message).clone())
            .collect();
        let replayed = match self.occasion {
            Occasion::Line => self.user_message.is_some(),
            Occasion::Moment => !self.replies.is_empty() || !rounds.is_empty(),
        };

        replayed.then(|| ConversationTurn {
            identity: self.identity.clone(),
            user_message: self.user_message.cloned(),
            rang: self.rang.to_vec(),
            tool_rounds,
            final_replies,
        })
    }
}
