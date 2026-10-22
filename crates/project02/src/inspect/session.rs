//! A session's evidence as `inspect` reports it, derived from its records
//! alone: each turn's steps, the messages it committed, what each of its
//! rounds was shown and wrote, the calls they made, what the plugins said
//! and the verdict the turn ended on. Nothing is measured or judged again,
//! so a session reads the same on every run.

use std::num::NonZeroU32;

use p02_contracts::{
    ContextItemKind, DECISION_CONTRACT_VERSION, DecisionResult, Evidence, EvidenceKind,
    EvidenceStatus, HealthSnapshot, HistoryWindow, InputEnvelope, ModelToolCall, PluginContextItem,
    PluginCuratedSection, PolicyOutcome, PromptSize, ProviderExchange, ProviderMetadata,
    RedactionLabel, RuntimeNote, SourceReference, ToolCallId, ToolCallResult,
};
use p02_core::{
    EventId, EventIdentity, MessageId, SessionId, SpeakerName, TraceId, VisibleMessage,
    VisibleMessageRole, VisibleText,
};
use p02_role_model::estimated_tokens;
use p02_shared::Identifier;
use p02_store::{
    LogRecord, RecordBody, RecordKind, RoundRecord, SessionContinuation, SessionEntry,
    SessionReplay, ToolCallFinished, ToolCallStarted, TurnEvidence, TurnRejection, TurnStatus,
};
use serde::Serialize;
use serde_json::{Map, Value};

/// A session as its records have it, beside the entry its catalog keeps.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionReport<'r> {
    session: &'r SessionEntry,
    #[serde(skip_serializing_if = "Option::is_none")]
    continuation: Option<Continuation<'r>>,
    evidence_scopes: EvidenceScopes,
    counts: Counts,
    turns: Vec<Turn<'r>>,
}

/// The segment a session continues, as its first record says it.
#[derive(Debug, Serialize)]
struct Continuation<'r> {
    #[serde(flatten)]
    identity: &'r EventIdentity,
    #[serde(flatten)]
    continuation: &'r SessionContinuation,
}

/// When what the report holds is true: the settings and what they run as
/// they stand now, the session as it was stored, its trace as its log
/// gives it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceScopes {
    runtime_config: &'static str,
    activation: &'static str,
    stored_session_evidence: &'static str,
    trace_evidence: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Counts {
    trace_entries: usize,
    raw_events: usize,
    conversation_messages: usize,
}

/// A turn that ended, by the record that ended it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Turn<'r> {
    event_id: &'r EventId,
    trace_id: &'r TraceId,
    status: Ending,
    steps: Vec<RecordKind>,
    visible_messages: Vec<Message<'r>>,
    model_rounds: Vec<Round<'r>>,
    tool_events: Vec<ToolEvent<'r>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit_validation: Option<CommitValidation<'r>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugin_evidence: Option<PluginEvidence<'r>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'r str>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum Ending {
    Completed,
    CompletedWithFailures,
    Rejected,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Message<'r> {
    id: &'r MessageId,
    role: VisibleMessageRole,
    speaker_name: &'r SpeakerName,
    text: &'r VisibleText,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Round<'r> {
    round: NonZeroU32,
    role_model_evidence: RoundEvidence<'r>,
}

/// What a round was shown, how large its prompt was, what it wrote and
/// what the parser made of that.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoundEvidence<'r> {
    input: Input<'r>,
    prompt_size: Size,
    output: Output<'r>,
    parsed_decision: Decision<'r>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Input<'r> {
    session_id: &'r SessionId,
    allowed_tools: Vec<String>,
    output_contract_version: &'static str,
    current_user_message: &'r VisibleText,
    history_window: &'r HistoryWindow,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_summary: Option<&'r str>,
    runtime_notes: &'r [RuntimeNote],
    curated_context_sections: &'r [PluginCuratedSection],
    plugin_context_items: Vec<ContextItem<'r>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextItem<'r> {
    plugin_id: &'r Identifier,
    id: &'r Identifier,
    kind: ContextItemKind,
    text: &'r str,
    source_references: &'r [SourceReference],
    redaction_labels: &'r [RedactionLabel],
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence: Option<f64>,
}

/// The prompt's size as recorded, each figure beside the tokens it is
/// estimated at.
#[derive(Debug, Serialize)]
struct Size {
    frames: Vec<FrameMeasure>,
    tools: Measure,
    total: Measure,
}

#[derive(Debug, Serialize)]
struct FrameMeasure {
    kind: String,
    count: u64,
    #[serde(flatten)]
    measure: Measure,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Measure {
    chars: u64,
    estimated_tokens: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Output<'r> {
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_output_text: Option<&'r str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_metadata: Option<&'r ProviderMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_exchange: Option<&'r ProviderExchange>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Decision<'r> {
    #[serde(rename_all = "camelCase")]
    Accepted {
        tool_calls: &'r [ModelToolCall],
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<&'r str>,
    },
    #[serde(rename_all = "camelCase")]
    Rejected {
        rejection_reason: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        rejection_details: Option<&'r str>,
    },
}

/// A tool call as it started, with its input, or as it finished, with
/// what came back and the evidence it made.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolEvent<'r> {
    call_id: &'r ToolCallId,
    round: NonZeroU32,
    tool_name: &'r Identifier,
    plugin_id: &'r Identifier,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<&'r Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<CallResult<'r>>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum CallResult<'r> {
    Accepted {
        output: &'r Value,
        evidence: Vec<EvidenceEntry<'r>>,
    },
    Rejected {
        reason: &'r str,
        message: &'r str,
        evidence: Vec<EvidenceEntry<'r>>,
    },
}

/// The verdict on the round the turn ended on: the reply it anchors, or
/// the refusal that ended the turn.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitValidation<'r> {
    round: NonZeroU32,
    status: Verdict,
    #[serde(skip_serializing_if = "Option::is_none")]
    accepted_visible_reply_text: Option<&'r VisibleText>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rejection_reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rejection_details: Option<&'r str>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum Verdict {
    Accepted,
    Rejected,
}

/// What the plugins said of the turn: each step one took, recorded with
/// the turn's ending and after its commit, the outcomes their policies
/// reached, and their health as the turn found it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginEvidence<'r> {
    evidence: Vec<EvidenceEntry<'r>>,
    policy_outcomes: Vec<PolicyOutcome>,
    health: &'r [HealthSnapshot],
}

/// One step a plugin took, without the turn it belongs to, which the
/// report already names.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceEntry<'r> {
    plugin_id: &'r Identifier,
    evidence_kind: EvidenceKind,
    status: EvidenceStatus,
    summary: &'r str,
    redaction_labels: &'r [RedactionLabel],
    #[serde(skip_serializing_if = "Option::is_none")]
    policy_outcome: Option<PolicyOutcome>,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    source_references: &'r [SourceReference],
}

impl<'r> SessionReport<'r> {
    /// The report of the session `entry` lists, which `replay` read back.
    pub(super) fn new(entry: &'r SessionEntry, replay: &'r SessionReplay) -> Self {
        let records = replay.records();
        let continuation = records.first().and_then(|record| match record.body() {
            RecordBody::SessionContinued(continued) => Some(Continuation {
                identity: record.identity(),
                continuation: &continued.session_continuation,
            }),
            _ => None,
        });

        Self {
            session: entry,
            continuation,
            evidence_scopes: EvidenceScopes {
                runtime_config: "current_at_inspection",
                activation: "current_at_inspection",
                stored_session_evidence: "stored_history",
                trace_evidence: "derived_from_event_log",
            },
            counts: Counts {
                trace_entries: records.iter().filter(|record| is_step(record)).count(),
                raw_events: records.len(),
                conversation_messages: replay.session().messages().len(),
            },
            turns: records
                .iter()
                .filter_map(|ending| turn(records, replay.session().messages(), ending))
                .collect(),
        }
    }
}

/// Whether a record is a step of its turn's trace: every record is but
/// what the plugins did once the turn was durable, which lands after it.
fn is_step(record: &LogRecord) -> bool {
    record.kind() != RecordKind::AfterTurnCommitted
}

/// What the record that ended a turn says of it.
struct Ended<'r> {
    status: Ending,
    committed: &'r [MessageId],
    finished: &'r [ToolCallId],
    evidence: &'r [Evidence],
    health: Option<&'r TurnEvidence>,
    verdict: Option<CommitValidation<'r>>,
    /// The reason and the sentence of a rejection.
    refusal: Option<(&'static str, &'r str)>,
}

impl<'r> Ended<'r> {
    /// What `record` says of its turn, when it is a record that ends one.
    fn of(record: &'r LogRecord) -> Option<Self> {
        match record.body() {
            RecordBody::TurnCompleted(completed) => Some(Self {
                status: match completed.status {
                    TurnStatus::Completed => Ending::Completed,
                    TurnStatus::CompletedWithFailures => Ending::CompletedWithFailures,
                },
                committed: &completed.visible_message_ids,
                finished: &completed.tool_call_ids,
                evidence: &completed.runtime_plugin_evidence,
                health: completed.runtime_plugin_turn_evidence.as_ref(),
                verdict: completed
                    .judgement
                    .as_ref()
                    .map(|judgement| CommitValidation {
                        round: judgement.round,
                        status: Verdict::Accepted,
                        accepted_visible_reply_text: judgement.accepted_reply.as_ref(),
                        rejection_reason: None,
                        rejection_details: None,
                    }),
                refusal: None,
            }),
            RecordBody::TurnRejected(rejected) => Some(Self {
                status: Ending::Rejected,
                committed: &rejected.visible_message_ids,
                finished: &rejected.tool_call_ids,
                evidence: &rejected.runtime_plugin_evidence,
                health: rejected.runtime_plugin_turn_evidence.as_ref(),
                verdict: match rejected.rejection() {
                    TurnRejection::Judged { round, reason } => Some(CommitValidation {
                        round,
                        status: Verdict::Rejected,
                        accepted_visible_reply_text: None,
                        rejection_reason: Some(reason.as_str()),
                        rejection_details: Some(rejected.message()),
                    }),
                    TurnRejection::Runtime(_) => None,
                },
                refusal: Some((rejected.rejection().reason(), rejected.message())),
            }),
            _ => None,
        }
    }
}

/// The turn `ending` ends, when it is a record that ends one. Its calls
/// are those it names as finished, and the plugins' evidence is what came
/// with its ending and what they did once it was durable.
fn turn<'r>(
    records: &'r [LogRecord],
    messages: &'r [VisibleMessage],
    ending: &'r LogRecord,
) -> Option<Turn<'r>> {
    let ended = Ended::of(ending)?;
    let identity = ending.identity();
    let own: Vec<&LogRecord> = records
        .iter()
        .filter(|record| same_turn(record.identity(), identity))
        .collect();
    let mut said: Vec<&Evidence> = ended.evidence.iter().collect();

    said.extend(own.iter().flat_map(|record| match record.body() {
        RecordBody::AfterTurnCommitted(after) => after.runtime_plugin_evidence.as_slice(),
        _ => &[],
    }));

    Some(Turn {
        event_id: identity.event_id(),
        trace_id: identity.trace_id(),
        status: ended.status,
        steps: own
            .iter()
            .filter(|record| is_step(record))
            .map(|record| record.kind())
            .collect(),
        visible_messages: ended
            .committed
            .iter()
            .filter_map(|id| messages.iter().find(|message| message.id == *id))
            .map(|message| Message {
                id: &message.id,
                role: message.role,
                speaker_name: &message.speaker_name,
                text: &message.text,
            })
            .collect(),
        model_rounds: own
            .iter()
            .filter_map(|record| match record.body() {
                RecordBody::ModelRound(round) => Some(model_round(round)),
                _ => None,
            })
            .collect(),
        tool_events: own
            .iter()
            .filter_map(|record| match record.body() {
                RecordBody::ToolCallStarted(call)
                    if ended.finished.contains(call.tool_call_id()) =>
                {
                    Some(started(call))
                }
                RecordBody::ToolCallFinished(call)
                    if ended.finished.contains(call.tool_call_id()) =>
                {
                    Some(returned(call))
                }
                _ => None,
            })
            .collect(),
        commit_validation: ended.verdict,
        plugin_evidence: (ended.health.is_some() || !said.is_empty()).then(|| PluginEvidence {
            policy_outcomes: said.iter().fold(Vec::new(), |mut outcomes, evidence| {
                if let Some(outcome) = evidence.policy_outcome()
                    && !outcomes.contains(&outcome)
                {
                    outcomes.push(outcome);
                }

                outcomes
            }),
            evidence: said.into_iter().map(entry).collect(),
            health: ended
                .health
                .map_or(&[], |evidence| evidence.health.as_slice()),
        }),
        reason: ended.refusal.map(|(reason, _)| reason),
        message: ended.refusal.map(|(_, message)| message),
    })
}

/// Records of one turn share its event and its trace.
fn same_turn(record: &EventIdentity, turn: &EventIdentity) -> bool {
    record.event_id() == turn.event_id() && record.trace_id() == turn.trace_id()
}

fn model_round(record: &RoundRecord) -> Round<'_> {
    let snapshot = record.snapshot();

    Round {
        round: record.round(),
        role_model_evidence: RoundEvidence {
            input: input(&snapshot.input_envelope),
            prompt_size: size(&snapshot.prompt_size),
            output: Output {
                raw_output_text: snapshot.raw_output_text.as_deref(),
                provider_metadata: snapshot.provider_metadata.as_ref(),
                provider_exchange: snapshot.provider_exchange.as_ref(),
            },
            parsed_decision: match record.result() {
                DecisionResult::Accepted { decision } => Decision::Accepted {
                    tool_calls: decision.tool_calls(),
                    text: decision.text(),
                },
                DecisionResult::Rejected { rejection } => Decision::Rejected {
                    rejection_reason: rejection.reason.as_str(),
                    rejection_details: rejection.details.as_deref(),
                },
            },
        },
    }
}

fn input(envelope: &InputEnvelope) -> Input<'_> {
    let context = &envelope.decision_context;

    Input {
        session_id: context.session_id(),
        allowed_tools: envelope
            .tool_definitions()
            .into_iter()
            .map(|definition| definition.name)
            .collect(),
        output_contract_version: DECISION_CONTRACT_VERSION,
        current_user_message: &envelope.user_message,
        history_window: context.history_window(),
        context_summary: context.context_summary(),
        runtime_notes: context.runtime_notes(),
        curated_context_sections: context.curated_sections(),
        plugin_context_items: context
            .plugin_context_items()
            .iter()
            .map(context_item)
            .collect(),
    }
}

fn context_item(item: &PluginContextItem) -> ContextItem<'_> {
    let content = item.item();

    ContextItem {
        plugin_id: item.plugin_id(),
        id: content.id(),
        kind: content.kind(),
        text: content.text(),
        source_references: content.source_references(),
        redaction_labels: content.redaction_labels(),
        confidence: content.confidence(),
    }
}

/// Each figure the round recorded, with its estimate, and their sum.
fn size(size: &PromptSize) -> Size {
    let frames: Vec<FrameMeasure> = size
        .frames()
        .iter()
        .map(|frame| FrameMeasure {
            kind: frame.kind.clone(),
            count: frame.count.get(),
            measure: measure(frame.chars.get()),
        })
        .collect();
    let total = frames.iter().map(|frame| frame.measure.chars).sum::<u64>() + size.tool_chars();

    Size {
        frames,
        tools: measure(size.tool_chars()),
        total: measure(total),
    }
}

fn measure(chars: u64) -> Measure {
    Measure {
        chars,
        estimated_tokens: estimated_tokens(chars),
    }
}

fn started(call: &ToolCallStarted) -> ToolEvent<'_> {
    ToolEvent {
        call_id: call.tool_call_id(),
        round: call.round(),
        tool_name: call.tool_name(),
        plugin_id: call.tool_plugin_id(),
        input: Some(call.tool_input()),
        result: None,
    }
}

fn returned(call: &ToolCallFinished) -> ToolEvent<'_> {
    let evidence = || call.evidence().iter().map(entry).collect();

    ToolEvent {
        call_id: call.tool_call_id(),
        round: call.round(),
        tool_name: call.tool_name(),
        plugin_id: call.tool_plugin_id(),
        input: None,
        result: Some(match call.tool_result() {
            ToolCallResult::Accepted { output } => CallResult::Accepted {
                output,
                evidence: evidence(),
            },
            ToolCallResult::Rejected { reason, message } => CallResult::Rejected {
                reason,
                message,
                evidence: evidence(),
            },
        }),
    }
}

fn entry(evidence: &Evidence) -> EvidenceEntry<'_> {
    EvidenceEntry {
        plugin_id: evidence.plugin_id(),
        evidence_kind: evidence.kind(),
        status: evidence.status(),
        summary: evidence.summary(),
        redaction_labels: evidence.redaction_labels(),
        policy_outcome: evidence.policy_outcome(),
        source_references: evidence.source_references(),
    }
}

#[cfg(test)]
mod tests {
    use std::num::{NonZeroU32, NonZeroU64};

    use p02_characters::{CharacterRef, CharacterVersion};
    use p02_contracts::{
        DecisionContext, DecisionResult, Evidence, EvidenceKind, EvidenceNote, EvidenceStatus,
        FrameSize, InputEnvelope, PluginToolDefinitions, PromptSize, RuntimeNote, ToolCallId,
        ToolCallResult,
    };
    use p02_core::{
        CharacterProfile, EventId, EventIdentity, MessageId, Participant, SessionId, SpeakerName,
        Timestamp, TraceId, VisibleMessage, VisibleMessageRole, VisibleText,
    };
    use p02_shared::{Credentials, DanglingLinks, Fingerprint, Identifier, canonical_path};
    use p02_store::{
        AfterTurnCommitted, CharacterData, EventReceived, Home, Judgement, LogRecord,
        MessageCommitted, PayloadSummary, RecordBody, RoundRecord, RoundSnapshot, ToolCallFinished,
        ToolCallStarted, ToolDispatch, TurnCompleted, TurnEvidence, TurnStatus,
    };
    use serde_json::{Value, json};

    use super::SessionReport;

    fn id(text: &str) -> Identifier {
        Identifier::new(text).unwrap()
    }

    fn text(words: &str) -> VisibleText {
        VisibleText::parse(words).unwrap()
    }

    /// A round of `session` shown the person's line and Mira's note, its
    /// prompt one frame of `chars` and no tools, that wrote `raw`.
    fn round(
        session: &SessionId,
        identity: &EventIdentity,
        number: u32,
        chars: u64,
        raw: &Value,
    ) -> RecordBody {
        let mira = CharacterProfile {
            id: id("mira"),
            display_name: SpeakerName::new("Mira").unwrap(),
        };
        let note = RuntimeNote::new(id("current"), "mood=steady")
            .unwrap()
            .with_plugin(id("character-state"));
        let envelope = InputEnvelope::new(
            identity.clone(),
            text("Did we talk about tea?"),
            DecisionContext::new(session.clone(), mira).with_runtime_notes(vec![note]),
            PluginToolDefinitions::default(),
        );
        let snapshot = RoundSnapshot {
            input_envelope: envelope,
            raw_output_text: Some(raw.to_string()),
            character_ref: CharacterRef {
                version: CharacterVersion::new("1.1.0").unwrap(),
                persona_fingerprint: Fingerprint::new(&json!({"persona": ["Kind."]})),
            },
            prompt_size: PromptSize::new(
                vec![FrameSize {
                    kind: "system_protocol".to_owned(),
                    count: NonZeroU64::MIN,
                    chars: NonZeroU64::new(chars).unwrap(),
                }],
                0,
            )
            .unwrap(),
            provider_metadata: None,
            provider_exchange: None,
        };
        let result = DecisionResult::parse(&raw.to_string(), Credentials::Redact);

        RecordBody::ModelRound(Box::new(
            RoundRecord::new(NonZeroU32::new(number).unwrap(), snapshot, result).unwrap(),
        ))
    }

    fn evidence(identity: &EventIdentity, plugin: &str, kind: EvidenceKind) -> Evidence {
        Evidence::new(
            identity.clone(),
            id(plugin),
            EvidenceNote::new(kind, EvidenceStatus::Accepted, "Done."),
            Vec::new(),
        )
        .unwrap()
    }

    /// A session's report is derived from its records alone, read back
    /// through the store: each turn's steps, the messages it committed,
    /// each round with what it was shown, its measures and its verdict, the
    /// calls it made, the verdict the turn ended on and the plugins'
    /// evidence, with the session's counts.
    #[test]
    #[expect(
        clippy::too_many_lines,
        reason = "one recorded session and the whole report it makes, read top to bottom"
    )]
    fn a_session_is_reported_from_its_records_alone() {
        let directory = tempfile::tempdir().unwrap();
        let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());
        let data = CharacterData::ensure(&home, &id("mira")).unwrap();
        let conversation = home
            .ensure_conversation(vec![
                Participant::character(CharacterProfile {
                    id: id("mira"),
                    display_name: SpeakerName::new("Mira").unwrap(),
                }),
                Participant::local_user(SpeakerName::new("Sam").unwrap()),
            ])
            .unwrap();
        let holder = home.conversation_writer(conversation.id()).unwrap();
        let entry = data.create_session(&holder).unwrap();

        holder.release();

        let session = entry.session_id().clone();
        let identity = EventIdentity::new(
            EventId::new("evt_tea").unwrap(),
            TraceId::new("trace_tea").unwrap(),
            Timestamp::new("2026-10-22T08:00:00.000Z").unwrap(),
        )
        .unwrap();
        let message = |number: u64, role, words: &str| VisibleMessage {
            id: MessageId::new(session.clone(), NonZeroU64::new(number).unwrap()),
            role,
            speaker_id: match role {
                VisibleMessageRole::User => Participant::local_user_id().clone(),
                VisibleMessageRole::Character => id("mira"),
            },
            speaker_name: SpeakerName::new(match role {
                VisibleMessageRole::User => "Sam",
                VisibleMessageRole::Character => "Mira",
            })
            .unwrap(),
            text: text(words),
        };
        let search = json!({"toolCalls": [{"name": "sessions.search", "input": {"query": "tea"}}]});
        let answer =
            json!({"toolCalls": [{"name": "visible_reply", "input": {"text": "Not yet."}}]});
        let started = ToolCallStarted::new(
            NonZeroU32::MIN,
            ToolCallId::new("evt_tea.trace_tea.round-1.1.sessions.search").unwrap(),
            id("sessions.search"),
            id("session-history"),
            json!({"query": "tea"}).as_object().unwrap().clone(),
        )
        .unwrap();
        let finished = ToolCallFinished::new(
            &started,
            ToolDispatch::Host,
            ToolCallResult::Accepted {
                output: json!({"sessions": []}),
            },
            vec![evidence(
                &identity,
                "session-history",
                EvidenceKind::ToolInvocation,
            )],
        )
        .unwrap();
        let mut writer = data
            .session_log(&conversation, session.segment())
            .unwrap()
            .writer()
            .unwrap();

        for body in [
            RecordBody::EventReceived(EventReceived {
                payload_summary: PayloadSummary {
                    raw_input: " Did we talk about tea? ".to_owned(),
                    normalized_current_user_message: Some(text("Did we talk about tea?")),
                },
            }),
            RecordBody::MessageCommitted(
                MessageCommitted::user(message(
                    1,
                    VisibleMessageRole::User,
                    "Did we talk about tea?",
                ))
                .unwrap(),
            ),
            round(&session, &identity, 1, 1_201, &search),
            RecordBody::ToolCallStarted(started.clone()),
            RecordBody::ToolCallFinished(finished),
            round(&session, &identity, 2, 1_400, &answer),
            RecordBody::MessageCommitted(
                MessageCommitted::character(
                    message(2, VisibleMessageRole::Character, "Not yet."),
                    NonZeroU32::new(2).unwrap(),
                    Vec::new(),
                )
                .unwrap(),
            ),
            RecordBody::TurnCompleted(TurnCompleted {
                status: TurnStatus::Completed,
                visible_message_ids: vec![
                    MessageId::new(session.clone(), NonZeroU64::MIN),
                    MessageId::new(session.clone(), NonZeroU64::new(2).unwrap()),
                ],
                tool_call_ids: vec![started.tool_call_id().clone()],
                judgement: Some(Judgement {
                    round: NonZeroU32::new(2).unwrap(),
                    accepted_reply: Some(text("Not yet.")),
                }),
                runtime_plugin_evidence: vec![evidence(
                    &identity,
                    "session-history",
                    EvidenceKind::ToolInvocation,
                )],
                runtime_plugin_turn_evidence: Some(TurnEvidence { health: Vec::new() }),
            }),
            RecordBody::AfterTurnCommitted(AfterTurnCommitted {
                status: TurnStatus::Completed,
                runtime_plugin_evidence: vec![evidence(
                    &identity,
                    "mem0",
                    EvidenceKind::AfterTurnCommitted,
                )],
            }),
        ] {
            writer
                .append(LogRecord::new(identity.clone(), body).unwrap())
                .unwrap();
        }

        writer.release();

        let replay = data
            .session_log(&conversation, session.segment())
            .unwrap()
            .read()
            .unwrap();
        let report = serde_json::to_value(SessionReport::new(&entry, &replay)).unwrap();
        let input = json!({
            "sessionId": session,
            "allowedTools": ["visible_reply"],
            "outputContractVersion": "mvp-006.tool_calls.v1",
            "currentUserMessage": "Did we talk about tea?",
            "historyWindow": {"turnEventIds": []},
            "runtimeNotes": [
                {"id": "current", "text": "mood=steady", "pluginId": "character-state"},
            ],
            "curatedContextSections": [],
            "pluginContextItems": [],
        });
        let size = |chars: u64| {
            let tokens = chars.div_ceil(4);

            json!({
                "frames": [{
                    "kind": "system_protocol",
                    "count": 1,
                    "chars": chars,
                    "estimatedTokens": tokens,
                }],
                "tools": {"chars": 0, "estimatedTokens": 0},
                "total": {"chars": chars, "estimatedTokens": tokens},
            })
        };
        let done = |plugin: &str, kind: &str| {
            json!({
                "pluginId": plugin,
                "evidenceKind": kind,
                "status": "accepted",
                "summary": "Done.",
                "redactionLabels": [],
            })
        };
        let call = |event: Value| {
            let mut call = json!({
                "callId": "evt_tea.trace_tea.round-1.1.sessions.search",
                "round": 1,
                "toolName": "sessions.search",
                "pluginId": "session-history",
            });

            call.as_object_mut()
                .unwrap()
                .extend(event.as_object().unwrap().clone());
            call
        };

        assert_eq!(
            report,
            json!({
                "session": entry,
                "evidenceScopes": {
                    "runtimeConfig": "current_at_inspection",
                    "activation": "current_at_inspection",
                    "storedSessionEvidence": "stored_history",
                    "traceEvidence": "derived_from_event_log",
                },
                "counts": {"traceEntries": 8, "rawEvents": 9, "conversationMessages": 2},
                "turns": [{
                    "eventId": "evt_tea",
                    "traceId": "trace_tea",
                    "status": "completed",
                    "steps": [
                        "runtime_event_received",
                        "visible_message_committed",
                        "role_model_round",
                        "tool_call_started",
                        "tool_call_finished",
                        "role_model_round",
                        "visible_message_committed",
                        "runtime_turn_completed",
                    ],
                    "visibleMessages": [
                        {
                            "id": format!("{session}:message-1"),
                            "role": "user",
                            "speakerName": "Sam",
                            "text": "Did we talk about tea?",
                        },
                        {
                            "id": format!("{session}:message-2"),
                            "role": "character",
                            "speakerName": "Mira",
                            "text": "Not yet.",
                        },
                    ],
                    "modelRounds": [
                        {"round": 1, "roleModelEvidence": {
                            "input": input,
                            "promptSize": size(1_201),
                            "output": {"rawOutputText": search.to_string()},
                            "parsedDecision": {
                                "status": "accepted",
                                "toolCalls": search["toolCalls"],
                            },
                        }},
                        {"round": 2, "roleModelEvidence": {
                            "input": input,
                            "promptSize": size(1_400),
                            "output": {"rawOutputText": answer.to_string()},
                            "parsedDecision": {
                                "status": "accepted",
                                "toolCalls": answer["toolCalls"],
                            },
                        }},
                    ],
                    "toolEvents": [
                        call(json!({"input": {"query": "tea"}})),
                        call(json!({"result": {
                            "status": "accepted",
                            "output": {"sessions": []},
                            "evidence": [done("session-history", "tool_invocation")],
                        }})),
                    ],
                    "commitValidation": {
                        "round": 2,
                        "status": "accepted",
                        "acceptedVisibleReplyText": "Not yet.",
                    },
                    "pluginEvidence": {
                        "evidence": [
                            done("session-history", "tool_invocation"),
                            done("mem0", "after_turn_committed"),
                        ],
                        "policyOutcomes": [],
                        "health": [],
                    },
                }],
            })
        );
    }
}
