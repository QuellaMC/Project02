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
    CharacterSettings, HostSettings, MaterializeError, ReadSettingsError, Resolution,
    RoleModelProvider, materialize,
};
use p02_contracts::{PluginKind, RoleModelAdapter, TurnIdentity};
use p02_core::{ConversationId, EventIdentity, Participant, SessionId, SpeakerName, Timestamp};
use p02_plugins::{PluginHost, Turn};
use p02_role_model::{NvidiaSettings, select_adapter};
use p02_runtime::{
    Character, CompletedTurn, Conversation, Delivery, Progress, Rotation, Submission,
};
use p02_shared::Identifier;
use p02_store::{RuntimeRejection, StorageError};
use serde::{Serialize, Serializer};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinError;
use tokio_util::sync::CancellationToken;

use crate::config_control::CharacterConfig;
use crate::confirmation::Broker;
use crate::daemon::World;
use crate::outcome::{
    Event, MaintenanceFailure, OpenOutcome, OpenRefusal, StorageFailure, TurnOutcome, TurnRefusal,
    TurnStamp, sentence,
};

/// The sentence a character without a model gives, which the settings
/// page answers.
const NO_PROVIDER: &str = "No model provider is chosen. Choose one on the settings page.";

/// Where a character's runtime stands. `reloading` is a pause: a delivery
/// sent meanwhile waits for it and lands on the same thread.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CharacterState {
    Starting,
    Ready,
    Reloading,
    Stopping,
    Stopped,
    Failed,
}

impl CharacterState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Reloading => "reloading",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        }
    }
}

impl Serialize for CharacterState {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
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
/// later reconcile compares with what she would be built from now, to
/// decide a reload.
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

/// What a reconcile did to her.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reconciled {
    Started,
    Reloaded,
    Unchanged,
}

#[derive(Debug)]
enum Command {
    /// Answered once her start settles, whichever start that is.
    Start(oneshot::Sender<()>),
    Open(oneshot::Sender<OpenOutcome>),
    Deliver(Request, oneshot::Sender<TurnOutcome>),
    Reconcile(Option<Box<Built>>, oneshot::Sender<Reconciled>),
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
    /// A new actor for character `id`, who starts at once.
    pub(crate) fn spawn(world: Arc<World>, id: Identifier) -> Self {
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
    /// none when her settings cannot be resolved.
    pub(crate) async fn reconcile(&self, now: Option<Built>) -> Reconciled {
        self.ask(|reply| Command::Reconcile(now.map(Box::new), reply))
            .await
            .unwrap_or(Reconciled::Unchanged)
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
    commands: mpsc::UnboundedReceiver<Command>,
    /// What her recovery set aside to answer once she is back.
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
            Command::Deliver(request, reply) => {
                let (outcome, fatal) = self.turn(request).await;
                let _ = reply.send(outcome);

                if fatal {
                    self.recover().await;
                }
            }
            Command::Reconcile(now, reply) => {
                let reconciled = match self.state() {
                    CharacterState::Failed => {
                        self.boot().await;
                        Reconciled::Started
                    }
                    CharacterState::Ready
                        if self.parts.as_ref().map(|parts| &parts.built) != now.as_deref() =>
                    {
                        self.reload().await;
                        Reconciled::Reloaded
                    }
                    _ => Reconciled::Unchanged,
                };
                let _ = reply.send(reconciled);
            }
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

        // The watch first, so a surface that reads health after it hears
        // the event has the change already, never the other way round.
        self.health.send_modify(|health| {
            health.state = state;
            health.diagnostic = diagnostic;
        });
        self.world.events.emit(Event::StateChanged {
            character_id: self.id.clone(),
            state,
            message,
        });
    }

    /// A background failure of hers, which the turn's outcome never says.
    fn note_maintenance(&self, message: String) {
        let failure = MaintenanceFailure {
            at: Timestamp::now(),
            message,
        };

        self.health
            .send_modify(|health| health.maintenance = Some(failure.clone()));
        self.world.events.emit(Event::MaintenanceFailed {
            character_id: self.id.clone(),
            failure,
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
        let assembled = tokio::task::spawn_blocking(move || assemble(&world, &id, broker))
            .await
            .unwrap_or_else(|error| Err(interrupted(&error)));

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
            Err(Unheld::Storage(error)) => OpenOutcome::Failed(StorageFailure::of(&error)),
            Err(Unheld::Interrupted(error)) => OpenOutcome::Refused {
                reason: OpenRefusal::CharacterUnavailable,
                message: interrupted(&error),
            },
        }
    }

    /// Takes a line through her thread, and whether the runtime failed the
    /// turn: then she is failed, and recovers behind it.
    async fn turn(&mut self, request: Request) -> (TurnOutcome, bool) {
        let state = self.state();
        let refused = |reason, message| (TurnOutcome::refused(reason, message), false);
        let (CharacterState::Ready, Some(parts)) = (state, self.parts.as_mut()) else {
            return refused(
                TurnRefusal::CharacterUnavailable,
                not_ready(&self.id, &self.health.borrow()),
            );
        };
        let Request { stamp, text } = request;
        let Parts {
            character,
            person,
            context_window,
            adapter,
            host,
            thread,
            ..
        } = parts;
        let conversation = stamp.conversation_id.clone();
        let thread = match hold(&self.world, thread, character, person).await {
            Ok(thread) => thread,
            Err(unheld) => {
                let message = match unheld {
                    Unheld::Storage(error) => sentence(&error),
                    Unheld::Interrupted(error) => interrupted(&error),
                };

                return (
                    TurnOutcome::Failed {
                        character_id: self.id.clone(),
                        conversation_id: conversation,
                        message,
                        committed: false,
                    },
                    false,
                );
            }
        };

        if *thread.id() != conversation {
            return refused(
                TurnRefusal::UnknownConversation,
                format!(
                    "Character \"{}\" holds no open conversation \"{conversation}\".",
                    self.id
                ),
            );
        }

        let committed = AtomicBool::new(false);
        let listener = |progress: Progress| {
            if matches!(progress, Progress::UserMessage { .. }) {
                committed.store(true, Ordering::Relaxed);
            }

            self.world.events.emit(Event::TurnProgress {
                character_id: self.id.clone(),
                conversation_id: conversation.clone(),
                progress: progress.into(),
            });
        };

        self.broker.running(Some(stamp.clone()));

        let delivery = thread
            .deliver(
                Submission {
                    line: &text,
                    source: Some(stamp.source),
                    client_message_id: Some(stamp.client_message_id),
                },
                adapter.as_ref(),
                host,
                *context_window,
                &listener,
            )
            .await;

        self.broker.running(None);
        self.answered(delivery, conversation, committed.into_inner())
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
                    reason: RuntimeRejection::InputValidationRejected.as_str(),
                    message,
                    committed: false,
                },
                false,
            ),
            Delivery::Rejected { turn } => (
                TurnOutcome::Rejected {
                    character_id,
                    conversation_id: conversation,
                    reason: turn.reason,
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
                    self.note_maintenance(failures.join("; "));
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
                let message = sentence(&error);

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

    /// The one restart a fatal turn earns: the lines queued behind it are
    /// refused first, as she is failed, then her thread is closed and her
    /// host shut down, then she starts. A stop read meanwhile wins.
    async fn recover(&mut self) {
        while let Ok(command) = self.commands.try_recv() {
            match command {
                Command::Deliver(_, reply) => {
                    let _ = reply.send(TurnOutcome::refused(
                        TurnRefusal::CharacterUnavailable,
                        not_ready(&self.id, &self.health.borrow()),
                    ));
                }
                Command::Open(reply) => {
                    let _ = reply.send(OpenOutcome::Refused {
                        reason: OpenRefusal::CharacterUnavailable,
                        message: not_ready(&self.id, &self.health.borrow()),
                    });
                }
                waits @ (Command::Start(_) | Command::Reconcile(..)) => {
                    self.deferred.push_back(waits);
                }
            }
        }

        self.rebuild().await;
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
            self.note_maintenance(failures.join("; "));
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
    /// thread is closed, its end hooks run, and her host shut down; what
    /// failed of that is said as she stops.
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
            Command::Start(reply) => {
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
            Command::Reconcile(_, reply) => {
                let _ = reply.send(Reconciled::Unchanged);
            }
        }
    }

    /// Closes her thread, its end hooks run, then shuts her host down: what
    /// failed, a sentence each.
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
            failures.extend(thread.close(&host).await);
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

/// Why her thread could not be held.
enum Unheld {
    Storage(StorageError),
    Interrupted(JoinError),
}

/// Her thread with the person, opened on the blocking pool the first time
/// it is asked for.
async fn hold<'t>(
    world: &World,
    thread: &'t mut Option<Conversation>,
    character: &Character,
    person: &SpeakerName,
) -> Result<&'t mut Conversation, Unheld> {
    let held = if let Some(held) = thread.take() {
        held
    } else {
        let home = world.home.clone();
        let (character, person) = (character.clone(), person.clone());

        tokio::task::spawn_blocking(move || Conversation::open(&home, character, person))
            .await
            .map_err(Unheld::Interrupted)?
            .map_err(Unheld::Storage)?
    };

    Ok(thread.insert(held))
}

fn interrupted(error: &JoinError) -> String {
    format!("Work on the disk did not finish: {}", sentence(error))
}

/// Assembles character `id` from what the disk holds now: her package, her
/// settings, which must load and switch her on before anything is written
/// for her, her package's settings merged into her overlay, her model, the
/// plugins her package expects and her memory provider judged, and her
/// host built with `broker` to ask the person and her settings for its own
/// plugin to read and change.
fn assemble(world: &Arc<World>, id: &Identifier, broker: Arc<Broker>) -> Result<Assembled, String> {
    let discovery = discover(world.home.root());
    let definition = discovery
        .find(id.as_str())
        .map_err(|error| sentence(&error))?;
    let resolution = Resolution::character(&world.home, &world.sections, definition)
        .map_err(|error| unresolved(id, error))?;
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
    let warning = expected_plugins(world, definition, &settings, &resolution)?;

    memory_provider(world, &settings)?;

    let host = settings
        .plugins()
        .filter_map(|(plugin_id, values)| Some((world.plugin(plugin_id)?, values)))
        .fold(
            PluginHost::builder(Arc::new(data)),
            |builder, (plugin, values)| {
                builder.plugin(plugin.manifest().clone(), values.clone(), plugin.factory())
            },
        )
        .confirmer(broker)
        .config_control(Arc::new(CharacterConfig::new(
            Arc::clone(world),
            id.clone(),
        )))
        .activate()
        .map_err(|error| sentence(&error))?;

    Ok(Assembled {
        parts: Parts {
            character: Character {
                profile: definition.profile.clone(),
                persona: definition.persona.clone(),
                character_ref: definition.character_ref(),
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
        warning,
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
        Err(error) => Err(sentence(&error)),
    }
}

/// Her package's expectations judged against the plugins she runs: a
/// required plugin she does not run blocks her, and a recommended one only
/// warns, in what her start says.
fn expected_plugins(
    world: &World,
    definition: &CharacterDefinition,
    settings: &CharacterSettings,
    resolution: &Resolution<'_>,
) -> Result<Option<String>, String> {
    let id = &definition.profile.id;
    let expectations = &definition.plugins;

    if let Some((plugin, problem)) = expectations
        .required()
        .iter()
        .find_map(|plugin| Some((plugin, unrun(world, settings, resolution, plugin)?)))
    {
        return Err(format!(
            "Character \"{id}\" requires plugin \"{plugin}\", {problem}"
        ));
    }

    let warnings: Vec<String> = expectations
        .recommended()
        .iter()
        .filter(|plugin| !expectations.required().contains(plugin))
        .filter_map(|plugin| {
            let problem = unrun(world, settings, resolution, plugin)?;

            Some(format!(
                "Character \"{id}\" recommends plugin \"{plugin}\", {problem}"
            ))
        })
        .collect();

    Ok((!warnings.is_empty()).then(|| warnings.join(" ")))
}

/// Why `plugin` does not run for her, as the rest of a sentence; none when
/// it runs.
fn unrun(
    world: &World,
    settings: &CharacterSettings,
    resolution: &Resolution<'_>,
    plugin: &Identifier,
) -> Option<String> {
    if settings.plugins().any(|(running, _)| running == plugin) {
        return None;
    }

    if world.plugin(plugin).is_none() {
        return Some("which this build does not have.".to_owned());
    }

    Some(
        match resolution.diagnostics().iter().find(|diagnostic| {
            diagnostic.severity() == p02_config::Severity::Error
                && diagnostic.concerns(p02_config::Namespace::Plugins, plugin.as_str())
        }) {
            Some(diagnostic) => format!("which her settings block: {}", diagnostic.message()),
            None => "which her settings switch off. Switch it on in her settings.".to_owned(),
        },
    )
}

/// The memory she keeps, which fails closed: the provider her settings
/// choose must be a memory plugin she runs, and when none is chosen she
/// runs one at most.
fn memory_provider(world: &World, settings: &CharacterSettings) -> Result<(), String> {
    let running: Vec<&Identifier> = settings
        .plugins()
        .map(|(plugin, _)| plugin)
        .filter(|plugin| {
            world
                .plugin(plugin)
                .is_some_and(|plugin| plugin.manifest().kind() == PluginKind::MemoryProvider)
        })
        .collect();

    match &settings.host().default_memory_provider {
        Some(chosen) if !running.iter().any(|plugin| plugin.as_str() == chosen) => Err(format!(
            "The memory provider \"{chosen}\" her settings choose is not a memory plugin they \
             switch on. Switch it on, or choose another in project02.defaultMemoryProvider."
        )),
        None if running.len() > 1 => Err(format!(
            "Her settings switch on more than one memory plugin ({}) and choose none. Choose \
             one in project02.defaultMemoryProvider.",
            running
                .iter()
                .map(|plugin| plugin.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
        _ => Ok(()),
    }
}

/// Why her settings cannot be resolved, naming what does not load.
pub(crate) fn unresolved(id: &Identifier, error: ReadSettingsError) -> String {
    match error {
        ReadSettingsError::Unloadable { diagnostics } => {
            format!(
                "Character \"{id}\"'s settings do not load: {}",
                messages(&diagnostics)
            )
        }
        other => sentence(&other),
    }
}

/// Why her package's settings were not merged into her overlay.
fn unmaterialized(id: &Identifier, error: MaterializeError) -> String {
    match error {
        MaterializeError::Package { diagnostics } => format!(
            "Character \"{id}\"'s package settings are refused: {}",
            messages(&diagnostics)
        ),
        MaterializeError::Unloadable { diagnostics } => format!(
            "Character \"{id}\"'s settings do not load: {}",
            messages(&diagnostics)
        ),
        MaterializeError::Storage(error) => sentence(&error),
    }
}

fn messages(diagnostics: &[p02_config::Diagnostic]) -> String {
    diagnostics
        .iter()
        .map(p02_config::Diagnostic::message)
        .collect::<Vec<_>>()
        .join(" ")
}
