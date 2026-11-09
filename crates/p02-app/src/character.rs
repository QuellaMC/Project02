//! One actor per character: a task owning everything of hers, her state,
//! the parts she is assembled from, her thread with the person and her
//! confirmations, which answers what it is asked in the order it was asked
//! and between two steps reads whether she is to stop.

use std::collections::VecDeque;
use std::future::Future;
use std::num::NonZeroU64;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use p02_characters::{CharacterDefinition, discover};
use p02_config::{
    CharacterSettings, Diagnostic, HostSettings, MaterializeError, ReadSettingsError, Resolution,
    RoleModelProvider, materialize,
};
use p02_contracts::{RoleModelAdapter, TurnIdentity, vocabulary};
use p02_core::{ConversationId, EventIdentity, Participant, SessionId, SpeakerName, Timestamp};
use p02_plugins::{PluginHost, Turn};
use p02_role_model::{NvidiaSettings, select_adapter};
use p02_runtime::{
    Character, CompletedTurn, Conversation, Delivery, Progress, Rotation, Submission,
};
use p02_shared::{Identifier, error_sentence};
use p02_store::{RuntimeRejection, StorageError};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::config_control::CharacterConfig;
use crate::confirmation::Broker;
use crate::daemon::{Daemon, WeakDaemon, World, blocking};
use crate::outcome::{
    Event, MaintenanceFailure, OpenOutcome, OpenRefusal, StorageFailure, TurnOutcome, TurnRefusal,
    TurnStamp,
};

/// The sentence a character without a model gives, which the settings
/// page answers.
const NO_PROVIDER: &str = "No model provider is chosen. Choose one on the settings page.";

vocabulary! {
    /// Where a character's runtime stands. `reloading` is a pause: a
    /// delivery sent meanwhile waits for it and lands on the same thread.
    #[ts(rename = "CharacterRuntimeState")]
    #[schemars(rename = "CharacterRuntimeState")]
    CharacterState {
        Starting = "starting",
        Ready = "ready",
        Reloading = "reloading",
        Stopping = "stopping",
        Stopped = "stopped",
        Failed = "failed",
    }
}

/// What a character's actor publishes of her, read without a round trip.
#[derive(Clone, Debug)]
pub(crate) struct CharacterHealth {
    pub(crate) state: CharacterState,
    /// Why she failed, while she is failed; what her start warned of, while
    /// she is ready.
    pub(crate) diagnostic: Option<String>,
    pub(crate) maintenance: Option<MaintenanceFailure>,
}

/// What a character was built from, her package and her settings: what a
/// later reconcile compares, her plugins as her host serves them, with
/// what she would be built from now, to decide a reload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Built {
    pub(crate) definition: CharacterDefinition,
    pub(crate) settings: CharacterSettings,
}

/// A line of the person's for a character, as the daemon routed it to her.
#[derive(Debug)]
pub(crate) struct Request {
    pub(crate) stamp: TurnStamp,
    pub(crate) text: String,
}

#[derive(Debug)]
enum Command {
    /// Answered once her start settles, whichever start that is.
    Start(oneshot::Sender<()>),
    Open(oneshot::Sender<OpenOutcome>),
    Deliver(Request, oneshot::Sender<TurnOutcome>),
    Reconcile(Option<Box<Built>>, oneshot::Sender<()>),
}

/// The daemon's hold on one actor: what it asks her, her health as she
/// last published it, the stop she watches and the confirmations she
/// parks. An actor lives from her start to her stop.
#[derive(Debug)]
pub(crate) struct CharacterHandle {
    id: Identifier,
    commands: mpsc::UnboundedSender<Command>,
    health: watch::Receiver<CharacterHealth>,
    stop: CancellationToken,
    broker: Arc<Broker>,
}

impl CharacterHandle {
    /// A new actor for character `id` of `daemon`, who starts at once.
    pub(crate) fn spawn(daemon: &Daemon, id: Identifier) -> Self {
        let world = Arc::clone(daemon.world());
        let (commands, receiver) = mpsc::unbounded_channel();
        let (published, health) = watch::channel(CharacterHealth {
            state: CharacterState::Starting,
            diagnostic: None,
            maintenance: None,
        });
        let stop = CancellationToken::new();
        let broker = Arc::new(Broker::new(
            id.clone(),
            world.durations.confirmation,
            stop.clone(),
            Arc::clone(&world.events),
        ));

        tokio::spawn(
            Actor {
                id: id.clone(),
                world,
                daemon: daemon.downgrade(),
                commands: receiver,
                deferred: VecDeque::new(),
                stop: stop.clone(),
                health: published,
                broker: Arc::clone(&broker),
                parts: None,
            }
            .run(),
        );

        Self {
            id,
            commands,
            health,
            stop,
            broker,
        }
    }

    pub(crate) fn id(&self) -> &Identifier {
        &self.id
    }

    pub(crate) fn health(&self) -> CharacterHealth {
        self.health.borrow().clone()
    }

    pub(crate) fn broker(&self) -> &Broker {
        &self.broker
    }

    /// Whether her stop has begun: she takes nothing more.
    pub(crate) fn ended(&self) -> bool {
        self.commands.is_closed()
    }

    /// Whether her actor is gone: stopped, or ended without saying so.
    pub(crate) fn gone(&self) -> bool {
        self.health.borrow().state == CharacterState::Stopped || self.health.has_changed().is_err()
    }

    /// Answered once her start settles. One in flight, a boot or a reload,
    /// is joined, so a failure it ends in is answered and not tried again;
    /// otherwise she is asked, and boots again when she has failed.
    pub(crate) async fn start(&self) {
        let assembling = |health: &CharacterHealth| {
            matches!(
                health.state,
                CharacterState::Starting | CharacterState::Reloading
            )
        };
        let mut health = self.health.clone();

        if assembling(&health.borrow()) {
            let _ = health.wait_for(|health| !assembling(health)).await;
        } else {
            let _ = self.ask(Command::Start).await;
        }
    }

    pub(crate) async fn open(&self) -> OpenOutcome {
        self.ask(Command::Open)
            .await
            .unwrap_or_else(|_| OpenOutcome::Refused {
                reason: OpenRefusal::CharacterUnavailable,
                message: self.unavailable(),
            })
    }

    /// Puts `request` in her queue at once, behind what she was asked
    /// before it, and answers once she has.
    pub(crate) fn deliver(
        &self,
        request: Request,
    ) -> impl Future<Output = TurnOutcome> + Send + 'static {
        let answer = self.ask(|reply| Command::Deliver(request, reply));
        let (id, health) = (self.id.clone(), self.health.clone());

        async move {
            answer.await.unwrap_or_else(|_| {
                TurnOutcome::refused(
                    TurnRefusal::CharacterUnavailable,
                    not_ready(&id, &health.borrow()),
                )
            })
        }
    }

    /// Makes her match `now`, what she would be built from now, which is
    /// none when her settings cannot be resolved; answered once she does.
    pub(crate) async fn reconcile(&self, now: Option<Built>) {
        let _ = self
            .ask(|reply| Command::Reconcile(now.map(Box::new), reply))
            .await;
    }

    /// The sentence she answers with while she takes nothing.
    pub(crate) fn unavailable(&self) -> String {
        not_ready(&self.id, &self.health())
    }

    /// Asks her to stop, which she reads between two steps; her parked
    /// confirmations settle at once.
    pub(crate) fn signal_stop(&self) {
        self.stop.cancel();
    }

    /// Stops her, and answers once she is stopped.
    pub(crate) async fn stop(&self) {
        self.signal_stop();
        self.stopped().await;
    }

    /// Answered once she is gone.
    pub(crate) async fn stopped(&self) {
        let mut health = self.health.clone();
        let _ = health
            .wait_for(|health| health.state == CharacterState::Stopped)
            .await;
    }

    /// Asks her at once, behind what she was asked before: her answer comes
    /// unless her stop takes her first.
    fn ask<T>(&self, command: impl FnOnce(oneshot::Sender<T>) -> Command) -> oneshot::Receiver<T> {
        let (reply, answer) = oneshot::channel();

        // A command she no longer takes drops its reply, which answers none.
        let _ = self.commands.send(command(reply));
        answer
    }
}

/// The sentence a character off `ready` answers with, her failure's when
/// she failed.
fn not_ready(id: &Identifier, health: &CharacterHealth) -> String {
    let state = health.state.as_str();

    match (&health.diagnostic, health.state) {
        (Some(failure), CharacterState::Failed) => {
            format!("Character \"{id}\" is not ready (state \"{state}\"). {failure}")
        }
        _ => format!("Character \"{id}\" is not ready (state \"{state}\")."),
    }
}

/// What a character is assembled from: who she is, the model and the
/// plugins she answers with, what she was built from, and her thread with
/// the person once it is open.
#[derive(Debug)]
struct Parts {
    character: Character,
    person: SpeakerName,
    context_window: NonZeroU64,
    adapter: Arc<dyn RoleModelAdapter>,
    host: PluginHost,
    built: Built,
    thread: Option<Conversation>,
}

/// A character assembled, and what her start warns of.
struct Assembled {
    parts: Parts,
    warning: Option<String>,
}

/// A change of her state, with what it carries.
enum Change {
    Starting,
    Ready { warning: Option<String> },
    Reloading,
    Failed(String),
    Stopping,
    Stopped { failures: Option<String> },
}

struct Actor {
    id: Identifier,
    world: Arc<World>,
    /// What her own settings change through.
    daemon: WeakDaemon,
    commands: mpsc::UnboundedReceiver<Command>,
    /// What was asked of her during a turn, to answer once it ends.
    deferred: VecDeque<Command>,
    stop: CancellationToken,
    health: watch::Sender<CharacterHealth>,
    broker: Arc<Broker>,
    parts: Option<Parts>,
}

impl Actor {
    async fn run(mut self) {
        self.boot().await;

        while !self.stop.is_cancelled() {
            let command = if let Some(command) = self.deferred.pop_front() {
                Some(command)
            } else {
                tokio::select! {
                    biased;
                    () = self.stop.cancelled() => break,
                    command = self.commands.recv() => command,
                }
            };

            match command {
                Some(command) => self.handle(command).await,
                // The daemon let go of her without a stop.
                None => break,
            }
        }

        self.stop_now().await;
    }

    async fn handle(&mut self, command: Command) {
        match command {
            Command::Start(reply) => {
                if self.state() == CharacterState::Failed {
                    self.boot().await;
                }

                let _ = reply.send(());
            }
            Command::Open(reply) => {
                let opened = self.open().await;
                let _ = reply.send(opened);
            }
            Command::Deliver(request, reply) => self.deliver(request, reply).await,
            Command::Reconcile(now, reply) => {
                match self.state() {
                    CharacterState::Failed => self.boot().await,
                    CharacterState::Ready
                        if self.parts.as_ref().is_some_and(|parts| {
                            !runs(&parts.built, &parts.host, now.as_deref())
                        }) =>
                    {
                        self.reload().await;
                    }
                    _ => {}
                }

                let _ = reply.send(());
            }
        }
    }

    /// Takes a line through her thread while she still hears what she is
    /// asked: a start is answered at once, since she runs, and so is an open
    /// of her thread once it is open; a reconcile that would build her from
    /// something else says she is reloading at once, and the reload follows
    /// the turn, before her next line; a line waits its turn, in the order
    /// it came. A turn the runtime fails leaves her failed, and she is built
    /// again behind it, the lines sent meanwhile waiting as for a reload.
    async fn deliver(&mut self, request: Request, reply: oneshot::Sender<TurnOutcome>) {
        let mut parts = match self.parts.take() {
            Some(parts) if self.state() == CharacterState::Ready => parts,
            unready => {
                self.parts = unready;

                let _ = reply.send(TurnOutcome::refused(
                    TurnRefusal::CharacterUnavailable,
                    not_ready(&self.id, &self.health.borrow()),
                ));
                return;
            }
        };
        let mut reload = None;
        let taken = {
            let Parts {
                character,
                person,
                context_window,
                adapter,
                host,
                built,
                thread,
            } = &mut parts;
            let opened = thread.as_ref().map(|thread| OpenOutcome::Opened {
                conversation_id: thread.id().clone(),
                character_id: self.id.clone(),
                user_participant_id: Participant::local_user_id().clone(),
            });
            let mut turn = std::pin::pin!(take_line(
                &self.world,
                &self.health,
                &self.id,
                &self.broker,
                TurnParts {
                    thread,
                    character,
                    person,
                    adapter: adapter.as_ref(),
                    host,
                    context_window: *context_window,
                },
                request,
            ));

            loop {
                tokio::select! {
                    biased;
                    taken = &mut turn => break taken,
                    Some(command) = self.commands.recv() => match command {
                        Command::Open(answer) => match &opened {
                            Some(opened) => {
                                let _ = answer.send(opened.clone());
                            }
                            // The turn opens her thread: it is answered after.
                            None => self.deferred.push_back(Command::Open(answer)),
                        },
                        Command::Reconcile(now, answer)
                            if reload.is_none() && !runs(built, host, now.as_deref()) =>
                        {
                            self.publish(Change::Reloading);
                            reload = Some(answer);
                        }
                        Command::Start(answer) | Command::Reconcile(_, answer) => {
                            let _ = answer.send(());
                        }
                        line @ Command::Deliver(..) => self.deferred.push_back(line),
                    },
                }
            }
        };

        self.parts = Some(parts);

        let (outcome, fatal) = match taken {
            Ok((delivery, conversation, committed)) => {
                self.answered(delivery, conversation, committed)
            }
            Err(refused) => (refused, false),
        };
        let _ = reply.send(outcome);

        if fatal || reload.is_some() {
            self.rebuild().await;
        }

        if let Some(answer) = reload {
            let _ = answer.send(());
        }
    }

    fn state(&self) -> CharacterState {
        self.health.borrow().state
    }

    fn publish(&self, change: Change) {
        let (state, diagnostic, message) = match change {
            Change::Starting => (CharacterState::Starting, None, None),
            Change::Ready { warning } => (CharacterState::Ready, warning, None),
            Change::Reloading => (CharacterState::Reloading, None, None),
            Change::Failed(failure) => {
                (CharacterState::Failed, Some(failure.clone()), Some(failure))
            }
            Change::Stopping => (CharacterState::Stopping, None, None),
            Change::Stopped { failures } => (CharacterState::Stopped, None, failures),
        };

        // The change is made and announced before anyone reading her
        // health sees it or anyone waiting on it wakes: a surface that
        // reads health after the event has the change, and a stop that
        // waits for her last state finds it announced.
        self.health.send_modify(|health| {
            health.state = state;
            health.diagnostic = diagnostic;
            self.world.events.emit(Event::StateChanged {
                character_id: self.id.clone(),
                state,
                message,
            });
        });
    }

    async fn boot(&mut self) {
        self.publish(Change::Starting);
        self.assemble().await;
    }

    /// Assembles her afresh from what the disk holds now, and publishes how
    /// that went, unless a stop came meanwhile: the stop has the last word,
    /// and releases what was built.
    async fn assemble(&mut self) {
        let world = Arc::clone(&self.world);
        let id = self.id.clone();
        let broker = Arc::clone(&self.broker);
        let daemon = self.daemon.clone();
        let assembled = blocking(move || assemble(&world, &id, broker, daemon)).await;

        match assembled {
            Ok(Assembled { parts, warning }) => {
                self.parts = Some(parts);

                if !self.stop.is_cancelled() {
                    self.publish(Change::Ready { warning });
                }
            }
            Err(failure) => {
                if !self.stop.is_cancelled() {
                    self.publish(Change::Failed(failure));
                }
            }
        }
    }

    async fn open(&mut self) -> OpenOutcome {
        let state = self.state();
        let (CharacterState::Ready, Some(parts)) = (state, self.parts.as_mut()) else {
            return OpenOutcome::Refused {
                reason: OpenRefusal::CharacterUnavailable,
                message: not_ready(&self.id, &self.health.borrow()),
            };
        };

        match hold(
            &self.world,
            &self.health,
            &self.id,
            &mut parts.thread,
            &parts.character,
            &parts.person,
        )
        .await
        {
            Ok(thread) => OpenOutcome::Opened {
                conversation_id: thread.id().clone(),
                character_id: self.id.clone(),
                user_participant_id: Participant::local_user_id().clone(),
            },
            Err(error) => OpenOutcome::Failed(StorageFailure::of(&error)),
        }
    }

    /// What `delivery` on `conversation` comes to, and whether the runtime
    /// failed the turn; `committed` says whether the line was heard
    /// committed.
    fn answered(
        &mut self,
        delivery: Delivery,
        conversation: ConversationId,
        committed: bool,
    ) -> (TurnOutcome, bool) {
        let character_id = self.id.clone();

        match delivery {
            Delivery::Duplicate {
                client_message_id,
                message_id,
            } => (
                TurnOutcome::refused(
                    TurnRefusal::DuplicateSubmission,
                    format!(
                        "clientMessageId \"{client_message_id}\" is already on this conversation \
                         as message {message_id}, taken by an earlier run of the daemon; read the \
                         thread for its reply."
                    ),
                ),
                false,
            ),
            Delivery::InputRejected { message, .. } => (
                TurnOutcome::Rejected {
                    character_id,
                    conversation_id: conversation,
                    reason: RuntimeRejection::InputValidationRejected
                        .as_str()
                        .to_owned(),
                    message,
                    committed: false,
                },
                false,
            ),
            Delivery::Rejected { turn } => (
                TurnOutcome::Rejected {
                    character_id,
                    conversation_id: conversation,
                    reason: turn.reason.to_owned(),
                    message: turn.message,
                    committed: true,
                },
                false,
            ),
            Delivery::Completed {
                turn:
                    CompletedTurn {
                        messages,
                        post_commit_failures,
                    },
                rotation,
            } => {
                let failures: Vec<String> = post_commit_failures
                    .into_iter()
                    .chain(match rotation {
                        Some(Rotation::Failed { message, .. }) => Some(message),
                        Some(Rotation::Rotated { end_failure, .. }) => end_failure,
                        None => None,
                    })
                    .collect();

                if !failures.is_empty() {
                    note_maintenance(&self.world, &self.health, &self.id, failures.join("; "));
                }

                (
                    TurnOutcome::Completed {
                        character_id,
                        conversation_id: conversation,
                        messages: messages.into_iter().map(Into::into).collect(),
                    },
                    false,
                )
            }
            Delivery::Failed { error, .. } => {
                let message = error_sentence(&error);

                self.publish(Change::Failed(message.clone()));
                (
                    TurnOutcome::Failed {
                        character_id,
                        conversation_id: conversation,
                        message,
                        committed,
                    },
                    true,
                )
            }
        }
    }

    /// Between turns, when what she would be built from now is not what she
    /// was built from: deliveries that arrive meanwhile wait, and land on
    /// her thread opened again.
    async fn reload(&mut self) {
        self.publish(Change::Reloading);
        self.rebuild().await;
    }

    /// Lets go of what she runs on, what failed of that noted as
    /// maintenance, and assembles her again, unless a stop came meanwhile.
    async fn rebuild(&mut self) {
        let failures = self.release().await;

        if !failures.is_empty() {
            note_maintenance(&self.world, &self.health, &self.id, failures.join("; "));
        }

        if self.stop.is_cancelled() {
            return;
        }

        if self.state() == CharacterState::Failed {
            self.boot().await;
        } else {
            self.assemble().await;
        }
    }

    /// Her stop: what is still asked of her is answered as stopping, her
    /// thread is closed, and her host shut down; what failed of that is
    /// said as she stops.
    async fn stop_now(&mut self) {
        self.publish(Change::Stopping);
        self.commands.close();

        let mut unanswered: Vec<Command> = self.deferred.drain(..).collect();

        while let Ok(command) = self.commands.try_recv() {
            unanswered.push(command);
        }

        for command in unanswered {
            self.answer_stopping(command);
        }

        let failures = self.release().await;

        self.publish(Change::Stopped {
            failures: (!failures.is_empty()).then(|| failures.join("; ")),
        });
    }

    fn answer_stopping(&self, command: Command) {
        let refusal = || not_ready(&self.id, &self.health.borrow());

        match command {
            Command::Start(reply) | Command::Reconcile(_, reply) => {
                let _ = reply.send(());
            }
            Command::Open(reply) => {
                let _ = reply.send(OpenOutcome::Refused {
                    reason: OpenRefusal::CharacterUnavailable,
                    message: refusal(),
                });
            }
            Command::Deliver(_, reply) => {
                let _ = reply.send(TurnOutcome::refused(
                    TurnRefusal::CharacterUnavailable,
                    refusal(),
                ));
            }
        }
    }

    /// Closes her thread, then shuts her host down: what failed, a sentence
    /// each.
    async fn release(&mut self) -> Vec<String> {
        let Some(Parts {
            character,
            host,
            thread,
            ..
        }) = self.parts.take()
        else {
            return Vec::new();
        };
        let mut failures = Vec::new();

        if let Some(thread) = thread {
            failures.extend(thread.close().await);
        }

        // Her end belongs to no session, but a hook is handed the turn it
        // serves, so it names a session of no conversation.
        let ending = Turn::new(TurnIdentity {
            session_id: SessionId::new(ConversationId::mint(), NonZeroU64::MIN),
            event: EventIdentity::mint(),
            character: character.profile,
        });

        failures.extend(host.shutdown(&ending).await.failures());
        failures
    }
}

/// Whether she runs what she would be built from now, `now`, which is none
/// when her settings cannot be resolved: her package, her host's values,
/// and each plugin as her host serves it, one her own plugin rebuilt live
/// serving the values it was rebuilt from.
fn runs(built: &Built, host: &PluginHost, now: Option<&Built>) -> bool {
    now.is_some_and(|now| {
        built.definition == now.definition
            && built.settings.host() == now.settings.host()
            && host.serves(now.settings.plugins())
    })
}

/// What a turn runs on: her thread, opened the first time it is needed,
/// and the parts she answers with.
struct TurnParts<'p> {
    thread: &'p mut Option<Conversation>,
    character: &'p Character,
    person: &'p SpeakerName,
    adapter: &'p dyn RoleModelAdapter,
    host: &'p PluginHost,
    context_window: NonZeroU64,
}

/// Takes `request` through her thread: what the runtime made of it, on
/// which conversation, and whether the line was heard committed; or what a
/// line her thread cannot take comes to.
async fn take_line(
    world: &World,
    health: &watch::Sender<CharacterHealth>,
    id: &Identifier,
    broker: &Broker,
    parts: TurnParts<'_>,
    request: Request,
) -> Result<(Delivery, ConversationId, bool), TurnOutcome> {
    let Request { stamp, text } = request;
    let conversation = stamp.conversation_id.clone();
    let thread = hold(
        world,
        health,
        id,
        parts.thread,
        parts.character,
        parts.person,
    )
    .await
    .map_err(|error| TurnOutcome::Failed {
        character_id: id.clone(),
        conversation_id: conversation.clone(),
        message: error_sentence(&error),
        committed: false,
    })?;

    if *thread.id() != conversation {
        return Err(TurnOutcome::refused(
            TurnRefusal::UnknownConversation,
            format!("Character \"{id}\" holds no open conversation \"{conversation}\"."),
        ));
    }

    let committed = AtomicBool::new(false);
    let listener = |progress: Progress| {
        if matches!(progress, Progress::UserMessage { .. }) {
            committed.store(true, Ordering::Relaxed);
        }

        world.events.emit(Event::TurnProgress {
            character_id: id.clone(),
            conversation_id: conversation.clone(),
            progress: progress.into(),
        });
    };

    broker.running(Some(stamp.clone()));

    let delivery = thread
        .deliver(
            Submission {
                line: &text,
                source: Some(stamp.source),
                client_message_id: Some(stamp.client_message_id),
            },
            parts.adapter,
            parts.host,
            parts.context_window,
            &listener,
        )
        .await;

    broker.running(None);
    Ok((delivery, conversation, committed.into_inner()))
}

/// Her thread with the person, opened on the blocking pool the first time
/// it is asked for; what the open read past is noted as maintenance.
async fn hold<'t>(
    world: &World,
    health: &watch::Sender<CharacterHealth>,
    id: &Identifier,
    thread: &'t mut Option<Conversation>,
    character: &Character,
    person: &SpeakerName,
) -> Result<&'t mut Conversation, StorageError> {
    let held = if let Some(held) = thread.take() {
        held
    } else {
        let home = world.home.clone();
        let (character, person) = (character.clone(), person.clone());
        let opened = blocking(move || Conversation::open(&home, character, person)).await?;

        if let Some(skipped) = opened.skipped() {
            note_maintenance(world, health, id, skipped.to_owned());
        }

        opened
    };

    Ok(thread.insert(held))
}

/// A background failure of character `id`'s, which the turn's outcome never
/// says.
fn note_maintenance(
    world: &World,
    health: &watch::Sender<CharacterHealth>,
    id: &Identifier,
    message: String,
) {
    let failure = MaintenanceFailure {
        at: Timestamp::now(),
        message,
    };

    health.send_modify(|health| health.maintenance = Some(failure.clone()));
    world.events.emit(Event::MaintenanceFailed {
        character_id: id.clone(),
        failure,
    });
}

/// Assembles character `id` from what the disk holds now: her package, her
/// settings, which must be readable, hold nothing that stops her, and
/// switch her on before anything is written for her, her package's
/// settings merged into her overlay, her model, and her host built with
/// `broker` to ask the person and her settings for its own plugin to read
/// and change, through `daemon`.
fn assemble(
    world: &Arc<World>,
    id: &Identifier,
    broker: Arc<Broker>,
    daemon: WeakDaemon,
) -> Result<Assembled, String> {
    let discovery = discover(world.home.root());
    let definition = discovery
        .find(id.as_str())
        .map_err(|error| error_sentence(&error))?;
    let resolution = Resolution::character(&world.home, &world.sections, definition)
        .map_err(|error| unresolved(id, error))?;
    let stopping: Vec<&str> = resolution.stopping().map(Diagnostic::message).collect();

    if !stopping.is_empty() {
        return Err(stopping.join(" "));
    }

    let settings = resolution.settings();

    if !settings.host().enabled {
        return Err(format!(
            "Character \"{id}\" is disabled. Set project02.enabled to true in its character \
             config, or remove the global project02.enabled."
        ));
    }

    let data = materialize(
        &world.home,
        &world.sections,
        definition,
        world.durations.settings_lock,
    )
    .map_err(|error| unmaterialized(id, error))?;
    let adapter = model(world, settings.host())?;
    let cautions: Vec<&str> = resolution.cautions().map(Diagnostic::message).collect();
    let host = settings
        .plugins()
        .filter_map(|(plugin_id, values)| Some((world.plugin(plugin_id)?, values)))
        .fold(
            PluginHost::builder(
                Arc::new(data),
                broker,
                Arc::new(CharacterConfig::new(Arc::clone(world), daemon, id.clone())),
            ),
            |builder, (plugin, values)| {
                builder.plugin(plugin.manifest().clone(), values.clone(), plugin.factory())
            },
        )
        .activate()
        .map_err(|error| error_sentence(&error))?;

    Ok(Assembled {
        warning: (!cautions.is_empty()).then(|| cautions.join(" ")),
        parts: Parts {
            character: Character {
                profile: definition.profile.clone(),
                persona: definition.persona.clone(),
            },
            person: settings.host().user_display_name.clone(),
            context_window: settings.host().context_window_tokens,
            adapter,
            host,
            built: Built {
                definition: definition.clone(),
                settings,
            },
            thread: None,
        },
    })
}

/// Her model: the one the test switch puts in every character's place,
/// else the provider her settings choose, else none, which she cannot
/// start without.
fn model(world: &World, host: &HostSettings) -> Result<Arc<dyn RoleModelAdapter>, String> {
    if let Some(adapter) = &world.test_provider {
        return Ok(Arc::clone(adapter));
    }

    let nvidia = host.role_model_provider.map(|provider| match provider {
        RoleModelProvider::Nvidia => NvidiaSettings {
            api_key: host.nvidia_api_key.clone(),
            model: host.nvidia_model.clone(),
            base_url: host.nvidia_base_url.clone(),
        },
    });

    match select_adapter(None, nvidia.as_ref(), world.durations.model_silence) {
        Ok(Some(adapter)) => Ok(adapter),
        Ok(None) => Err(NO_PROVIDER.to_owned()),
        Err(error) => Err(error_sentence(&error)),
    }
}

/// Why her settings cannot be resolved, naming what does not load.
pub(crate) fn unresolved(id: &Identifier, error: ReadSettingsError) -> String {
    match error {
        ReadSettingsError::Unreadable(diagnostic) => unreadable(id, &diagnostic),
        other => error_sentence(&other),
    }
}

/// Why her package's settings were not merged into her overlay.
fn unmaterialized(id: &Identifier, error: MaterializeError) -> String {
    match error {
        MaterializeError::Unreadable(diagnostic) => unreadable(id, &diagnostic),
        MaterializeError::Storage(error) => error_sentence(&error),
    }
}

fn unreadable(id: &Identifier, diagnostic: &Diagnostic) -> String {
    format!(
        "Character \"{id}\"'s settings cannot be read: {}",
        diagnostic.message()
    )
}
