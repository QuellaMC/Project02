//! One line through the turn: its records in the order they happen, the
//! plugins' hooks around the model's rounds, and what the turn announces as
//! it goes.

use std::num::NonZeroU32;

use async_trait::async_trait;
use futures_util::StreamExt as _;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use p02_contracts::{
    BlankContextTextError, CharacterDecision, CommittedTurn, ConversationToolCall,
    ConversationTurn, DecisionContext, Evidence, ModelToolCall, ToolCallId, ToolCallResult,
    TurnIdentity, TurnText,
};
use p02_core::{
    BlankTextError, ClientStamp, EventIdentity, MessageId, Participant, SpeakerName, Timestamp,
    UserLine, VisibleMessage, VisibleText,
};
use p02_plugins::{
    BeforeCallOutcome, PhaseStatus, PluginHost, PreparedContext, ProposedToolCall, ToolCallReport,
};
use p02_role_model::{
    DraftEvent, DraftId, ModelRound, Person, Reply, RoutedToolCall, TurnInput, TurnOutcome,
    TurnSink, run_turn, select_history_window, today_note,
};
use p02_shared::{BoundJsonError, Identifier, error_chain};
use p02_store::{
    AfterTurnCommitted, ConversationHistory, EventReceived, Judgement, MessageCommitted,
    PayloadSummary, RecordBody, RecordError, RoundRecord, RuntimeRejection, StorageError,
    ToolCallFinished, ToolCallStarted, ToolDispatch, TurnCompleted, TurnRejected, TurnRejection,
    TurnStatus,
};
use tokio::sync::Mutex;
use tokio::task::JoinError;

use crate::conversation::{Cast, Disk, Mind, Submission, on_disk};

/// What a turn announces, in order. A message is announced once its record
/// is on disk, so the stream never says more than the log; a draft, a reply
/// the model is still writing, is the one exception and says so by its
/// kind, and every draft ends exactly once, in the reply that names it or
/// in its withdrawal.
#[derive(Clone, Debug, PartialEq)]
pub enum Progress {
    /// The person's line, committed, with the stamps its client put on it.
    UserMessage {
        message: VisibleMessage,
        source: Option<ClientStamp>,
        client_message_id: Option<ClientStamp>,
    },
    /// A reply, committed in place of its draft.
    VisibleReply {
        message: VisibleMessage,
        draft: DraftId,
    },
    /// The next piece of a draft.
    ReplyDelta { draft: DraftId, text: String },
    /// A draft that ended unsaid.
    ReplyWithdrawn { draft: DraftId },
    /// A round's tool calls, recorded as started, in the model's order.
    ToolCallsRequested {
        round: NonZeroU32,
        tool_names: Vec<Identifier>,
    },
    /// A call of the round came back, as its plugin answered or as the
    /// refusal of it.
    ToolCallCompleted {
        round: NonZeroU32,
        tool_name: Identifier,
        accepted: bool,
    },
}

/// A turn that completed.
#[derive(Clone, Debug, PartialEq)]
pub struct CompletedTurn {
    /// What it committed, the person's line first, in the order said.
    pub messages: Vec<VisibleMessage>,
    /// What failed once the turn was durable, which could change nothing
    /// about it: the plugins' work after the commit, or its record.
    pub post_commit_failures: Vec<String>,
}

/// A turn that ended refused, the person's line kept.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RejectedTurn {
    /// The reason its record names.
    pub reason: &'static str,
    pub message: String,
}

/// Why the runtime failed a turn itself.
#[derive(Debug, thiserror::Error)]
pub enum RunTurnError {
    #[error("the session's storage failed")]
    Storage(#[from] StorageError),
    #[error("the turn made a record its log cannot hold")]
    Record(#[from] RecordError),
    #[error("a tool call is past the JSON limits")]
    ToolCall(#[from] BoundJsonError),
    #[error("the earlier conversation's summary is blank")]
    Summary(#[from] BlankContextTextError),
    #[error("work on the disk did not finish")]
    Interrupted(#[source] JoinError),
    #[error("the conversation lost its hold on the disk to an earlier failure")]
    StateLost,
}

/// How a turn ended, for the thread to say.
pub(crate) enum Ended {
    InputRejected { message: String },
    Completed(CompletedTurn),
    Rejected(RejectedTurn),
    Failed(RunTurnError),
}

/// The sentence a turn the runtime failed records.
const RUNTIME_FAILURE: &str = "The runtime failed before the turn could complete.";

/// What the person is told of a blank text, which their client shows as it
/// stands.
const BLANK_REFUSAL: &str = "Provide a non-empty message.";

type Listener<'a> = dyn Fn(Progress) + Send + Sync + 'a;

/// Takes `submission` through the turn under `identity`, on the thread's
/// `disk`.
pub(crate) async fn run(
    disk: &mut Option<Disk>,
    identity: &EventIdentity,
    submission: Submission<'_>,
    cast: &Cast,
    mind: Mind<'_>,
    listener: &Listener<'_>,
) -> Ended {
    let line = match UserLine::new(submission.line) {
        Ok(line) => line,
        Err(BlankTextError) => return refuse(disk, identity, submission.line).await,
    };
    let begun = match begin(disk, identity, &submission, line).await {
        Ok(begun) => begun,
        Err(error) => return failed(disk, identity, Vec::new(), Vec::new(), error).await,
    };

    listener(Progress::UserMessage {
        message: begun.message.clone(),
        source: submission.source,
        client_message_id: submission.client_message_id,
    });

    let window = select_history_window(&begun.history.turns, mind.context_window);
    let mut turn = OpenTurn {
        identity: identity.clone(),
        line: begun.message.text.clone(),
        day: begun.day,
        cast,
        host: mind.host,
        listener,
        hooks: p02_plugins::Turn::new(TurnIdentity {
            session_id: begun.message.id.session_id().clone(),
            event: identity.clone(),
            character: cast.character.clone(),
        }),
        window: window
            .iter()
            .flat_map(ConversationTurn::visible_messages)
            .map(|message| message.id.clone())
            .collect(),
        summary: begun.history.summary,
        ledger: Mutex::new(Ledger {
            disk: disk.take(),
            committed: vec![begun.message],
            finished: Vec::new(),
            prepared: Vec::new(),
            rebuilds: 0,
            calls: Vec::new(),
        }),
    };
    let ended = turn.drive(mind, window).await;

    *disk = turn.ledger.into_inner().disk;
    ended
}

/// The person as the prompt speaks of them: by their name, or as no one in
/// particular while they go by the default.
pub(crate) fn person(name: &SpeakerName) -> Person<'_> {
    if name.as_str() == Participant::DEFAULT_LOCAL_USER_NAME {
        Person::Unnamed
    } else {
        Person::Named(name)
    }
}

/// Records a blank text as its event, taken as no line, and the runtime's
/// refusal of it.
async fn refuse(disk: &mut Option<Disk>, identity: &EventIdentity, raw: &str) -> Ended {
    let message = BLANK_REFUSAL.to_owned();
    let refused = {
        let (identity, raw, message) = (identity.clone(), raw.to_owned(), message.clone());

        on_disk(disk, move |disk| {
            disk.append(
                &identity,
                RecordBody::EventReceived(EventReceived {
                    payload_summary: PayloadSummary {
                        raw_input: raw,
                        normalized_current_user_message: None,
                    },
                }),
            )?;
            disk.append(
                &identity,
                RecordBody::TurnRejected(TurnRejected::new(
                    TurnRejection::Runtime(RuntimeRejection::InputValidationRejected),
                    message,
                )?),
            )
        })
        .await
    };

    match refused {
        Ok(()) => Ended::InputRejected { message },
        Err(error) => failed(disk, identity, Vec::new(), Vec::new(), error).await,
    }
}

/// The turn as far as its line: the history its model is shown, read before
/// the line is committed, the line as committed, and the day it is where
/// the person is.
struct Begun {
    history: ConversationHistory,
    message: VisibleMessage,
    day: Option<Date>,
}

/// Records the event, reads the history, then commits the person's line,
/// and reads the machine's time zone, all on the disk's side.
async fn begin(
    disk: &mut Option<Disk>,
    identity: &EventIdentity,
    submission: &Submission<'_>,
    line: UserLine,
) -> Result<Begun, RunTurnError> {
    let identity = identity.clone();
    let raw = submission.line.to_owned();
    let source = submission.source.clone();
    let client_message_id = submission.client_message_id.clone();

    on_disk(disk, move |disk| {
        disk.append(
            &identity,
            RecordBody::EventReceived(EventReceived {
                payload_summary: PayloadSummary {
                    raw_input: raw,
                    normalized_current_user_message: Some(line.clone().into()),
                },
            }),
        )?;

        let replay = disk.writer.replay()?;
        let history = replay.history();
        let message = replay.session().user_message(line);
        let mut commit = MessageCommitted::user(message.clone())?;

        if let Some(stamp) = source {
            commit = commit.with_source(stamp)?;
        }

        if let Some(stamp) = client_message_id {
            commit = commit.with_client_message_id(stamp)?;
        }

        disk.append(&identity, RecordBody::MessageCommitted(commit))?;
        Ok(Begun {
            history,
            message,
            day: calendar_day(identity.created_at()),
        })
    })
    .await
}

/// The turn failed: its rejection is recorded if it still can be, naming
/// what it committed and finished, so the log says how the turn ended. The
/// failure reported is the turn's, so the record's own is not.
async fn failed(
    disk: &mut Option<Disk>,
    identity: &EventIdentity,
    committed: Vec<MessageId>,
    finished: Vec<ToolCallId>,
    error: RunTurnError,
) -> Ended {
    let identity = identity.clone();
    let _ = on_disk(disk, move |disk| {
        let mut rejected = TurnRejected::new(
            TurnRejection::Runtime(RuntimeRejection::RuntimeFailure),
            RUNTIME_FAILURE.to_owned(),
        )?;

        rejected.visible_message_ids = committed;
        rejected.tool_call_ids = finished;
        disk.append(&identity, RecordBody::TurnRejected(rejected))
    })
    .await;

    Ended::Failed(error)
}

/// The day it is where the person is at `moment`, by the machine's time
/// zone, which no setting could know better and which is read from the
/// machine's files; a zone that cannot be read is taken as UTC.
fn calendar_day(moment: &Timestamp) -> Option<Date> {
    let at = moment.as_str().parse::<jiff::Timestamp>().ok()?;

    Some(at.to_zoned(TimeZone::system()).date())
}

/// A turn from its committed line to its end: the sink of its model's
/// rounds, the hooks' view of it, and what it has committed so far.
struct OpenTurn<'a> {
    identity: EventIdentity,
    line: VisibleText,
    /// The day the model is told it is, first of its notes.
    day: Option<Date>,
    cast: &'a Cast,
    host: &'a PluginHost,
    listener: &'a Listener<'a>,
    /// The turn as its hooks are shown it, without its text: each phase is
    /// shown a clone with the text as it stands then, which shares its
    /// cancellation.
    hooks: p02_plugins::Turn,
    /// The visible messages of the history window the model replays.
    window: Vec<MessageId>,
    /// What the conversation's earlier segments came to, shown ahead of
    /// the turns it replays.
    summary: Option<String>,
    ledger: Mutex<Ledger>,
}

/// What the turn has done so far, and the disk it does it on.
struct Ledger {
    disk: Option<Disk>,
    committed: Vec<VisibleMessage>,
    finished: Vec<ToolCallId>,
    /// What preparing the model's call recorded, which every reply after
    /// it carries.
    prepared: Vec<Evidence>,
    /// The host's rebuilds when the model's call was last prepared.
    rebuilds: u64,
    /// What the tool calls recorded, in the order they finished.
    calls: Vec<Evidence>,
}

/// What the plugins made of the model's call.
enum Preparation {
    Prepared(DecisionContext),
    Refused(p02_plugins::TurnRejection),
}

impl OpenTurn<'_> {
    /// The turn to its end, or, when the runtime fails it, to the record of
    /// that failure.
    async fn drive(&mut self, mind: Mind<'_>, window: &[ConversationTurn]) -> Ended {
        match self.answer(mind, window).await {
            Ok(ended) => ended,
            Err(error) => {
                let ledger = self.ledger.get_mut();
                let committed = ids(&ledger.committed);
                let finished = ledger.finished.clone();

                failed(&mut ledger.disk, &self.identity, committed, finished, error).await
            }
        }
    }

    /// The plugins prepare the model's call or refuse the turn; the model's
    /// rounds run to their end; and the record that ends the turn lands,
    /// before the work after its commit.
    async fn answer(
        &mut self,
        mind: Mind<'_>,
        window: &[ConversationTurn],
    ) -> Result<Ended, RunTurnError> {
        let context = match self.prepare().await? {
            Preparation::Prepared(context) => context,
            Preparation::Refused(rejection) => {
                let refused =
                    TurnRejection::Runtime(RuntimeRejection::PluginBeforeRoleModelCallRejected);

                self.reject(refused, rejection.message.clone(), rejection.evidence)
                    .await?;
                return Ok(Ended::Rejected(RejectedTurn {
                    reason: refused.reason(),
                    message: rejection.message,
                }));
            }
        };
        let outcome = run_turn(
            mind.adapter,
            &*self,
            TurnInput {
                event: self.identity.clone(),
                user_message: self.line.clone(),
                context,
                plugin_tools: self.host.tool_definitions().clone(),
                history: window,
                persona: &self.cast.persona,
                person: person(&self.cast.person),
            },
        )
        .await?;

        match outcome {
            TurnOutcome::Refused { round, rejection } => {
                let refused = TurnRejection::Judged {
                    round,
                    reason: rejection.reason,
                };
                let message = rejection
                    .details
                    .unwrap_or_else(|| rejection.reason.as_str().to_owned());
                let evidence = self.recorded().await;

                self.reject(refused, message.clone(), evidence).await?;
                Ok(Ended::Rejected(RejectedTurn {
                    reason: refused.reason(),
                    message,
                }))
            }
            TurnOutcome::Replied { round, decision } => self.complete(round, &decision).await,
        }
    }

    /// The model's call as the plugins prepare it now, the day first of its
    /// notes and the summary ahead of the replayed turns, what they recorded
    /// kept for the replies to carry; or the refusal of a plugin whose
    /// failure refuses the turn.
    async fn prepare(&self) -> Result<Preparation, RunTurnError> {
        let rebuilds = self.host.rebuilds();
        let outcome = self.host.before_role_model_call(&self.shown().await).await;

        self.ledger.lock().await.rebuilds = rebuilds;

        let PreparedContext {
            runtime_notes,
            context_items,
            curated_sections,
            evidence,
        } = match outcome {
            BeforeCallOutcome::Prepared(prepared) => prepared,
            BeforeCallOutcome::Rejected(rejection) => return Ok(Preparation::Refused(rejection)),
        };
        let notes = self
            .day
            .map(today_note)
            .into_iter()
            .chain(runtime_notes)
            .collect();
        let mut context = DecisionContext::new(self.cast.character.clone())
            .with_runtime_notes(notes)
            .with_plugin_context(context_items, curated_sections);

        if let Some(summary) = &self.summary {
            context = context.with_summary(summary)?;
        }

        self.ledger.lock().await.prepared.extend(evidence);
        Ok(Preparation::Prepared(context))
    }

    /// The turn as a phase of hooks is shown it now: the person's line, and
    /// the visible messages in the model's sight, the window's and every one
    /// committed so far.
    async fn shown(&self) -> p02_plugins::Turn {
        let ledger = self.ledger.lock().await;
        let recent = self
            .window
            .iter()
            .cloned()
            .chain(ledger.committed.iter().map(|message| message.id.clone()))
            .collect();

        self.hooks.clone().with_text(TurnText {
            current_user_message: self.line.clone(),
            recent_visible_message_ids: recent,
        })
    }

    async fn append(&self, body: RecordBody) -> Result<(), RunTurnError> {
        let identity = self.identity.clone();
        let mut ledger = self.ledger.lock().await;

        on_disk(&mut ledger.disk, move |disk| disk.append(&identity, body)).await
    }

    /// Ends the turn rejected as `rejection` says, naming what it committed
    /// and finished.
    async fn reject(
        &self,
        rejection: TurnRejection,
        message: String,
        evidence: Vec<Evidence>,
    ) -> Result<(), RunTurnError> {
        let mut rejected = TurnRejected::new(rejection, message)?;

        {
            let ledger = self.ledger.lock().await;

            rejected.visible_message_ids = ids(&ledger.committed);
            rejected.tool_call_ids = ledger.finished.clone();
        }

        rejected.runtime_plugin_evidence = evidence;
        self.append(RecordBody::TurnRejected(rejected)).await
    }

    /// What the turn's phases recorded so far: the before-call phase's,
    /// then the tool calls', in the order they finished.
    async fn recorded(&self) -> Vec<Evidence> {
        let ledger = self.ledger.lock().await;

        ledger
            .prepared
            .iter()
            .chain(&ledger.calls)
            .cloned()
            .collect()
    }

    /// Ends the turn completed on round `round`, anchoring the last reply it
    /// said, then runs the plugins' work after the commit.
    async fn complete(
        &self,
        round: NonZeroU32,
        decision: &CharacterDecision,
    ) -> Result<Ended, RunTurnError> {
        let accepted_reply = decision
            .tool_calls()
            .iter()
            .rev()
            .find_map(|call| match call {
                ModelToolCall::VisibleReply { text } => Some(text.clone()),
                ModelToolCall::Plugin { .. } => None,
            });
        let evidence = self.recorded().await;
        let (messages, finished) = {
            let ledger = self.ledger.lock().await;

            (ledger.committed.clone(), ledger.finished.clone())
        };

        self.append(RecordBody::TurnCompleted(TurnCompleted {
            visible_message_ids: ids(&messages),
            tool_call_ids: finished,
            judgement: Judgement {
                round,
                accepted_reply,
            },
            runtime_plugin_evidence: evidence,
        }))
        .await?;

        let post_commit_failures = self.after_commit(&messages).await;

        Ok(Ended::Completed(CompletedTurn {
            messages,
            post_commit_failures,
        }))
    }

    /// The plugins' work once the turn is durable, which can change nothing
    /// about it: what they record lands as a record of its own, and what
    /// failed is reported.
    async fn after_commit(&self, messages: &[VisibleMessage]) -> Vec<String> {
        let committed =
            CommittedTurn::new(self.identity.created_at().clone()).with_messages(messages.to_vec());
        let report = self
            .host
            .after_turn_committed(&self.shown().await, &committed)
            .await;
        let mut failed = report.failures();

        if report.status == PhaseStatus::CompletedWithFailures || !report.evidence.is_empty() {
            let status = match report.status {
                PhaseStatus::Completed => TurnStatus::Completed,
                PhaseStatus::CompletedWithFailures => TurnStatus::CompletedWithFailures,
            };

            if let Err(error) = self
                .append(RecordBody::AfterTurnCommitted(AfterTurnCommitted {
                    status,
                    runtime_plugin_evidence: report.evidence,
                }))
                .await
            {
                failed.push(error_chain(&error));
            }
        }

        failed
    }

    /// Records a call that came back, and what it recorded.
    async fn finish(
        &self,
        call: ToolCallFinished,
        evidence: Vec<Evidence>,
    ) -> Result<(), RunTurnError> {
        let identity = self.identity.clone();
        let id = call.tool_call_id().clone();
        let mut ledger = self.ledger.lock().await;

        on_disk(&mut ledger.disk, move |disk| {
            disk.append(&identity, RecordBody::ToolCallFinished(call))
        })
        .await?;
        ledger.finished.push(id);
        ledger.calls.extend(evidence);
        Ok(())
    }

    /// A call of a tool the turn offered is the host's to run; any other
    /// was refused unasked.
    fn dispatch(&self, call: &RoutedToolCall) -> ToolDispatch {
        if self
            .host
            .tool_definitions()
            .get(call.tool_name().as_str())
            .is_some()
        {
            ToolDispatch::Host
        } else {
            ToolDispatch::Undeclared
        }
    }
}

#[async_trait]
impl TurnSink for OpenTurn<'_> {
    type Error = RunTurnError;

    async fn record_round(&self, round: &ModelRound) -> Result<(), RunTurnError> {
        let record = RoundRecord::new(round.round, &round.answer, &round.result);

        self.append(RecordBody::ModelRound(record)).await
    }

    async fn commit_reply(&self, reply: Reply<'_>) -> Result<VisibleMessage, RunTurnError> {
        let identity = self.identity.clone();
        let text = reply.text.clone();
        let round = reply.draft.round();
        let mut ledger = self.ledger.lock().await;
        let evidence = ledger.prepared.clone();
        let message = on_disk(&mut ledger.disk, move |disk| {
            let message = disk.writer.replay()?.session().character_message(text);

            disk.append(
                &identity,
                RecordBody::MessageCommitted(MessageCommitted::character(
                    message.clone(),
                    round,
                    evidence,
                )?),
            )?;
            Ok(message)
        })
        .await?;

        ledger.committed.push(message.clone());
        drop(ledger);
        (self.listener)(Progress::VisibleReply {
            message: message.clone(),
            draft: reply.draft,
        });
        Ok(message)
    }

    async fn run_tool_calls(
        &self,
        round: NonZeroU32,
        calls: Vec<RoutedToolCall>,
    ) -> Result<Vec<ConversationToolCall>, RunTurnError> {
        let started = calls
            .iter()
            .map(|call| {
                ToolCallStarted::new(
                    round,
                    call.call_id().clone(),
                    call.tool_name().clone(),
                    call.plugin_id().clone(),
                    call.input().clone(),
                )
            })
            .collect::<Result<Vec<_>, _>>()?;

        {
            let identity = self.identity.clone();
            let records = started.clone();
            let mut ledger = self.ledger.lock().await;

            on_disk(&mut ledger.disk, move |disk| {
                records
                    .into_iter()
                    .try_for_each(|call| disk.append(&identity, RecordBody::ToolCallStarted(call)))
            })
            .await?;
        }

        (self.listener)(Progress::ToolCallsRequested {
            round,
            tool_names: calls.iter().map(|call| call.tool_name().clone()).collect(),
        });

        let proposed = calls
            .iter()
            .map(|call| ProposedToolCall {
                call_id: call.call_id().clone(),
                tool_name: call.tool_name().clone(),
                input: call.input().clone(),
            })
            .collect();
        let shown = self.shown().await;
        let mut landing = std::pin::pin!(self.host.handle_tool_calls(proposed, &shown));
        let mut landed: Vec<(usize, ToolCallReport)> = Vec::with_capacity(calls.len());

        // Each call is recorded and told finished as it finishes, a quick
        // one before a slow one called ahead of it, so what finished
        // outlasts a crash that comes before the rest.
        while let Some((index, report)) = landing.next().await {
            let call = &calls[index];

            self.finish(
                ToolCallFinished::new(
                    &started[index],
                    self.dispatch(call),
                    report.result.clone(),
                    report.evidence.clone(),
                )?,
                report.evidence.clone(),
            )
            .await?;
            (self.listener)(Progress::ToolCallCompleted {
                round,
                tool_name: call.tool_name().clone(),
                accepted: matches!(report.result, ToolCallResult::Accepted { .. }),
            });
            landed.push((index, report));
        }

        // The model reads the results in the order it called for them.
        landed.sort_by_key(|(index, _)| *index);

        let mut finished = Vec::with_capacity(calls.len());

        for (call, (_, report)) in calls.into_iter().zip(landed) {
            finished.push(call.finish(report.result)?);
        }

        Ok(finished)
    }

    /// The model's call prepared again once a call rebuilt one of the
    /// plugins that prepared it, so the rounds after show what the plugin
    /// now says. A plugin refuses a turn only before its first round, so a
    /// refusal now leaves the call prepared as it was, and its records go
    /// with what the replies carry.
    async fn prepared_again(&self) -> Result<Option<DecisionContext>, RunTurnError> {
        if self.host.rebuilds() == self.ledger.lock().await.rebuilds {
            return Ok(None);
        }

        match self.prepare().await? {
            Preparation::Prepared(context) => Ok(Some(context)),
            Preparation::Refused(rejection) => {
                self.ledger.lock().await.prepared.extend(rejection.evidence);
                Ok(None)
            }
        }
    }

    fn draft(&self, event: DraftEvent) {
        (self.listener)(match event {
            DraftEvent::Delta { draft, text } => Progress::ReplyDelta { draft, text },
            DraftEvent::Withdrawn { draft } => Progress::ReplyWithdrawn { draft },
        });
    }
}

fn ids(messages: &[VisibleMessage]) -> Vec<MessageId> {
    messages.iter().map(|message| message.id.clone()).collect()
}
