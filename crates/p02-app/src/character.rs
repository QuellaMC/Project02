//! One actor per character: a task owning everything of hers, her state,
//! the parts she is assembled from, her thread with the person, her
//! confirmations and her phone's rings, which answers what it is asked in
//! the order it was asked, takes the lines in her inbox one at a time while
//! she is ready, gives her a moment of her own whenever something on her
//! phone rings or she has been quiet for as long as her heartbeat says, and
//! between two steps reads whether she is to stop.

use std::num::NonZeroU64;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use p02_characters::discover;
use p02_config::{
    CharacterSettings, HostSettings, MaterializeError, ReadSettingsError, Resolution,
    RoleModelProvider, materialize,
};
use p02_contracts::{CharacterStorage, FileStoreBackend, Rang, RoleModelAdapter};
use p02_core::{SpeakerName, Timestamp};
use p02_phone::SetRing;
use p02_plugins::{PHONE_PLUGIN, PluginHost};
use p02_role_model::{NvidiaSettings, select_adapter};
use p02_runtime::{Character, CompletedTurn, Conversation, Delivery, Mind, Progress, Submission};
use p02_shared::{Identifier, error_sentence};
use p02_store::{CharacterData, Inbox, QueuedLine, RuntimeRejection, StorageError};
use p02_wire::{
    CharacterState, Diagnostic, Event, MaintenanceFailure, OpenOutcome, OpenRefusal, RunningTurn,
    TurnRefusal, TurnStamp, TurnStatus,
};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;

use crate::config_control::CharacterConfig;
use crate::confirmation::Broker;
use crate::daemon::{Daemon, WeakDaemon, World, blocking};
use crate::outcome::{duplicate, running_turn, storage_failure, told};
use crate::reconcile::settings_now;
use crate::rings::{Rings, rang};

/// What a character whose settings choose no AI service needs, which the
/// settings page answers.
const NO_SERVICE: &str = "Choose an AI service.";

/// What a character's actor publishes of her, read without a round trip.
#[derive(Clone, Debug)]
pub(crate) struct CharacterHealth {
    pub(crate) state: CharacterState,
    /// Why she failed, while she is failed; what she needs, while she needs
    /// a model; what her start warned of, while she is ready.
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
                quiet: None,
                rings: Rings::default(),
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

    /// Whether a line queued for her now is one she takes: she is starting,
    /// ready, or waits for a model, and no failure of hers waits for the
    /// person.
    pub(crate) fn takes_lines(&self) -> bool {
        matches!(
            self.health.borrow().state,
            CharacterState::Starting | CharacterState::Ready | CharacterState::NeedsModel
        )
    }

    /// Whether her actor is gone: stopped, or ended without saying so.
    pub(crate) fn gone(&self) -> bool {
        self.health.borrow().state == CharacterState::Stopped || self.health.has_changed().is_err()
    }

    /// Answered once her start settles. A boot in flight is joined, so a
    /// failure it ends in is answered and not tried again; otherwise she is
    /// asked: she boots again when she has failed, and is brought up to
    /// date with her settings when she is built, ready or waiting for a
    /// model, unless a turn of hers runs, which meets them before its next
    /// request.
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
/// the model she answers with, or what she needs for one, the plugins she
/// answers with, her model's window, and those settings, which her next
/// request compares with what they say then.
#[derive(Debug)]
struct Built {
    character: Character,
    data: CharacterData,
    person: SpeakerName,
    context_window: NonZeroU64,
    model: Result<Arc<dyn RoleModelAdapter>, String>,
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

/// A character built, and the state that leaves her in: ready, with what
/// her start warns of, or waiting for a model.
struct Assembled {
    built: Built,
    state: Change,
}

/// A change of her state, with what it carries.
enum Change {
    Starting,
    Ready { warning: Option<String> },
    NeedsModel(String),
    Failed(String),
    Stopping,
    Stopped { failures: Option<String> },
}

struct Actor {
    her: Her,
    commands: mpsc::UnboundedReceiver<Command>,
    parts: Option<Parts>,
    /// Since when she has been quiet in this run: since her thread with the
    /// person opened, her last turn ended, or her boot found her thread
    /// made before; none while her thread has never been made.
    quiet: Option<Instant>,
    /// Her phone's rings, which this run keeps: a restart after a turn the
    /// runtime failed is not a start, so a ring held stays held.
    rings: Rings,
}

/// What begins a turn of hers: the person's line, what rang on her phone,
/// or her heartbeat.
#[derive(Debug)]
enum Cause {
    Line(QueuedLine),
    Rang(Vec<SetRing>),
    Heartbeat,
}

impl Cause {
    fn line(&self) -> Option<&QueuedLine> {
        match self {
            Self::Line(line) => Some(line),
            Self::Rang(_) | Self::Heartbeat => None,
        }
    }

    /// What rang, as the moment it begins tells her: none but for her
    /// phone's rings.
    fn rang(&self) -> Vec<Rang> {
        match self {
            Self::Rang(rings) => rang(rings),
            Self::Line(_) | Self::Heartbeat => Vec::new(),
        }
    }
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

            let waking = self.waking();

            tokio::select! {
                biased;
                () = self.her.stop.cancelled() => break,
                command = self.commands.recv() => match command {
                    Some(command) => self.handle(command).await,
                    // The daemon let go of her without a stop.
                    None => break,
                },
                () = sleep_until(waking.unwrap_or_else(Instant::now)), if waking.is_some() => {
                    self.wake().await;
                }
            }
        }

        self.stop_now().await;
    }

    /// When she next wakes by herself, while she is ready: when her
    /// heartbeat's moment is due, or when the wall clock is read again for
    /// her next ring, whichever comes first.
    fn waking(&self) -> Option<Instant> {
        let ring = (self.her.state() == CharacterState::Ready)
            .then(|| self.rings.wait(&Timestamp::now()))
            .flatten()
            .map(|wait| Instant::now() + wait);

        self.due().into_iter().chain(ring).min()
    }

    /// She woke by herself: what rang on her phone by the wall clock begins
    /// a moment of her own, and when nothing did, her heartbeat begins one
    /// once it is due.
    async fn wake(&mut self) {
        let rang = self.rings.due(&Timestamp::now());

        if !rang.is_empty() {
            self.moment(Cause::Rang(rang)).await;
        } else if self.due().is_some_and(|due| due <= Instant::now()) {
            self.moment(Cause::Heartbeat).await;
        }
    }

    /// When her next moment of her own is due: one period of her heartbeat
    /// after she has been quiet since, while she is ready and her heartbeat
    /// is not off. A moment missed is never made up: she has been quiet
    /// since an instant of this run.
    fn due(&self) -> Option<Instant> {
        let minutes = self
            .parts
            .as_ref()
            .filter(|_| self.her.state() == CharacterState::Ready)?
            .built
            .settings
            .host()
            .heartbeat?;

        self.quiet?.checked_add(
            self.her
                .world
                .durations
                .minute
                .saturating_mul(minutes.get()),
        )
    }

    async fn handle(&mut self, command: Command) {
        match command {
            Command::Start(reply) => {
                match self.her.state() {
                    CharacterState::Failed => self.boot().await,
                    CharacterState::Ready | CharacterState::NeedsModel => {
                        if let Ok(parts) = self.current().await {
                            self.parts = Some(parts);
                        }
                    }
                    _ => {}
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
    /// ready and her settings still build her with a model: true when she
    /// took one.
    async fn take_next(&mut self) -> bool {
        let Some(line) = self.oldest_queued().await else {
            return false;
        };
        // Her stop came, or her settings no longer give her a model: the
        // line waits in her inbox.
        let Some((parts, adapter)) = self.runnable().await else {
            return false;
        };
        let turn = running_turn(
            self.her.id.clone(),
            line.conversation_id.clone(),
            Some(&line),
        );

        self.take(parts, adapter, turn, Cause::Line(line)).await;
        true
    }

    /// A moment of her own, which `cause` begins, what rang on her phone or
    /// her heartbeat: she is brought up to date with her settings first,
    /// and it runs through her thread while they still give her a model,
    /// and her heartbeat's while they still give her a heartbeat. A moment
    /// whose thread cannot be opened never begins, and is noted as
    /// maintenance; what it would have told waits, as what a moment told
    /// that did not complete does.
    async fn moment(&mut self, cause: Cause) {
        let Some((mut parts, adapter)) = self.runnable().await else {
            return;
        };

        if matches!(cause, Cause::Heartbeat) && parts.built.settings.host().heartbeat.is_none() {
            self.parts = Some(parts);
            return;
        }

        let held = self
            .hold(&mut parts.thread, &parts.built.character)
            .await
            .map(|thread| thread.id().clone());

        match held {
            Ok(conversation) => {
                let turn = running_turn(self.her.id.clone(), conversation, None);

                self.take(parts, adapter, turn, cause).await;
            }
            Err(error) => {
                self.parts = Some(parts);
                self.quiet = Some(Instant::now());

                if let Cause::Rang(told) = cause {
                    self.rings.hold(told);
                }

                self.her.note_maintenance(error_sentence(&error));
            }
        }
    }

    /// Her parts brought up to date with her settings, and the model they
    /// give her; none, her parts kept, once her stop came or while they
    /// give her no model.
    async fn runnable(&mut self) -> Option<(Parts, Arc<dyn RoleModelAdapter>)> {
        let parts = self.current().await.ok()?;

        match &parts.built.model {
            Ok(adapter) if !self.her.stop.is_cancelled() => {
                let adapter = Arc::clone(adapter);

                Some((parts, adapter))
            }
            _ => {
                self.parts = Some(parts);
                None
            }
        }
    }

    /// Takes `turn` through her thread on `parts` with `adapter` her model,
    /// as `cause` began it. Once it ended, however it ended, she has been
    /// quiet since; the line that began it leaves her inbox, her phone is
    /// looked at again, what rang handed to its apps once the moment it
    /// began completed, and only then is the end announced, so a client
    /// that hears it and sends the line again is answered as her thread has
    /// it, and finds her phone as the turn left it. A turn the runtime
    /// fails leaves her failed, and she is built again behind it; her inbox
    /// failing fails her.
    async fn take(
        &mut self,
        mut parts: Parts,
        adapter: Arc<dyn RoleModelAdapter>,
        turn: RunningTurn,
        cause: Cause,
    ) {
        let taken = self.turn(&mut parts, adapter, &turn, &cause).await;
        let data = parts.built.data.clone();
        let phone = parts.built.phone();

        self.parts = Some(parts);
        self.quiet = Some(Instant::now());

        let (ending, failure) = self.ended(taken);
        let (removed, told) = match cause {
            Cause::Line(line) => (blocking(move || data.unqueue(&line)).await, Vec::new()),
            Cause::Rang(told) => (Ok(()), told),
            Cause::Heartbeat => (Ok(()), Vec::new()),
        };
        let completed = ending.status == TurnStatus::Completed;
        let phoned = self.rings.after_turn(phone, told, completed).await;

        self.her.noted(&phoned);
        self.her.world.events.emit(ending.announced(turn));

        match (removed, failure) {
            (Err(error), _) => self.fail(error_sentence(&error)).await,
            (Ok(()), Some(failure)) => {
                self.her.publish(Change::Failed(failure));
                self.restart().await;
            }
            (Ok(()), None) => {}
        }
    }

    /// Takes `turn` through her thread on `parts`, opened before it begins,
    /// with `adapter` her model, as `cause` began it. While it runs she
    /// still hears what she is asked: an open of her thread is answered at
    /// once, and so is a start, since she runs.
    async fn turn(
        &mut self,
        parts: &mut Parts,
        adapter: Arc<dyn RoleModelAdapter>,
        turn: &RunningTurn,
        cause: &Cause,
    ) -> Result<(Delivery, bool), Ending> {
        let Parts { built, thread } = parts;
        let thread = self
            .hold(thread, &built.character)
            .await
            .map_err(|error| Ending::failed(error_sentence(&error), false))?;
        let opened = OpenOutcome::Opened {
            conversation_id: thread.id().clone(),
            character_id: self.her.id.clone(),
        };
        let mut taking = std::pin::pin!(take_turn(
            &self.her,
            thread,
            built,
            adapter,
            turn.clone(),
            cause
        ));

        loop {
            tokio::select! {
                biased;
                taken = &mut taking => break Ok(taken),
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

    /// Her parts to use, brought up to date with her settings first, which
    /// may leave her with a model or without one, her phone's rings read
    /// again when she was built anew; or the sentence she refuses with
    /// while she is not built, or once her settings no longer build her,
    /// which fails her.
    async fn current(&mut self) -> Result<Parts, String> {
        let mut parts = match self.parts.take() {
            Some(parts)
                if matches!(
                    self.her.state(),
                    CharacterState::Ready | CharacterState::NeedsModel
                ) =>
            {
                parts
            }
            unready => {
                self.parts = unready;
                return Err(self.her.not_ready());
            }
        };

        match self.her.refresh(&mut parts.built).await {
            // Built again, she may run her phone no longer, or only now.
            Ok(true) => {
                let phoned = self.rings.read(parts.built.phone()).await;

                self.her.noted(&phoned);
            }
            Ok(false) => {}
            Err(failure) => {
                self.parts = Some(parts);
                self.fail(failure).await;
                return Err(self.her.not_ready());
            }
        }

        Ok(parts)
    }

    /// Her thread with the person, opened on the blocking pool the first
    /// time it is asked for, when she has been quiet since; what the open
    /// read past is noted as maintenance.
    async fn hold<'t>(
        &mut self,
        thread: &'t mut Option<Conversation>,
        character: &Character,
    ) -> Result<&'t mut Conversation, StorageError> {
        let held = if let Some(held) = thread.take() {
            held
        } else {
            let home = self.her.world.home.clone();
            let character = character.clone();
            let opened = blocking(move || Conversation::open(&home, character)).await?;

            if let Some(skipped) = opened.skipped() {
                self.her.note_maintenance(skipped.to_owned());
            }

            self.quiet = Some(Instant::now());
            opened
        };

        Ok(thread.insert(held))
    }

    /// Builds her, and reads her phone's rings once she is.
    async fn boot(&mut self) {
        self.her.publish(Change::Starting);

        match self.her.assemble().await {
            Ok(Assembled { built, state }) => {
                let phone = built.phone();

                self.quiet = self.her.met(&built.character).await.then(Instant::now);
                self.parts = Some(Parts {
                    built,
                    thread: None,
                });

                let phoned = self.rings.read(phone).await;

                self.her.noted(&phoned);
                self.her.settle(state);
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
        let held = self
            .hold(&mut parts.thread, &parts.built.character)
            .await
            .map(|thread| thread.id().clone());

        self.parts = Some(parts);

        match held {
            Ok(conversation_id) => OpenOutcome::Opened {
                conversation_id,
                character_id: self.her.id.clone(),
            },
            Err(error) => OpenOutcome::Failed(storage_failure(&error)),
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
/// the line that began it is in the log, as a turn of her own, which has
/// none, always says, and why when it did not complete.
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

    /// The completion of `turn`, which ends it.
    fn announced(self, turn: RunningTurn) -> Event {
        Event::TurnCompleted {
            character_id: turn.character_id,
            conversation_id: turn.conversation_id,
            source: turn.source,
            client_message_id: turn.client_message_id,
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
            Change::NeedsModel(needed) => (
                CharacterState::NeedsModel,
                Some(needed.clone()),
                Some(needed),
            ),
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

    /// Whether her thread with the person was ever made: found, never
    /// made. A home whose threads cannot be read says no, and the open that
    /// a line or a client asks for says why.
    async fn met(&self, character: &Character) -> bool {
        let home = self.world.home.clone();
        let id = character.profile.id.clone();

        matches!(
            blocking(move || Conversation::exists(&home, &id)).await,
            Ok(true)
        )
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
    /// once the turn in flight ends. True when she was built again, with a
    /// model or waiting for one; what she ran on until then is let go, what
    /// failed of that noted as maintenance.
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
            state,
        } = self.assemble().await?;

        self.noted(&std::mem::replace(built, rebuilt).shut_down().await);
        self.settle(state);
        Ok(true)
    }
}

/// Her parts as a turn runs on them, brought up to date with her settings
/// before each of its requests after the first, and the model it runs on.
struct Current<'a> {
    her: &'a Her,
    built: &'a mut Built,
    adapter: Arc<dyn RoleModelAdapter>,
}

#[async_trait]
impl Mind for Current<'_> {
    fn person(&self) -> &SpeakerName {
        &self.built.person
    }

    fn adapter(&self) -> &dyn RoleModelAdapter {
        self.adapter.as_ref()
    }

    fn host(&self) -> &PluginHost {
        &self.built.host
    }

    fn context_window(&self) -> NonZeroU64 {
        self.built.context_window
    }

    /// Settings that no longer give her a model end the turn, as settings
    /// that no longer build her do.
    async fn refresh(&mut self) -> Result<bool, String> {
        let rebuilt = self.her.refresh(self.built).await?;

        self.adapter = self.built.model.clone()?;
        Ok(rebuilt)
    }
}

impl Built {
    /// Ends her plugins: what failed, a sentence each.
    async fn shut_down(self) -> Vec<String> {
        self.host.shutdown().await.failures()
    }

    /// Her phone's store, while her plugins include her phone.
    fn phone(&self) -> Option<Arc<dyn FileStoreBackend>> {
        self.host
            .plugin_ids()
            .find(|id| id.as_str() == PHONE_PLUGIN)
            .map(|id| self.data.file_store(id))
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

/// Takes `turn` through `thread`, as `built` answers it through `adapter`:
/// the turn of a line, when `cause` is one, or else a moment of her own,
/// which tells her what rang. What the runtime made of it, and whether its
/// line was heard committed, as a moment, with none to commit, always is.
/// The stream is told the turn as it goes: a moment as it begins, then
/// each message and tool call, and the turn as it runs whenever that
/// changes.
async fn take_turn(
    her: &Her,
    thread: &mut Conversation,
    built: &mut Built,
    adapter: Arc<dyn RoleModelAdapter>,
    turn: RunningTurn,
    cause: &Cause,
) -> (Delivery, bool) {
    let line = cause.line();
    let committed = AtomicBool::new(line.is_none());
    let running = Mutex::new(turn);
    let listener = |progress: Progress| {
        if matches!(progress, Progress::UserMessage { .. }) {
            committed.store(true, Ordering::Relaxed);
        }

        let events = told(
            &mut running.lock().unwrap_or_else(PoisonError::into_inner),
            progress,
        );

        for event in events {
            her.world.events.emit(event);
        }
    };
    let mut mind = Current {
        her,
        built,
        adapter,
    };

    her.broker.running(line.map(|line| TurnStamp {
        conversation_id: line.conversation_id.clone(),
        source: line.source.clone(),
        client_message_id: line.client_message_id.clone(),
    }));

    let delivery = if let Some(line) = line {
        thread
            .deliver(
                Submission {
                    line: &line.text,
                    source: line.source.clone(),
                    client_message_id: line.client_message_id.clone(),
                },
                &mut mind,
                &listener,
            )
            .await
    } else {
        // No line's commit says it runs, so it is said as it begins: every
        // surface knows whose turn what follows belongs to.
        her.world.events.emit(Event::TurnRunning(
            running
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone(),
        ));
        thread.moment(cause.rang(), &mut mind, &listener).await
    };

    her.broker.running(None);
    (delivery, committed.into_inner())
}

/// Assembles character `id` from what the disk holds now: her package, her
/// settings, which must be readable, hold nothing that stops her, and
/// switch her on before anything is written for her, her package's
/// settings merged into her overlay, her model, or what she needs for one,
/// and her host built with `broker` to ask the person and her settings for
/// its own plugin to read and change, through `daemon`.
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
            "Character \"{id}\" is switched off. Switch her on in her settings to start her."
        ));
    }

    let data = materialize(
        &world.home,
        &world.sections,
        definition,
        world.durations.settings_lock,
    )
    .map_err(|error| unmaterialized(id, error))?;
    let model = model(world, settings.host());
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
        state: match &model {
            Ok(_) => Change::Ready {
                warning: (!cautions.is_empty()).then(|| cautions.join(" ")),
            },
            Err(needed) => Change::NeedsModel(needed.clone()),
        },
        built: Built {
            character: Character {
                profile: definition.profile.clone(),
                persona: definition.persona.clone(),
            },
            data,
            person: settings.host().user_display_name.clone(),
            context_window: settings.host().context_window_tokens,
            model,
            host,
            settings,
        },
    })
}

/// Her model: the one the test switch puts in every character's place,
/// else the service her settings choose, built; or the sentence saying
/// what they need for one. Her settings' view asks this too, so the page
/// says what she says.
pub(crate) fn model(
    world: &World,
    host: &HostSettings,
) -> Result<Arc<dyn RoleModelAdapter>, String> {
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
        Ok(None) => Err(NO_SERVICE.to_owned()),
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
