//! What the tests build a store from: a canonical temporary home with
//! Mira's conversation, and the records of every kind a turn writes, made
//! as the runtime makes them.

use std::num::{NonZeroU32, NonZeroU64};
use std::path::{Path, PathBuf};

use p02_contracts::{
    DecisionRejectionReason, DecisionResult, Evidence, EvidenceKind, EvidenceNote, EvidenceStatus,
    ModelOutput, ProviderAnswer, ProviderFailure, ToolCallId, ToolCallResult, WrittenCall,
};
use p02_core::{
    CharacterProfile, ClientStamp, Conversation, ConversationId, EventId, EventIdentity, MessageId,
    Participant, SessionId, SpeakerName, Timestamp, TraceId, VisibleMessage, VisibleMessageRole,
    VisibleText,
};
use p02_shared::{DanglingLinks, Identifier, canonical_path};
use p02_store::{
    CharacterData, EventReceived, Home, Judgement, LogRecord, MessageCommitted, PayloadSummary,
    RecordBody, RoundRecord, RuntimeRejection, SessionLog, SessionWriter, StorageError,
    ToolCallFinished, ToolCallStarted, ToolDispatch, TurnCompleted, TurnRejected, TurnRejection,
    TurnStatus,
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
                Participant::character(mira().id),
                Participant::local_user(),
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

    /// Makes the first segment of `conversation`, as its holder does, and
    /// hands back its writer.
    pub(crate) fn first_segment(
        &self,
        conversation: &Conversation,
    ) -> Result<SessionWriter, StorageError> {
        let holder = self.home.conversation_writer(conversation.clone()).unwrap();
        let made = self.data.create_session(&holder);

        holder.release();
        made
    }

    /// Makes the segment after segment `from` of `conversation`, as its
    /// holder does, and hands back its writer.
    pub(crate) fn next_segment(
        &self,
        conversation: &Conversation,
        from: u64,
    ) -> Result<SessionWriter, StorageError> {
        let holder = self.home.conversation_writer(conversation.clone()).unwrap();
        let from = SessionId::new(conversation.id().clone(), NonZeroU64::new(from).unwrap());
        let made = self.data.continue_session(&holder, &from);

        holder.release();
        made
    }

    /// The log of segment `segment` of Mira's conversation with Sam.
    pub(crate) fn log(&self, segment: u64) -> SessionLog {
        self.log_of(&self.conversation, segment)
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

/// Mira's conversation with Sam under the id `id`, held in memory.
pub(crate) fn conversation_named(id: &str) -> Conversation {
    Conversation::new(
        ConversationId::new(id).unwrap(),
        vec![Participant::character(mira().id), Participant::local_user()],
        Timestamp::new("2026-10-21T00:00:00.000Z").unwrap(),
    )
    .unwrap()
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
        self.records.push(LogRecord::new(identity.clone(), body));
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
        }
    }

    /// A blank text refused as no line: received, then rejected.
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
            RecordBody::TurnRejected(TurnRejected::new(
                TurnRejection::Runtime(RuntimeRejection::InputValidationRejected),
                "Provide a non-empty message.".to_owned(),
            )),
        );
    }
}

/// A model's answer: replies, then calls of the character-state tool.
pub(crate) fn answer(replies: &[&str], moods: &[&str], note: Option<&str>) -> ModelOutput {
    let calls = replies
        .iter()
        .map(|text| ("visible_reply", json!({"text": text})))
        .chain(
            moods
                .iter()
                .map(|mood| ("character_state.patch", json!({"mood": mood}))),
        );

    written(calls, note)
}

/// What a model wrote: these calls, each a tool and its input, and `text`.
pub(crate) fn written<'a>(
    calls: impl IntoIterator<Item = (&'a str, Value)>,
    text: Option<&str>,
) -> ModelOutput {
    ModelOutput {
        tool_calls: calls
            .into_iter()
            .map(|(name, input)| WrittenCall {
                name: name.to_owned(),
                input,
            })
            .collect(),
        text: text.map(str::to_owned),
    }
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

impl TurnScript<'_> {
    /// The person's line, stamped by the web page.
    pub(crate) fn user(&mut self, client_message_id: &str) -> &mut Self {
        let line = self.line.clone();
        let message = self.script.message(VisibleMessageRole::User, &line);
        let commit = MessageCommitted::user(
            message.clone(),
            Some(ClientStamp::new("web").unwrap()),
            Some(ClientStamp::new(client_message_id).unwrap()),
        );

        self.messages.push(message.id);
        self.push(RecordBody::MessageCommitted(commit));
        self
    }

    /// A model round that answered `output`, or nothing when its provider
    /// failed.
    pub(crate) fn round(&mut self, output: Option<ModelOutput>) -> &mut Self {
        let round = NonZeroU32::new(u32::try_from(self.rounds.len() + 1).unwrap()).unwrap();
        let answer = match output {
            Some(output) => ProviderAnswer::Answered {
                output,
                finish_reason: Some("stop".to_owned()),
                usage: None,
            },
            None => ProviderAnswer::Failed(ProviderFailure {
                code: "http_error".to_owned(),
                message: "The provider answered 503.".to_owned(),
                status: Some(503),
            }),
        };
        let result = DecisionResult::judge(&answer);

        self.rounds.push(result.clone());
        self.push(RecordBody::ModelRound(RoundRecord::new(
            round, &answer, &result,
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
                self.push(RecordBody::MessageCommitted(MessageCommitted::character(
                    message,
                    round,
                    vec![evidence],
                )));
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
        let Some(DecisionResult::Accepted { decision }) = self.rounds.last() else {
            panic!("a turn completes on an accepted round");
        };
        let judgement = Judgement {
            round: self.last_round(),
            accepted_reply: decision
                .tool_calls()
                .iter()
                .rev()
                .find_map(|call| match call {
                    p02_contracts::ModelToolCall::VisibleReply { text } => Some(text.clone()),
                    p02_contracts::ModelToolCall::Plugin { .. } => None,
                }),
        };
        let body = RecordBody::TurnCompleted(TurnCompleted {
            visible_message_ids: self.messages.clone(),
            tool_call_ids: self.finished.clone(),
            judgement,
            runtime_plugin_evidence: Vec::new(),
        });

        self.push(body);
    }

    /// The turn rejected as `rejection` says, `message` saying why.
    pub(crate) fn rejected(&mut self, rejection: TurnRejection, message: &str) {
        let mut rejected = TurnRejected::new(rejection, message.to_owned());

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
