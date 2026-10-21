//! What the tests build a store from: a canonical temporary home with
//! Mira's conversation, and the records of every kind a turn writes, made
//! as the runtime makes them.

use std::num::{NonZeroU32, NonZeroU64};
use std::path::{Path, PathBuf};

use p02_characters::CharacterVersion;
use p02_contracts::{
    ContextRole, DecisionContext, DecisionRejection, DecisionRejectionReason, DecisionResult,
    Evidence, EvidenceKind, EvidenceNote, EvidenceStatus, ExchangeProvider, ExchangeRecord,
    FrameSize, HealthReport, HealthSnapshot, HealthStatus, InputEnvelope, PluginToolDefinitions,
    PromptSize, ProviderCapabilities, ProviderExchange, ProviderMetadata, ProviderName,
    ReasoningParameterStyle, ToolCallId, ToolCallResult,
};
use p02_core::{
    CharacterProfile, ClientStamp, Conversation, ConversationId, EventId, EventIdentity, MessageId,
    Participant, SessionId, SpeakerName, Timestamp, TraceId, VisibleMessage, VisibleMessageRole,
    VisibleText,
};
use p02_shared::{Credentials, DanglingLinks, Fingerprint, Identifier, canonical_path};
use p02_store::{
    CharacterData, CharacterRef, EventReceived, Home, Judgement, LogRecord, MessageCommitted,
    PayloadSummary, RecordBody, RoundRecord, RoundSnapshot, RuntimeRejection, SessionEntry,
    SessionLog, StorageError, ToolCallFinished, ToolCallStarted, ToolDispatch, TurnCompleted,
    TurnEvidence, TurnRejected, TurnRejection, TurnStatus,
};
use serde_json::{Value, json};
use tempfile::TempDir;

pub(crate) fn id(text: &str) -> Identifier {
    Identifier::new(text).unwrap()
}

pub(crate) fn mira() -> CharacterProfile {
    CharacterProfile {
        id: id("mira"),
        display_name: SpeakerName::new("Mira").unwrap(),
    }
}

/// A home of the test's own, spelled canonically, as the daemon spells its
/// home; the directory goes with it.
pub(crate) struct World {
    _directory: TempDir,
    pub(crate) home: Home,
    pub(crate) data: CharacterData,
    pub(crate) conversation: Conversation,
}

impl World {
    /// A home where Mira has data and her conversation with Sam.
    pub(crate) fn new() -> Self {
        let directory = TempDir::new().unwrap();
        let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());
        let data = CharacterData::ensure(&home, &mira().id).unwrap();
        let conversation = home
            .ensure_conversation(vec![
                Participant::character(mira()),
                Participant::local_user(sam()),
            ])
            .unwrap();

        Self {
            _directory: directory,
            home,
            data,
            conversation,
        }
    }

    /// An empty home, not yet made one.
    pub(crate) fn empty() -> (TempDir, Home) {
        let directory = TempDir::new().unwrap();
        let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());

        (directory, home)
    }

    pub(crate) fn root(&self) -> &Path {
        self.home.root()
    }

    /// Segment `segment` of Mira's conversation with Sam.
    pub(crate) fn segment(&self, segment: u64) -> SessionId {
        SessionId::new(
            self.conversation.id().clone(),
            NonZeroU64::new(segment).unwrap(),
        )
    }

    /// Makes the first segment of `conversation`, as its holder does.
    pub(crate) fn first_segment(
        &self,
        conversation: &ConversationId,
    ) -> Result<SessionEntry, StorageError> {
        let holder = self.home.conversation_writer(conversation).unwrap();
        let made = self.data.create_session(&holder);

        holder.release();
        made
    }

    /// Makes the segment after `from`, as its conversation's holder does.
    pub(crate) fn next_segment(&self, from: &SessionId) -> Result<SessionEntry, StorageError> {
        let holder = self
            .home
            .conversation_writer(from.conversation_id())
            .unwrap();
        let made = self.data.continue_session(&holder, from);

        holder.release();
        made
    }

    /// The log of segment `segment` of Mira's conversation with Sam.
    pub(crate) fn log(&self, segment: u64) -> SessionLog {
        self.log_of(&self.conversation, segment)
    }

    /// Mira's conversation with Sam under the id `id`, held in memory, with
    /// its first segment in her catalog.
    pub(crate) fn conversation_named(&self, id: &str) -> Conversation {
        let conversation = Conversation::new(
            ConversationId::new(id).unwrap(),
            vec![
                Participant::character(mira()),
                Participant::local_user(sam()),
            ],
            Timestamp::new("2026-10-21T00:00:00.000Z").unwrap(),
        )
        .unwrap();

        self.first_segment(conversation.id()).unwrap();
        conversation
    }

    pub(crate) fn log_of(&self, conversation: &Conversation, segment: u64) -> SessionLog {
        self.data
            .session_log(conversation, NonZeroU64::new(segment).unwrap())
            .unwrap()
    }

    pub(crate) fn path_of(&self, session: &SessionId) -> PathBuf {
        self.data
            .root()
            .join("sessions")
            .join(session.to_string())
            .join("raw-events.jsonl")
    }
}

pub(crate) fn sam() -> SpeakerName {
    SpeakerName::new("Sam").unwrap()
}

pub(crate) fn session(text: &str) -> SessionId {
    SessionId::parse(text).unwrap()
}

/// The lines of a file, each without its newline.
pub(crate) fn lines_of(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}

/// The records of one session, made turn by turn as the runtime makes
/// them, each from the parts it would have.
pub(crate) struct Script {
    session: SessionId,
    next_message: u64,
    next_event: u64,
    pub(crate) records: Vec<LogRecord>,
}

/// One turn being written.
pub(crate) struct TurnScript<'a> {
    script: &'a mut Script,
    identity: EventIdentity,
    line: VisibleText,
    rounds: Vec<DecisionResult>,
    messages: Vec<MessageId>,
    started: Vec<ToolCallStarted>,
    finished: Vec<ToolCallId>,
    evidence: Vec<Evidence>,
}

impl Script {
    pub(crate) fn new(session: SessionId) -> Self {
        Self {
            session,
            next_message: 1,
            next_event: 1,
            records: Vec::new(),
        }
    }

    fn identity(&mut self) -> EventIdentity {
        let n = self.next_event;

        self.next_event += 1;

        EventIdentity::new(
            EventId::new(&format!("evt_{n}")).unwrap(),
            TraceId::new(&format!("trace_{n}")).unwrap(),
            Timestamp::new(&format!(
                "2026-10-21T{:02}:{:02}:{:02}.{:03}Z",
                (n / 3600) % 24,
                (n / 60) % 60,
                n % 60,
                n % 1000
            ))
            .unwrap(),
        )
        .unwrap()
    }

    fn message(&mut self, role: VisibleMessageRole, text: &VisibleText) -> VisibleMessage {
        let number = NonZeroU64::new(self.next_message).unwrap();

        self.next_message += 1;

        let (speaker_id, speaker_name) = match role {
            VisibleMessageRole::User => (id("local-user"), sam()),
            VisibleMessageRole::Character => (mira().id, mira().display_name),
        };

        VisibleMessage {
            id: MessageId::new(self.session.clone(), number),
            role,
            speaker_id,
            speaker_name,
            text: text.clone(),
        }
    }

    /// A message number spent by a write that failed: the next one skips it.
    pub(crate) fn skip_message(&mut self) {
        self.next_message += 1;
    }

    pub(crate) fn push(&mut self, identity: &EventIdentity, body: RecordBody) {
        self.records
            .push(LogRecord::new(identity.clone(), body).unwrap());
    }

    /// A turn whose event came in as `raw`, taken as the line it trims to.
    pub(crate) fn turn(&mut self, raw: &str) -> TurnScript<'_> {
        let identity = self.identity();
        let line = VisibleText::normalize(raw).unwrap();

        self.push(
            &identity,
            RecordBody::EventReceived(EventReceived {
                payload_summary: PayloadSummary {
                    raw_input: raw.to_owned(),
                    normalized_current_user_message: Some(line.clone()),
                },
            }),
        );

        TurnScript {
            script: self,
            identity,
            line,
            rounds: Vec::new(),
            messages: Vec::new(),
            started: Vec::new(),
            finished: Vec::new(),
            evidence: Vec::new(),
        }
    }

    /// A line refused as no line: received, then rejected.
    pub(crate) fn refused_input(&mut self, raw: &str) {
        let identity = self.identity();

        self.push(
            &identity,
            RecordBody::EventReceived(EventReceived {
                payload_summary: PayloadSummary {
                    raw_input: raw.to_owned(),
                    normalized_current_user_message: None,
                },
            }),
        );
        self.push(
            &identity,
            RecordBody::TurnRejected(
                TurnRejected::new(
                    TurnRejection::Runtime(RuntimeRejection::InputValidationRejected),
                    "A message must be a single line.".to_owned(),
                )
                .unwrap(),
            ),
        );
    }

    /// The end of a session its plugins recorded.
    pub(crate) fn session_end(&mut self) {
        let identity = self.identity();

        self.push(
            &identity,
            RecordBody::EventReceived(EventReceived {
                payload_summary: PayloadSummary {
                    raw_input: "/exit".to_owned(),
                    normalized_current_user_message: Some(VisibleText::parse("/exit").unwrap()),
                },
            }),
        );

        let evidence = evidence(&identity, "session-history", EvidenceKind::SessionEnd);

        self.push(
            &identity,
            RecordBody::TurnCompleted(TurnCompleted {
                status: TurnStatus::Completed,
                visible_message_ids: Vec::new(),
                tool_call_ids: Vec::new(),
                judgement: None,
                runtime_plugin_evidence: vec![evidence],
                runtime_plugin_turn_evidence: None,
            }),
        );
    }
}

/// A model's answer: replies, then calls of the character-state tool.
pub(crate) fn answer(replies: &[&str], moods: &[&str], note: Option<&str>) -> String {
    let mut calls: Vec<Value> = replies
        .iter()
        .map(|text| json!({"name": "visible_reply", "input": {"text": text}}))
        .collect();

    calls.extend(
        moods
            .iter()
            .map(|mood| json!({"name": "character_state.patch", "input": {"mood": mood}})),
    );

    let mut answer = json!({"toolCalls": calls});

    if let Some(note) = note {
        answer["text"] = json!(note);
    }

    answer.to_string()
}

pub(crate) fn evidence(identity: &EventIdentity, plugin: &str, kind: EvidenceKind) -> Evidence {
    Evidence::new(
        identity.clone(),
        id(plugin),
        EvidenceNote::new(kind, EvidenceStatus::Accepted, "Done."),
        Vec::new(),
    )
    .unwrap()
}

/// What a round recorded beside what it was shown: Mira's content, the
/// prompt's size, and an exchange whose provider echoed a credential.
fn snapshot(envelope: InputEnvelope, raw: Option<String>) -> RoundSnapshot {
    RoundSnapshot {
        input_envelope: envelope,
        raw_output_text: raw,
        character_ref: CharacterRef {
            version: CharacterVersion::new("1.1.0").unwrap(),
            persona_fingerprint: Fingerprint::new(&json!({"persona": {"system": ["Kind."]}})),
        },
        prompt_size: PromptSize::new(
            vec![FrameSize {
                kind: "system_protocol".to_owned(),
                count: NonZeroU64::MIN,
                chars: NonZeroU64::new(2_048).unwrap(),
            }],
            0,
        )
        .unwrap(),
        provider_metadata: Some(ProviderMetadata {
            provider: ProviderName::Nvidia,
            model: Some("nvidia/fixture-model".to_owned()),
            request: None,
            response: None,
            error: None,
        }),
        provider_exchange: Some(exchange()),
    }
}

pub(crate) const ECHOED_CREDENTIAL: &str = "provider-echoed-credential";

fn exchange() -> ProviderExchange {
    ProviderExchange::new(ExchangeRecord {
        provider: ExchangeProvider {
            name: ProviderName::Nvidia,
            model: Some("nvidia/fixture-model".to_owned()),
            endpoint: None,
        },
        capabilities: ProviderCapabilities {
            supports_native_tools: true,
            supports_developer_or_system_context: true,
            preferred_model_context_role: ContextRole::System,
            supports_strict_tool_schema: true,
            supports_reasoning: true,
            reasoning_parameter_style: ReasoningParameterStyle::Nvidia,
            requires_reasoning_block_round_trip: false,
            supports_tool_choice: true,
            supports_parallel_tool_calls: true,
        },
        reasoning_params: json!({}),
        rendered_messages: Vec::new(),
        rendered_tools: Vec::new(),
        tool_name_mappings: Vec::new(),
        request_body: json!({"model": "nvidia/fixture-model", "stream": true}),
        finish_reason: Some("stop".to_owned()),
        usage: Some(json!({
            "prompt_tokens": 1,
            "api_key": ECHOED_CREDENTIAL,
            "nested": {"access_token": ECHOED_CREDENTIAL, "kept": "as is"},
        })),
        native_assistant_message: None,
    })
    .unwrap()
}

impl TurnScript<'_> {
    /// The person's line, stamped by the web page.
    pub(crate) fn user(&mut self, client_message_id: &str) -> &mut Self {
        let line = self.line.clone();
        let message = self.script.message(VisibleMessageRole::User, &line);
        let commit = MessageCommitted::user(message.clone())
            .unwrap()
            .with_source(ClientStamp::new("web").unwrap())
            .unwrap()
            .with_client_message_id(ClientStamp::new(client_message_id).unwrap())
            .unwrap();

        self.messages.push(message.id);
        self.push(RecordBody::MessageCommitted(commit));
        self
    }

    /// A model round that answered `raw`, or nothing when its provider
    /// failed.
    pub(crate) fn round(&mut self, raw: Option<String>) -> &mut Self {
        let round = NonZeroU32::new(u32::try_from(self.rounds.len() + 1).unwrap()).unwrap();
        let result = match &raw {
            Some(raw) => DecisionResult::parse(raw, Credentials::Redact),
            None => DecisionResult::Rejected {
                rejection: DecisionRejection {
                    reason: DecisionRejectionReason::ProviderError,
                    details: Some("The provider answered 503.".to_owned()),
                },
            },
        };
        let envelope = InputEnvelope::new(
            self.identity.clone(),
            self.line.clone(),
            DecisionContext::new(self.script.session.clone(), mira()),
            PluginToolDefinitions::default(),
        );

        self.rounds.push(result.clone());
        self.push(RecordBody::ModelRound(Box::new(
            RoundRecord::new(round, snapshot(envelope, raw), result).unwrap(),
        )));
        self
    }

    fn last_round(&self) -> NonZeroU32 {
        NonZeroU32::new(u32::try_from(self.rounds.len()).unwrap()).unwrap()
    }

    /// The last round's replies, committed in order.
    pub(crate) fn replies(&mut self) -> &mut Self {
        let round = self.last_round();
        let DecisionResult::Accepted { decision } = self.rounds.last().unwrap().clone() else {
            panic!("only an accepted round has replies");
        };

        for call in decision.tool_calls() {
            if let p02_contracts::ModelToolCall::VisibleReply { text } = call {
                let message = self.script.message(VisibleMessageRole::Character, text);
                let evidence = evidence(
                    &self.identity,
                    "character-memory",
                    EvidenceKind::BeforeRoleModelCall,
                );

                self.messages.push(message.id.clone());
                self.push(RecordBody::MessageCommitted(
                    MessageCommitted::character(message, round, vec![evidence]).unwrap(),
                ));
            }
        }

        self
    }

    /// The last round's tool calls, started.
    pub(crate) fn start_calls(&mut self) -> &mut Self {
        let round = self.last_round();
        let DecisionResult::Accepted { decision } = self.rounds.last().unwrap().clone() else {
            panic!("only an accepted round calls tools");
        };

        for (at, call) in decision.tool_calls().iter().enumerate() {
            if let p02_contracts::ModelToolCall::Plugin { name, input } = call {
                let started = ToolCallStarted::new(
                    round,
                    ToolCallId::new(&format!(
                        "{}.{}.round-{round}.{}.{name}",
                        self.identity.event_id(),
                        self.identity.trace_id(),
                        at + 1
                    ))
                    .unwrap(),
                    name.clone(),
                    id("character-state"),
                    input.clone(),
                )
                .unwrap();

                self.started.push(started.clone());
                self.push(RecordBody::ToolCallStarted(started));
            }
        }

        self
    }

    /// Every started call that has not come back, answered.
    pub(crate) fn finish_calls(&mut self) -> &mut Self {
        for started in self.started.clone() {
            if self.finished.contains(started.tool_call_id()) {
                continue;
            }

            let mood = started.tool_input()["mood"].clone();
            let finished = ToolCallFinished::new(
                &started,
                ToolDispatch::Host,
                ToolCallResult::Accepted {
                    output: json!({"applied": {"mood": mood}, "token": "kept-secret"}),
                },
                vec![evidence(
                    &self.identity,
                    "character-state",
                    EvidenceKind::ToolInvocation,
                )],
            )
            .unwrap();

            self.finished.push(started.tool_call_id().clone());
            self.push(RecordBody::ToolCallFinished(finished));
        }

        self
    }

    /// The turn completed on its last round, anchoring the last reply it
    /// said, with the health its plugins reported.
    pub(crate) fn completed(&mut self) {
        let judgement = (!self.rounds.is_empty()).then(|| {
            let DecisionResult::Accepted { decision } = self.rounds.last().unwrap() else {
                panic!("a turn completes on an accepted round");
            };

            Judgement {
                round: self.last_round(),
                accepted_reply: decision
                    .tool_calls()
                    .iter()
                    .rev()
                    .find_map(|call| match call {
                        p02_contracts::ModelToolCall::VisibleReply { text } => Some(text.clone()),
                        p02_contracts::ModelToolCall::Plugin { .. } => None,
                    }),
            }
        });
        let health = HealthSnapshot::new(
            id("mem0"),
            self.identity.created_at().clone(),
            HealthReport {
                status: HealthStatus::Ok,
                summary: "Ready.".to_owned(),
            },
            Vec::new(),
        )
        .unwrap();
        let body = RecordBody::TurnCompleted(TurnCompleted {
            status: TurnStatus::Completed,
            visible_message_ids: self.messages.clone(),
            tool_call_ids: self.finished.clone(),
            judgement,
            runtime_plugin_evidence: std::mem::take(&mut self.evidence),
            runtime_plugin_turn_evidence: Some(TurnEvidence {
                health: vec![health],
            }),
        });

        self.push(body);
    }

    /// The turn rejected as `rejection` says, `message` saying why.
    pub(crate) fn rejected(&mut self, rejection: TurnRejection, message: &str) {
        let mut rejected = TurnRejected::new(rejection, message.to_owned()).unwrap();

        rejected.visible_message_ids.clone_from(&self.messages);
        rejected.tool_call_ids.clone_from(&self.finished);
        self.push(RecordBody::TurnRejected(rejected));
    }

    /// The turn rejected on the verdict of its last round.
    pub(crate) fn rejected_by_its_round(&mut self) {
        let round = self.last_round();
        let (reason, message) = match self.rounds.last().unwrap() {
            DecisionResult::Rejected { rejection } => (
                rejection.reason,
                rejection
                    .details
                    .clone()
                    .unwrap_or_else(|| rejection.reason.as_str().to_owned()),
            ),
            DecisionResult::Accepted { .. } => (
                DecisionRejectionReason::ToolRoundsExhausted,
                "Role model exceeded maximum executable tool rounds (99).".to_owned(),
            ),
        };

        self.rejected(TurnRejection::Judged { round, reason }, &message);
    }

    pub(crate) fn after_commit(&mut self) {
        let evidence = evidence(&self.identity, "mem0", EvidenceKind::AfterTurnCommitted);

        self.push(RecordBody::AfterTurnCommitted(
            p02_store::AfterTurnCommitted {
                status: TurnStatus::CompletedWithFailures,
                runtime_plugin_evidence: vec![evidence],
            },
        ));
    }

    fn push(&mut self, body: RecordBody) {
        let identity = self.identity.clone();

        self.script.push(&identity, body);
    }
}
