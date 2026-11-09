//! One actor per character: a task owning everything of hers, her state,
//! the parts she is assembled from, her thread with the person and her
//! confirmations, which answers what it is asked in the order it was asked,
//! takes the lines in her inbox one at a time while she is ready, and
//! between two steps reads whether she is to stop.

use std::num::NonZeroU64;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use p02_characters::discover;
use p02_config::{
    CharacterSettings, Diagnostic, HostSettings, MaterializeError, ReadSettingsError, Resolution,
    RoleModelProvider, materialize,
};
use p02_contracts::{RoleModelAdapter, vocabulary};
use p02_core::{SpeakerName, Timestamp};
use p02_plugins::PluginHost;
use p02_role_model::{NvidiaSettings, select_adapter};
use p02_runtime::{Character, CompletedTurn, Conversation, Delivery, Mind, Progress, Submission};
use p02_shared::{Identifier, error_sentence};
use p02_store::{CharacterData, Inbox, QueuedLine, RuntimeRejection, StorageError};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::config_control::CharacterConfig;
use crate::confirmation::Broker;
use crate::daemon::{Daemon, WeakDaemon, World, blocking};
use crate::outcome::{
    Event, MaintenanceFailure, OpenOutcome, OpenRefusal, RunningTurn, StorageFailure, TurnRefusal,
    TurnStamp, TurnStatus, duplicate,
};
use crate::reconcile::settings_now;

/// The sentence a character without a model gives, which the settings
/// page answers.
const NO_PROVIDER: &str = "No model provider is chosen. Choose one on the settings page.";

vocabulary! {
    /// Where a character's runtime stands.
    #[ts(rename = "CharacterRuntimeState")]
    #[schemars(rename = "CharacterRuntimeState")]
    CharacterState {
        Starting = "starting",
        Ready = "ready",
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

#[derive(Debug)]
enum Command {
    /// Answered once her start settles, whichever start that is.
    Start(oneshot::Sender<()>),
    Open(oneshot::Sender<OpenOutcome>),
    /// A line was queued for her, which she takes in its turn.
    Queued,
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
                her: Her {
                    id: id.clone(),
                    world,
                    daemon: daemon.downgrade(),
                    stop: stop.clone(),
                    health: published,
                    broker: Arc::clone(&broker),
                },
                commands: receiver,
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

    /// Whether a line queued for her now is one she takes: she is starting
    /// or ready, and no failure of hers waits for the person.
    pub(crate) fn takes_lines(&self) -> bool {
        matches!(
            self.health.borrow().state,
            CharacterState::Starting | CharacterState::Ready
        )
    }

    /// Whether her actor is gone: stopped, or ended without saying so.
    pub(crate) fn gone(&self) -> bool {
        self.health.borrow().state == CharacterState::Stopped || self.health.has_changed().is_err()
    }

    /// Answered once her start settles. A boot in flight is joined, so a
    /// failure it ends in is answered and not tried again; otherwise she is
    /// asked, and boots again when she has failed.
    pub(crate) async fn start(&self) {
        let starting = |health: &CharacterHealth| health.state == CharacterState::Starting;
        let mut health = self.health.clone();

        if starting(&health.borrow()) {
            let _ = health.wait_for(|health| !starting(health)).await;
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

    /// Tells her a line was queued for her, which she takes once she is
    /// free.
    pub(crate) fn queued(&self) {
        // One whose stop began takes no line: it waits for her next start.
        let _ = self.commands.send(Command::Queued);
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

/// What she is built of, from her package and her settings as they were
/// when she was built: who she is, her data, the name the person goes by,
/// the model and the plugins she answers with, her model's window, and
/// those settings, which her next request compares with what they say
/// then.
#[derive(Debug)]
struct Built {
    character: Character,
    data: CharacterData,
    person: SpeakerName,
    context_window: NonZeroU64,
    adapter: Arc<dyn RoleModelAdapter>,
    host: PluginHost,
    settings: CharacterSettings,
}

/// What a character runs on: what she is built of, and her thread with the
/// person once it is open, which outlasts her being built again.
#[derive(Debug)]
struct Parts {
    built: Built,
    thread: Option<Conversation>,
}

/// A character built, and what her start warns of.
struct Assembled {
    built: Built,
    warning: Option<String>,
}

/// A change of her state, with what it carries.
enum Change {
    Starting,
    Ready { warning: Option<String> },
    Failed(String),
    Stopping,
    Stopped { failures: Option<String> },
}

struct Actor {
    her: Her,
    commands: mpsc::UnboundedReceiver<Command>,
    parts: Option<Parts>,
}

/// What every step of hers reaches: who she is, the world she is built
/// from, the daemon her own settings change through, her stop, her health
/// as she publishes it, and her confirmations.
struct Her {
    id: Identifier,
    world: Arc<World>,
    daemon: WeakDaemon,
    stop: CancellationToken,
    health: watch::Sender<CharacterHealth>,
    broker: Arc<Broker>,
}

impl Actor {
    async fn run(mut self) {
        self.boot().await;

        while !self.her.stop.is_cancelled() {
            if self.take_next().await {
                continue;
            }

            tokio::select! {
                biased;
                () = self.her.stop.cancelled() => break,
                command = self.commands.recv() => match command {
                    Some(command) => self.handle(command).await,
                    // The daemon let go of her without a stop.
                    None => break,
                },
            }
        }

        self.stop_now().await;
    }

    async fn handle(&mut self, command: Command) {
        match command {
            Command::Start(reply) => {
                if self.her.state() == CharacterState::Failed {
                    self.boot().await;
                }

                let _ = reply.send(());
            }
            Command::Open(reply) => {
                let opened = self.open().await;
                let _ = reply.send(opened);
            }
            // She looks in her inbox whenever she is free.
            Command::Queued => {}
        }
    }

    /// Takes the oldest line in her inbox through her thread, while she is
    /// ready and her settings still build her: true when she took one. The
    /// line leaves her inbox once its turn ends, however it ended, and only
    /// then is the end announced, so a client that hears it and sends the
    /// line again is answered as her thread has it. A turn the runtime
    /// fails leaves her failed, and she is built again behind it; her inbox
    /// failing fails her.
    async fn take_next(&mut self) -> bool {
        let Some(line) = self.oldest_queued().await else {
            return false;
        };
        let Ok(mut parts) = self.current().await else {
            return false;
        };

        if self.her.stop.is_cancelled() {
            self.parts = Some(parts);
            return false;
        }

        let taken = self.turn(&mut parts, &line).await;
        let data = parts.built.data.clone();

        self.parts = Some(parts);

        let (ending, failure) = self.ended(taken);
        let removed = {
            let line = line.clone();

            blocking(move || data.unqueue(&line)).await
        };

        self.her
            .world
            .events
            .emit(ending.announced(self.her.id.clone(), line));

        match (removed, failure) {
            (Err(error), _) => self.fail(error_sentence(&error)).await,
            (Ok(()), Some(failure)) => {
                self.her.publish(Change::Failed(failure));
                self.restart().await;
            }
            (Ok(()), None) => {}
        }

        true
    }

    /// Takes `line` through her thread on `parts`, opened before the turn
    /// begins, while she still hears what she is asked: an open of her
    /// thread is answered at once, and so is a start, since she runs.
    async fn turn(
        &mut self,
        parts: &mut Parts,
        line: &QueuedLine,
    ) -> Result<(Delivery, bool), Ending> {
        let Parts { built, thread } = parts;
        let thread = hold(&self.her, thread, &built.character)
            .await
            .map_err(|error| Ending::failed(error_sentence(&error), false))?;
        let opened = OpenOutcome::Opened {
            conversation_id: thread.id().clone(),
            character_id: self.her.id.clone(),
        };
        let mut turn = std::pin::pin!(take_line(&self.her, thread, built, line));

        loop {
            tokio::select! {
                biased;
                taken = &mut turn => break Ok(taken),
                Some(command) = self.commands.recv() => match command {
                    Command::Open(answer) => {
                        let _ = answer.send(opened.clone());
                    }
                    Command::Start(answer) => {
                        let _ = answer.send(());
                    }
                    // She looks in her inbox again once the turn ends.
                    Command::Queued => {}
                },
            }
        }
    }

    /// The oldest line in her inbox, while she is ready; what the read
    /// skipped is noted as maintenance, and a read that fails fails her.
    async fn oldest_queued(&mut self) -> Option<QueuedLine> {
        let data = self
            .parts
            .as_ref()
            .filter(|_| self.her.state() == CharacterState::Ready)?
            .built
            .data
            .clone();

        match blocking(move || data.inbox()).await {
            Ok(Inbox { lines, skipped }) => {
                if !skipped.is_empty() {
                    self.her.note_maintenance(format!(
                        "Skipped what could not be read, {skipped} of her inbox; the rest was read."
                    ));
                }

                lines.into_iter().next()
            }
            Err(error) => {
                self.fail(error_sentence(&error)).await;
                None
            }
        }
    }

    /// Her parts to use, brought up to date with her settings first; or
    /// the sentence she refuses with while she is not ready, or once her
    /// settings no longer build her, which fails her.
    async fn current(&mut self) -> Result<Parts, String> {
        let mut parts = match self.parts.take() {
            Some(parts) if self.her.state() == CharacterState::Ready => parts,
            unready => {
                self.parts = unready;
                return Err(self.her.not_ready());
            }
        };

        if let Err(failure) = self.her.refresh(&mut parts.built).await {
            self.parts = Some(parts);
            self.fail(failure).await;
            return Err(self.her.not_ready());
        }

        Ok(parts)
    }

    async fn boot(&mut self) {
        self.her.publish(Change::Starting);

        match self.her.assemble().await {
            Ok(Assembled { built, warning }) => {
                self.parts = Some(Parts {
                    built,
                    thread: None,
                });
                self.her.settle(Change::Ready { warning });
            }
            Err(failure) => self.her.settle(Change::Failed(failure)),
        }
    }

    async fn open(&mut self) -> OpenOutcome {
        let mut parts = match self.current().await {
            Ok(parts) => parts,
            Err(message) => {
                return OpenOutcome::Refused {
                    reason: OpenRefusal::CharacterUnavailable,
                    message,
                };
            }
        };
        let held = hold(&self.her, &mut parts.thread, &parts.built.character)
            .await
            .map(|thread| thread.id().clone());

        self.parts = Some(parts);

        match held {
            Ok(conversation_id) => OpenOutcome::Opened {
                conversation_id,
                character_id: self.her.id.clone(),
            },
            Err(error) => OpenOutcome::Failed(StorageFailure::of(&error)),
        }
    }

    /// How `taken` ended its turn, and the sentence of the runtime's
    /// failure of it, which fails her.
    fn ended(&self, taken: Result<(Delivery, bool), Ending>) -> (Ending, Option<String>) {
        let (delivery, committed) = match taken {
            Ok(taken) => taken,
            Err(ending) => return (ending, None),
        };

        match delivery {
            Delivery::Duplicate {
                client_message_id,
                message_id,
            } => (
                Ending::refused(
                    TurnRefusal::DuplicateSubmission,
                    duplicate(&client_message_id, &message_id),
                    true,
                ),
                None,
            ),
            Delivery::InputRejected { message } => (
                Ending::rejected(
                    RuntimeRejection::InputValidationRejected.as_str(),
                    message,
                    false,
                ),
                None,
            ),
            Delivery::Rejected(turn) => (Ending::rejected(turn.reason, turn.message, true), None),
            Delivery::Completed(CompletedTurn {
                post_commit_failures,
                ..
            }) => {
                self.her.noted(&post_commit_failures);

                (Ending::completed(), None)
            }
            Delivery::Failed(error) => {
                let message = error_sentence(&error);

                (Ending::failed(message.clone(), committed), Some(message))
            }
        }
    }

    /// Fails her saying why, and lets go of what she ran on, what failed of
    /// that noted as maintenance: she takes nothing until her next start.
    async fn fail(&mut self, failure: String) {
        self.her.settle(Change::Failed(failure));

        if let Some(parts) = self.parts.take() {
            self.her.noted(&parts.release().await);
        }
    }

    /// After a turn the runtime failed: lets go of what she ran on, what
    /// failed of that noted as maintenance, and boots her again, unless her
    /// stop came meanwhile.
    async fn restart(&mut self) {
        if let Some(parts) = self.parts.take() {
            self.her.noted(&parts.release().await);
        }

        if !self.her.stop.is_cancelled() {
            self.boot().await;
        }
    }

    /// Her stop: what is still asked of her is answered as stopping, her
    /// thread is closed, and her host shut down; what failed of that is
    /// said as she stops. The lines in her inbox wait for her next start.
    async fn stop_now(&mut self) {
        self.her.publish(Change::Stopping);
        self.commands.close();

        while let Ok(command) = self.commands.try_recv() {
            self.answer_stopping(command);
        }

        let failures = match self.parts.take() {
            Some(parts) => parts.release().await,
            None => Vec::new(),
        };

        self.her.publish(Change::Stopped {
            failures: (!failures.is_empty()).then(|| failures.join("; ")),
        });
    }

    fn answer_stopping(&self, command: Command) {
        match command {
            Command::Start(reply) => {
                let _ = reply.send(());
            }
            Command::Open(reply) => {
                let _ = reply.send(OpenOutcome::Refused {
                    reason: OpenRefusal::CharacterUnavailable,
                    message: self.her.not_ready(),
                });
            }
            Command::Queued => {}
        }
    }
}

/// How a turn ended, as its completion announces it: its status, whether
/// its line is in the log, and why when it did not complete.
struct Ending {
    status: TurnStatus,
    committed: bool,
    reason: Option<String>,
    message: Option<String>,
}

impl Ending {
    fn completed() -> Self {
        Self {
            status: TurnStatus::Completed,
            committed: true,
            reason: None,
            message: None,
        }
    }

    fn rejected(reason: &str, message: String, committed: bool) -> Self {
        Self {
            status: TurnStatus::Rejected,
            committed,
            reason: Some(reason.to_owned()),
            message: Some(message),
        }
    }

    fn refused(reason: TurnRefusal, message: String, committed: bool) -> Self {
        Self {
            status: TurnStatus::Refused,
            committed,
            reason: Some(reason.as_str().to_owned()),
            message: Some(message),
        }
    }

    fn failed(message: String, committed: bool) -> Self {
        Self {
            status: TurnStatus::Failed,
            committed,
            reason: None,
            message: Some(message),
        }
    }

    /// The completion of `line`'s turn on `character`.
    fn announced(self, character: Identifier, line: QueuedLine) -> Event {
        Event::TurnCompleted {
            character_id: character,
            conversation_id: line.conversation_id,
            source: line.source,
            client_message_id: line.client_message_id,
            status: self.status,
            committed: self.committed,
            reason: self.reason,
            message: self.message,
        }
    }
}

impl Her {
    fn state(&self) -> CharacterState {
        self.health.borrow().state
    }

    /// The sentence she answers with while she takes nothing.
    fn not_ready(&self) -> String {
        not_ready(&self.id, &self.health.borrow())
    }

    fn publish(&self, change: Change) {
        let (state, diagnostic, message) = match change {
            Change::Starting => (CharacterState::Starting, None, None),
            Change::Ready { warning } => (CharacterState::Ready, warning, None),
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

    /// Publishes how her being built went, unless her stop came meanwhile:
    /// the stop has the last word.
    fn settle(&self, change: Change) {
        if !self.stop.is_cancelled() {
            self.publish(change);
        }
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

    /// `failures` as one maintenance failure, when there are any.
    fn noted(&self, failures: &[String]) {
        if !failures.is_empty() {
            self.note_maintenance(failures.join("; "));
        }
    }

    /// Builds her afresh from what the disk holds now, on the blocking pool.
    async fn assemble(&self) -> Result<Assembled, String> {
        let world = Arc::clone(&self.world);
        let id = self.id.clone();
        let broker = Arc::clone(&self.broker);
        let daemon = self.daemon.clone();

        blocking(move || assemble(&world, &id, broker, daemon)).await
    }

    /// Brings `built` up to date with her settings: she is built again, as
    /// her boot builds her, when what they say now is not what she was
    /// built from, unless they now switch her off, which her stop answers
    /// once the turn in flight ends. True when she was built again; what
    /// she ran on until then is let go, what failed of that noted as
    /// maintenance.
    ///
    /// # Errors
    ///
    /// The sentence that says why her settings no longer build her; `built`
    /// is left as it was.
    async fn refresh(&self, built: &mut Built) -> Result<bool, String> {
        let world = Arc::clone(&self.world);
        let id = self.id.clone();
        let now = blocking(move || {
            settings_now(&world, discover(world.home.root()).find(id.as_str()).ok()?)
        })
        .await;

        if now.is_some_and(|now| now == built.settings || !now.host().enabled) {
            return Ok(false);
        }

        let Assembled {
            built: rebuilt,
            warning,
        } = self.assemble().await?;

        self.noted(&std::mem::replace(built, rebuilt).shut_down().await);
        self.settle(Change::Ready { warning });
        Ok(true)
    }
}

/// Her parts as a turn runs on them, brought up to date with her settings
/// before each of its requests after the first.
struct Current<'a> {
    her: &'a Her,
    built: &'a mut Built,
}

#[async_trait]
impl Mind for Current<'_> {
    fn person(&self) -> &SpeakerName {
        &self.built.person
    }

    fn adapter(&self) -> &dyn RoleModelAdapter {
        self.built.adapter.as_ref()
    }

    fn host(&self) -> &PluginHost {
        &self.built.host
    }

    fn context_window(&self) -> NonZeroU64 {
        self.built.context_window
    }

    async fn refresh(&mut self) -> Result<bool, String> {
        self.her.refresh(self.built).await
    }
}

impl Built {
    /// Ends her plugins: what failed, a sentence each.
    async fn shut_down(self) -> Vec<String> {
        self.host.shutdown().await.failures()
    }
}

impl Parts {
    /// Closes her thread, then ends her plugins: what failed, a sentence
    /// each.
    async fn release(self) -> Vec<String> {
        let mut failures = Vec::new();

        if let Some(thread) = self.thread {
            failures.extend(thread.close().await);
        }

        failures.extend(self.built.shut_down().await);
        failures
    }
}

/// Takes `line` through `thread`, as `built` answers it: what the runtime
/// made of it, and whether the line was heard committed. The stream is told
/// the turn as it goes: each message and tool call, and the turn as it runs
/// whenever that changes.
async fn take_line(
    her: &Her,
    thread: &mut Conversation,
    built: &mut Built,
    line: &QueuedLine,
) -> (Delivery, bool) {
    let committed = AtomicBool::new(false);
    let running = Mutex::new(RunningTurn::of(her.id.clone(), line));
    let listener = |progress: Progress| {
        if matches!(progress, Progress::UserMessage { .. }) {
            committed.store(true, Ordering::Relaxed);
        }

        let told = running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .told(progress);

        for event in told {
            her.world.events.emit(event);
        }
    };

    her.broker.running(Some(TurnStamp {
        conversation_id: line.conversation_id.clone(),
        source: line.source.clone(),
        client_message_id: line.client_message_id.clone(),
    }));

    let delivery = thread
        .deliver(
            Submission {
                line: &line.text,
                source: line.source.clone(),
                client_message_id: line.client_message_id.clone(),
            },
            &mut Current { her, built },
            &listener,
        )
        .await;

    her.broker.running(None);
    (delivery, committed.into_inner())
}

/// Her thread with the person, opened on the blocking pool the first time
/// it is asked for; what the open read past is noted as maintenance.
async fn hold<'t>(
    her: &Her,
    thread: &'t mut Option<Conversation>,
    character: &Character,
) -> Result<&'t mut Conversation, StorageError> {
    let held = if let Some(held) = thread.take() {
        held
    } else {
        let home = her.world.home.clone();
        let character = character.clone();
        let opened = blocking(move || Conversation::open(&home, character)).await?;

        if let Some(skipped) = opened.skipped() {
            her.note_maintenance(skipped.to_owned());
        }

        opened
    };

    Ok(thread.insert(held))
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
                Arc::new(data.clone()),
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
        built: Built {
            character: Character {
                profile: definition.profile.clone(),
                persona: definition.persona.clone(),
            },
            data,
            person: settings.host().user_display_name.clone(),
            context_window: settings.host().context_window_tokens,
            adapter,
            host,
            settings,
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
