//! A turn through to its end, begun by the person's line or by a moment of
//! the character's own: its records in the order they happen, the plugins'
//! hooks around the model's rounds, what the turn announces as it goes,
//! and the session's continuation after it.

use std::num::NonZeroU32;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt as _;
use jiff::Zoned;
use jiff::tz::TimeZone;
use p02_contracts::{
    CharacterDecision, CommittedTurn, ConversationToolCall, ConversationTurn, DecisionContext,
    Evidence, ModelToolCall, Rang, ToolCallId, ToolCallResult, TurnIdentity, TurnText,
};
use p02_core::{
    BlankTextError, ClientStamp, EventIdentity, MessageId, SessionId, SpeakerName, Timestamp,
    UserLine, VisibleMessage,
};
use p02_plugins::{
    BeforeCallOutcome, PhaseStatus, PluginHost, PreparedContext, ProposedToolCall, ToolCallReport,
};
use p02_role_model::{
    DraftEvent, DraftId, ModelRound, Opening, Person, Reply, Rounds, RoutedToolCall, TurnInput,
    TurnOutcome, TurnSink, select_history_window, today_note,
};
use p02_shared::{Identifier, error_chain};
use p02_store::{
    AfterTurnCommitted, ConversationHistory, EventReceived, Judgement, MessageCommitted,
    PayloadSummary, RecordBody, RoundRecord, RuntimeRejection, StorageError, ToolCallFinished,
    ToolCallStarted, TurnCompleted, TurnRejected, TurnRejection, TurnStatus,
};
use tokio::sync::Mutex;
use tokio::task::JoinError;

use crate::continuation;
use crate::conversation::{Character, Delivery, Disk, Mind, Submission, on_disk};

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
        source: ClientStamp,
        client_message_id: ClientStamp,
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
        plugin_id: Identifier,
        tool_name: Identifier,
        accepted: bool,
    },
}

/// A turn that completed.
#[derive(Clone, Debug, PartialEq)]
pub struct CompletedTurn {
    /// What it committed, in the order said: the person's line first, when
    /// a line began it.
    pub messages: Vec<VisibleMessage>,
    /// What failed once the turn was durable, which could change nothing
    /// about it: the plugins' work after the commit or its record, or the
    /// session's continuation.
    pub post_commit_failures: Vec<String>,
}

/// A turn that ended refused, what it committed kept.
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
    #[error("work on the disk did not finish")]
    Interrupted(#[source] JoinError),
    #[error("the conversation lost its hold on the disk to an earlier failure")]
    StateLost,
    #[error("her settings changed to ones that do not build her: {0}")]
    Settings(String),
}

/// The sentence a turn the runtime failed records.
const RUNTIME_FAILURE: &str = "The runtime failed before the turn could complete.";

/// What the person is told of a blank text, which their client shows as it
/// stands.
const BLANK_REFUSAL: &str = "Provide a non-empty message.";

type Listener<'a> = dyn Fn(Progress) + Send + Sync + 'a;

/// What a turn begins from: the person's line, as it came and as it was
/// taken, with the stamps its client put on it; or a moment of her own,
/// which nobody began, with what rang on her phone when its ringing began
/// it.
#[derive(Debug)]
pub(crate) enum Occasion {
    Line {
        raw: String,
        line: UserLine,
        source: ClientStamp,
        client_message_id: ClientStamp,
    },
    Moment(Vec<Rang>),
}

impl Occasion {
    /// What its event records came in.
    fn received(&self) -> EventReceived {
        match self {
            Self::Line { raw, line, .. } => EventReceived::Text(PayloadSummary {
                raw_input: raw.clone(),
                normalized_current_user_message: Some(line.clone().into()),
            }),
            Self::Moment(rang) => EventReceived::Moment(rang.clone()),
        }
    }
}

/// Takes `submission` through the turn its line begins, or refuses a
/// blank text as no line.
pub(crate) async fn take(
    disk: &mut Option<Disk>,
    submission: Submission<'_>,
    character: &Character,
    mind: &mut dyn Mind,
    listener: &Listener<'_>,
) -> Delivery {
    let line = match UserLine::new(submission.line) {
        Ok(line) => line,
        Err(BlankTextError) => return refuse(disk, submission.line).await,
    };
    let occasion = Occasion::Line {
        raw: submission.line.to_owned(),
        line,
        source: submission.source,
        client_message_id: submission.client_message_id,
    };

    run(disk, occasion, character, mind, listener).await
}

/// Takes a turn begun from `occasion` to its end on the thread's `disk`,
/// `character` answering, and after a completed turn continues the session
/// in a new segment when the model's window would no longer hold its
/// history whole.
pub(crate) async fn run(
    disk: &mut Option<Disk>,
    occasion: Occasion,
    character: &Character,
    mind: &mut dyn Mind,
    listener: &Listener<'_>,
) -> Delivery {
    let identity = EventIdentity::mint();
    let person = mind.person().clone();
    let named = match Person::of(&person) {
        Person::Named(name) => Some(name.clone()),
        Person::Unnamed => None,
    };
    let begun = match begin(disk, &identity, occasion, person).await {
        Ok(begun) => begun,
        Err(error) => return failed(disk, &identity, Vec::new(), Vec::new(), error).await,
    };
    let (opening, committed) = match begun.opened {
        Opened::Line {
            message,
            source,
            client_message_id,
        } => {
            listener(Progress::UserMessage {
                message: message.clone(),
                source,
                client_message_id,
            });
            (Opening::Line(message.text.clone()), vec![message])
        }
        Opened::Moment(rang) => {
            let since_last_line = since_last_line(&begun.history.turns, identity.created_at());

            (
                Opening::Moment {
                    since_last_line,
                    rang,
                },
                Vec::new(),
            )
        }
    };
    let window = select_history_window(&begun.history.turns, mind.context_window());
    let mut turn = OpenTurn {
        identity: identity.clone(),
        opening,
        now: begun.now,
        character,
        listener,
        hooks: p02_plugins::Turn::new(TurnIdentity {
            session_id: begun.session,
            event: identity.clone(),
            character: character.profile.clone(),
            person: named,
        }),
        window: window
            .iter()
            .flat_map(ConversationTurn::visible_messages)
            .map(|message| message.id.clone())
            .collect(),
        summary: begun.history.summary.as_deref(),
        ledger: Mutex::new(Ledger {
            disk: disk.take(),
            committed,
            finished: Vec::new(),
            prepared: Vec::new(),
            calls: Vec::new(),
        }),
    };
    let mut delivery = turn.drive(mind, window).await;

    *disk = turn.ledger.into_inner().disk;

    if let Delivery::Completed(completed) = &mut delivery {
        let name = &character.profile.display_name;
        let failure = continuation::rotate(disk, &identity, begun.history, name, mind).await;

        completed.post_commit_failures.extend(failure);
    }

    delivery
}

/// Records a blank text as its event, taken as no line, and the runtime's
/// refusal of it.
async fn refuse(disk: &mut Option<Disk>, raw: &str) -> Delivery {
    let identity = EventIdentity::mint();
    let message = BLANK_REFUSAL.to_owned();
    let refused = {
        let (identity, raw, message) = (identity.clone(), raw.to_owned(), message.clone());

        on_disk(disk, move |disk| {
            disk.append(
                &identity,
                RecordBody::EventReceived(EventReceived::Text(PayloadSummary {
                    raw_input: raw,
                    normalized_current_user_message: None,
                })),
            )?;
            disk.append(
                &identity,
                RecordBody::TurnRejected(TurnRejected::new(
                    TurnRejection::Runtime(RuntimeRejection::InputValidationRejected),
                    message,
                )),
            )
        })
        .await
    };

    match refused {
        Ok(()) => Delivery::InputRejected { message },
        Err(error) => failed(disk, &identity, Vec::new(), Vec::new(), error).await,
    }
}

/// The turn as far as what began it: the session's history, read before
/// anything of the turn is committed, the session it runs in, how it
/// opened, and when it began, where the person is.
struct Begun {
    history: ConversationHistory,
    session: SessionId,
    opened: Opened,
    now: Zoned,
}

/// How a turn opened: with the person's line, committed under the stamps
/// its client put on it, or with a moment of hers, which commits nothing,
/// and what rang when her phone's ringing began it.
enum Opened {
    Line {
        message: VisibleMessage,
        source: ClientStamp,
        client_message_id: ClientStamp,
    },
    Moment(Vec<Rang>),
}

/// Records the event of `occasion`, reads the history, then commits the
/// person's line, said under `person`, when a line began the turn, and
/// reads the machine's time zone, all on the disk's side.
async fn begin(
    disk: &mut Option<Disk>,
    identity: &EventIdentity,
    occasion: Occasion,
    person: SpeakerName,
) -> Result<Begun, RunTurnError> {
    let identity = identity.clone();

    on_disk(disk, move |disk| {
        disk.append(&identity, RecordBody::EventReceived(occasion.received()))?;

        let replay = disk.writer.replay()?;
        let history = replay.history();
        let session = replay.session().id().clone();
        let opened = match occasion {
            Occasion::Line {
                line,
                source,
                client_message_id,
                ..
            } => {
                let message = replay.session().user_message(line, person);

                disk.append(
                    &identity,
                    RecordBody::MessageCommitted(MessageCommitted::user(
                        message.clone(),
                        source.clone(),
                        client_message_id.clone(),
                    )),
                )?;
                Opened::Line {
                    message,
                    source,
                    client_message_id,
                }
            }
            Occasion::Moment(rang) => Opened::Moment(rang),
        };

        Ok(Begun {
            history,
            session,
            opened,
            now: where_they_are(identity.created_at()),
        })
    })
    .await
}

/// How long before `now` the person last wrote: the newest turn of
/// `history` a line began, by its event's time; none when no line is in
/// it.
fn since_last_line(history: &[ConversationTurn], now: &Timestamp) -> Option<Duration> {
    history
        .iter()
        .rev()
        .find(|turn| turn.user_message.is_some())
        .map(|turn| {
            let elapsed = now.unix_millis() - turn.identity.created_at().unix_millis();

            Duration::from_millis(u64::try_from(elapsed).unwrap_or(0))
        })
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
) -> Delivery {
    let identity = identity.clone();
    let _ = on_disk(disk, move |disk| {
        let mut rejected = TurnRejected::new(
            TurnRejection::Runtime(RuntimeRejection::RuntimeFailure),
            RUNTIME_FAILURE.to_owned(),
        );

        rejected.visible_message_ids = committed;
        rejected.tool_call_ids = finished;
        disk.append(&identity, RecordBody::TurnRejected(rejected))
    })
    .await;

    Delivery::Failed(error)
}

/// The turn's `moment` where the person is, by the machine's time zone,
/// which no setting could know better and which is read from the machine's
/// files; a zone that cannot be read is taken as UTC.
fn where_they_are(moment: &Timestamp) -> Zoned {
    moment.in_zone(TimeZone::system())
}

/// A turn from what began it to its end: the hooks' view of it, and what
/// it has committed so far.
struct OpenTurn<'a> {
    identity: EventIdentity,
    opening: Opening,
    /// When it began, where the person is: the day the model is told it
    /// is, first of its notes, and the time a moment's note tells.
    now: Zoned,
    character: &'a Character,
    listener: &'a Listener<'a>,
    /// The turn as its hooks are shown it, without its text: each phase is
    /// shown a clone with the text as it stands then, which shares its
    /// cancellation.
    hooks: p02_plugins::Turn,
    /// The visible messages of the history window the model replays.
    window: Vec<MessageId>,
    /// What the conversation's earlier segments came to, shown ahead of
    /// the turns it replays.
    summary: Option<&'a str>,
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
    async fn drive(&mut self, mind: &mut dyn Mind, window: &[ConversationTurn]) -> Delivery {
        match self.answer(mind, window).await {
            Ok(delivery) => delivery,
            Err(error) => {
                let ledger = self.ledger.get_mut();
                let committed = ids(&ledger.committed);
                let finished = ledger.finished.clone();

                failed(&mut ledger.disk, &self.identity, committed, finished, error).await
            }
        }
    }

    /// The plugins prepare the model's call or refuse the turn; the model's
    /// rounds run to their end, each after the first made with `mind`
    /// brought up to date with her settings; and the record that ends the
    /// turn lands, before the work after its commit.
    async fn answer(
        &mut self,
        mind: &mut dyn Mind,
        window: &[ConversationTurn],
    ) -> Result<Delivery, RunTurnError> {
        let context = match self.prepare(&*mind).await {
            Preparation::Prepared(context) => context,
            Preparation::Refused(rejection) => {
                let refused =
                    TurnRejection::Runtime(RuntimeRejection::PluginBeforeRoleModelCallRejected);

                self.reject(refused, rejection.message.clone(), rejection.evidence)
                    .await?;
                return Ok(Delivery::Rejected(RejectedTurn {
                    reason: refused.reason(),
                    message: rejection.message,
                }));
            }
        };
        let mut rounds = Rounds::new(TurnInput {
            event: self.identity.clone(),
            opening: self.opening.clone(),
            now: self.now.clone(),
            context,
            plugin_tools: mind.host().tool_definitions().clone(),
            history: window,
            persona: &self.character.persona,
        });
        let outcome = loop {
            let round = Round {
                turn: self,
                host: mind.host(),
            };

            if let Some(outcome) = rounds.run(mind.adapter(), &round).await? {
                break outcome;
            }

            if mind.refresh().await.map_err(RunTurnError::Settings)? {
                // A plugin refuses a turn only before its first round, so a
                // refusal now leaves the call prepared as it was, and its
                // records go with what the replies carry.
                match self.prepare(&*mind).await {
                    Preparation::Prepared(context) => {
                        rounds.prepared(context, mind.host().tool_definitions().clone());
                    }
                    Preparation::Refused(rejection) => {
                        self.ledger.lock().await.prepared.extend(rejection.evidence);
                    }
                }
            }
        };

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
                Ok(Delivery::Rejected(RejectedTurn {
                    reason: refused.reason(),
                    message,
                }))
            }
            TurnOutcome::Completed { round, decision } => {
                self.complete(round, &decision, mind.host()).await
            }
        }
    }

    /// The model's call as `mind` stands now: her plugins prepare it, the
    /// day first of its notes and the summary ahead of the replayed turns,
    /// for the person by the name they go by now, what the plugins recorded
    /// kept for the replies to carry; or the refusal of a plugin whose
    /// failure refuses the turn.
    async fn prepare(&self, mind: &dyn Mind) -> Preparation {
        let outcome = mind
            .host()
            .before_role_model_call(&self.shown().await)
            .await;
        let PreparedContext {
            runtime_notes,
            context_items,
            curated_sections,
            evidence,
        } = match outcome {
            BeforeCallOutcome::Prepared(prepared) => prepared,
            BeforeCallOutcome::Rejected(rejection) => return Preparation::Refused(rejection),
        };
        let notes = std::iter::once(today_note(self.now.date()))
            .chain(runtime_notes)
            .collect();
        let mut context =
            DecisionContext::new(self.character.profile.clone(), mind.person().clone())
                .with_runtime_notes(notes)
                .with_plugin_context(context_items, curated_sections);

        if let Some(summary) = self.summary {
            context = context.with_summary(summary);
        }

        self.ledger.lock().await.prepared.extend(evidence);
        Preparation::Prepared(context)
    }

    /// The turn as a phase of hooks is shown it now: the person's line, when
    /// one began it, and the visible messages in the model's sight, the
    /// window's and every one committed so far.
    async fn shown(&self) -> p02_plugins::Turn {
        let ledger = self.ledger.lock().await;
        let recent = self
            .window
            .iter()
            .cloned()
            .chain(ledger.committed.iter().map(|message| message.id.clone()))
            .collect();

        self.hooks.clone().with_text(TurnText {
            current_user_message: self.opening.line().cloned(),
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
        let mut rejected = TurnRejected::new(rejection, message);

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
    /// said, if it said one, then runs the work of `host`'s plugins after
    /// the commit.
    async fn complete(
        &self,
        round: NonZeroU32,
        decision: &CharacterDecision,
        host: &PluginHost,
    ) -> Result<Delivery, RunTurnError> {
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

        let post_commit_failures = self.after_commit(&messages, host).await;

        Ok(Delivery::Completed(CompletedTurn {
            messages,
            post_commit_failures,
        }))
    }

    /// The plugins' work once the turn is durable, which can change nothing
    /// about it: what they record lands as a record of its own, and what
    /// failed is reported.
    async fn after_commit(&self, messages: &[VisibleMessage], host: &PluginHost) -> Vec<String> {
        let committed =
            CommittedTurn::new(self.identity.created_at().clone()).with_messages(messages.to_vec());
        let report = host
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
}

/// A round of the turn: the turn, and the plugins the round's request was
/// made with, which run the calls it makes.
struct Round<'r, 'a> {
    turn: &'r OpenTurn<'a>,
    host: &'r PluginHost,
}

#[async_trait]
impl TurnSink for Round<'_, '_> {
    type Error = RunTurnError;

    async fn record_round(&self, round: &ModelRound) -> Result<(), RunTurnError> {
        let record = RoundRecord::new(round.round, &round.answer, &round.result);

        self.turn.append(RecordBody::ModelRound(record)).await
    }

    async fn commit_reply(&self, reply: Reply<'_>) -> Result<VisibleMessage, RunTurnError> {
        let turn = self.turn;
        let identity = turn.identity.clone();
        let text = reply.text.clone();
        let round = reply.draft.round();
        let mut ledger = turn.ledger.lock().await;
        let evidence = ledger.prepared.clone();
        let name = turn.character.profile.display_name.clone();
        let message = on_disk(&mut ledger.disk, move |disk| {
            let message = disk
                .writer
                .replay()?
                .session()
                .character_message(text, name);

            disk.append(
                &identity,
                RecordBody::MessageCommitted(MessageCommitted::character(
                    message.clone(),
                    round,
                    evidence,
                )),
            )?;
            Ok(message)
        })
        .await?;

        ledger.committed.push(message.clone());
        drop(ledger);
        (turn.listener)(Progress::VisibleReply {
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
        let turn = self.turn;
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
            .collect::<Vec<_>>();

        {
            let identity = turn.identity.clone();
            let records = started.clone();
            let mut ledger = turn.ledger.lock().await;

            on_disk(&mut ledger.disk, move |disk| {
                records
                    .into_iter()
                    .try_for_each(|call| disk.append(&identity, RecordBody::ToolCallStarted(call)))
            })
            .await?;
        }

        (turn.listener)(Progress::ToolCallsRequested {
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
        let shown = turn.shown().await;
        let mut landing = std::pin::pin!(self.host.handle_tool_calls(proposed, &shown));
        let mut landed: Vec<(usize, ToolCallReport)> = Vec::with_capacity(calls.len());

        // Each call is recorded and told finished as it finishes, a quick
        // one before a slow one called ahead of it, so what finished
        // outlasts a crash that comes before the rest.
        while let Some((index, report)) = landing.next().await {
            let call = &calls[index];

            turn.finish(
                ToolCallFinished::new(
                    &started[index],
                    report.result.clone(),
                    report.evidence.clone(),
                ),
                report.evidence.clone(),
            )
            .await?;
            (turn.listener)(Progress::ToolCallCompleted {
                round,
                plugin_id: call.plugin_id().clone(),
                tool_name: call.tool_name().clone(),
                accepted: matches!(report.result, ToolCallResult::Accepted { .. }),
            });
            landed.push((index, report));
        }

        // The model reads the results in the order it called for them.
        landed.sort_by_key(|(index, _)| *index);

        Ok(calls
            .into_iter()
            .zip(landed)
            .map(|(call, (_, report))| call.finish(report.result))
            .collect())
    }

    fn draft(&self, event: DraftEvent) {
        (self.turn.listener)(match event {
            DraftEvent::Delta { draft, text } => Progress::ReplyDelta { draft, text },
            DraftEvent::Withdrawn { draft } => Progress::ReplyWithdrawn { draft },
        });
    }
}

fn ids(messages: &[VisibleMessage]) -> Vec<MessageId> {
    messages.iter().map(|message| message.id.clone()).collect()
}
