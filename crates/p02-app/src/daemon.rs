//! The daemon: the one object every surface reaches the characters
//! through. It holds the actors, the routes from conversations to them, the
//! ledger of submissions, the reconciler and the events, and answers every
//! condition a client can reach with an outcome, never an error.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::join_all;
use p02_characters::{CharacterDefinition, Discovery, discover};
use p02_config::{Connector, Sections, connectors};
use p02_contracts::{FactoryInput, Manifest, PluginError, RoleModelAdapter, RuntimePlugin};
use p02_core::{ClientStamp, Conversation, ConversationId, Participant, VisibleMessageRole};
use p02_shared::Identifier;
use p02_store::{Home, StorageError};
use tokio::sync::broadcast;

use crate::character::{CharacterHandle, Request};
use crate::confirmation::Answer;
use crate::history::{self, HistoryPage};
use crate::outcome::{
    CharacterSummary, ConfigHealth, ConfirmationAnswer, ConnectorPresence, Event, Health,
    HistoryOutcome, OpenOutcome, OpenRefusal, PROTOCOL_VERSION, PackageReport, PackagesHealth,
    PendingConfirmation, ReconcilePlan, RunningTurn, RunningTurns, StartOutcome, StartRefusal,
    TurnOutcome, TurnRefusal, TurnStamp, sentence,
};
use crate::reconcile::{Reconciler, Roster, settings_now};
use crate::submissions::{Ledger, Line};

/// How far a subscriber may fall behind the events before it misses some,
/// which it is then told.
const EVENT_BACKLOG: usize = 1024;

type Factory =
    dyn Fn(&FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> + Send + Sync;

/// A plugin the daemon can run for a character: its manifest, and what
/// builds an instance of it from her settings.
#[derive(Clone)]
pub struct Plugin {
    manifest: Manifest,
    factory: Arc<Factory>,
}

impl Plugin {
    #[must_use]
    pub fn new(
        manifest: Manifest,
        factory: impl Fn(&FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        Self {
            manifest,
            factory: Arc::new(factory),
        }
    }

    pub(crate) fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub(crate) fn factory(
        &self,
    ) -> impl Fn(&FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> + Send + Sync + 'static
    {
        let factory = Arc::clone(&self.factory);

        move |input| factory(input)
    }
}

impl fmt::Debug for Plugin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Plugin")
            .field("id", self.manifest.id())
            .finish_non_exhaustive()
    }
}

/// The waits the daemon keeps, each its own unless a test harness shortens
/// it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Durations {
    /// How long a confirmation waits for the person's answer.
    pub confirmation: Duration,
    /// How long the model may say nothing; the provider's own bound when
    /// none.
    pub model_silence: Option<Duration>,
    /// How long a settings document's lock is waited for while its holder
    /// makes no progress, the wait starting again whenever it changes
    /// hands: as long as the store waits out a short guarded write, since
    /// characters start together and one's first start on a loaded disk
    /// holds the home's lock a while.
    pub settings_lock: Duration,
}

impl Default for Durations {
    fn default() -> Self {
        Self {
            confirmation: Duration::from_mins(5),
            model_silence: None,
            settings_lock: Duration::from_secs(10),
        }
    }
}

/// What the binary resolves and the daemon cannot decide.
#[derive(Debug)]
pub struct DaemonSettings {
    /// The model every character answers through, whatever her settings
    /// choose: what the test switch names, and never a setting.
    pub test_provider: Option<Arc<dyn RoleModelAdapter>>,
    pub durations: Durations,
    /// The plugins compiled into the daemon.
    pub plugins: Vec<Plugin>,
}

/// A line a client delivers into a conversation, as the client sent it:
/// the daemon judges every part of it.
#[derive(Clone, Debug)]
pub struct Message {
    pub conversation_id: String,
    pub sender_id: String,
    pub text: String,
    /// The surface the line came from.
    pub source: String,
    /// The id the client submitted the line under, which a repeat reuses.
    pub client_message_id: String,
}

/// Why a daemon could not be opened on a home.
#[derive(Debug, thiserror::Error)]
#[error("the home is refused")]
pub struct OpenDaemonError {
    #[source]
    source: StorageError,
}

/// What every actor of the daemon reads and nothing changes: the home, the
/// settings' sections, the plugins, the waits, the model that stands in
/// for every character's, and the events.
#[derive(Debug)]
pub(crate) struct World {
    pub(crate) home: Home,
    pub(crate) sections: Sections,
    pub(crate) plugins: Vec<Plugin>,
    pub(crate) durations: Durations,
    pub(crate) test_provider: Option<Arc<dyn RoleModelAdapter>>,
    pub(crate) events: Arc<Events>,
}

impl World {
    pub(crate) fn plugin(&self, id: &Identifier) -> Option<&Plugin> {
        self.plugins
            .iter()
            .find(|plugin| plugin.manifest.id() == id)
    }
}

/// Every event, announced in one order: the running turns are folded from
/// them in the order every subscriber hears them.
#[derive(Debug)]
pub(crate) struct Events {
    sender: broadcast::Sender<Event>,
    running: Mutex<RunningTurns>,
}

impl Events {
    pub(crate) fn new() -> Self {
        Self {
            sender: broadcast::channel(EVENT_BACKLOG).0,
            running: Mutex::new(RunningTurns::default()),
        }
    }

    pub(crate) fn emit(&self, event: Event) {
        let mut running = self.running.lock().unwrap_or_else(PoisonError::into_inner);

        running.fold(&event);
        // Nobody listening is no failure.
        let _ = self.sender.send(event);
    }
}

/// The façade the daemon's surfaces hold. Cloning it shares the one
/// daemon.
#[derive(Clone, Debug)]
pub struct Daemon {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    world: Arc<World>,
    characters: Mutex<Characters>,
    /// Which character each conversation this run routed belongs to. A
    /// delivery holds it from its routing until its line is in her queue,
    /// and deliveries take it in the order they came.
    routes: tokio::sync::Mutex<HashMap<ConversationId, Identifier>>,
    ledger: Arc<Ledger>,
    reconciler: Arc<Reconciler>,
    /// How many streams of each connector are open.
    presence: Mutex<BTreeMap<Identifier, usize>>,
}

/// The actors the daemon built, and whether it stopped, which ends every
/// start.
#[derive(Debug, Default)]
struct Characters {
    stopped: bool,
    handles: BTreeMap<Identifier, Arc<CharacterHandle>>,
}

/// A connector's stream counted as present while this is held: health
/// shows the connector connected, and the stream's end lets it go.
#[derive(Debug)]
#[must_use = "a connector counts as present only while its presence is held"]
pub struct Presence {
    daemon: Daemon,
    connector: Identifier,
    runtime: tokio::runtime::Handle,
}

impl Drop for Presence {
    fn drop(&mut self) {
        let last = {
            let mut presence = self.daemon.inner.presence();
            let count = presence.entry(self.connector.clone()).or_default();

            *count = count.saturating_sub(1);
            *count == 0
        };

        if last {
            let daemon = self.daemon.clone();

            self.runtime
                .spawn(async move { daemon.health_changed().await });
        }
    }
}

impl Inner {
    fn characters(&self) -> MutexGuard<'_, Characters> {
        self.characters
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn presence(&self) -> MutexGuard<'_, BTreeMap<Identifier, usize>> {
        self.presence.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Daemon {
    /// The daemon of `home`, which is checked, never made, and on which
    /// nothing starts until a reconcile or a start asks.
    ///
    /// # Errors
    ///
    /// [`OpenDaemonError`] when the store refuses the home.
    pub async fn open(home: Home, settings: DaemonSettings) -> Result<Self, OpenDaemonError> {
        let checked = home.clone();

        blocking(move || checked.check())
            .await
            .map_err(|source| OpenDaemonError { source })?;

        let DaemonSettings {
            test_provider,
            durations,
            plugins,
        } = settings;

        Ok(Self {
            inner: Arc::new(Inner {
                world: Arc::new(World {
                    home,
                    sections: Sections::new(plugins.iter().map(|plugin| plugin.manifest.clone())),
                    plugins,
                    durations,
                    test_provider,
                    events: Arc::new(Events::new()),
                }),
                characters: Mutex::default(),
                routes: tokio::sync::Mutex::default(),
                ledger: Arc::default(),
                reconciler: Arc::default(),
                presence: Mutex::default(),
            }),
        })
    }

    /// The daemon's whole state, read now: the roster as the disk says it
    /// is, each character's state as her actor published it, and the
    /// connectors on the stream.
    pub async fn health(&self) -> Health {
        let roster = self.roster().await;

        Health {
            protocol_version: PROTOCOL_VERSION,
            home_root: self.inner.world.home.root().display().to_string(),
            config: ConfigHealth {
                diagnostics: roster.home_diagnostics.clone(),
            },
            packages: PackagesHealth {
                diagnostics: roster
                    .discovery
                    .diagnostics
                    .iter()
                    .map(PackageReport::from)
                    .collect(),
            },
            characters: roster
                .characters()
                .map(|(definition, settings)| {
                    self.summary(
                        definition,
                        settings.is_none_or(|settings| settings.host().enabled),
                    )
                })
                .collect(),
            connectors: {
                let presence = self.inner.presence();

                connectors()
                    .iter()
                    .map(|connector| ConnectorPresence {
                        id: connector.id().clone(),
                        connected: presence.get(connector.id()).is_some_and(|count| *count > 0),
                    })
                    .collect()
            },
        }
    }

    /// A page of `conversation`'s scrollback, read from the store, so that a
    /// stopped character's thread reads too.
    pub async fn history(&self, conversation: &str, page: HistoryPage) -> HistoryOutcome {
        let home = self.inner.world.home.clone();
        let conversation = conversation.to_owned();

        blocking(move || history::read(&home, &conversation, &page)).await
    }

    /// The thread between `character` and the person, opened on her the
    /// first time; every later open answers the same.
    pub async fn open_conversation(&self, character: &str) -> OpenOutcome {
        let Some(handle) = Identifier::new(character)
            .ok()
            .and_then(|id| self.live(&id))
        else {
            let (reason, message) = match self.unreached(character).await {
                Unreached::NotInstalled(message) => (OpenRefusal::UnknownCharacter, message),
                Unreached::Unavailable(message) => (OpenRefusal::CharacterUnavailable, message),
            };

            return OpenOutcome::Refused { reason, message };
        };
        let opened = handle.open().await;

        if let OpenOutcome::Opened {
            conversation_id,
            character_id,
            ..
        } = &opened
        {
            self.inner
                .routes
                .lock()
                .await
                .insert(conversation_id.clone(), character_id.clone());
        }

        opened
    }

    /// Takes `message` to the character its conversation belongs to, once
    /// per submission, and announces how the delivery ended. Its routing
    /// and its place in her queue are one step, which lines take in the
    /// order they came, so they reach her in that order.
    pub async fn deliver(&self, message: Message) -> TurnOutcome {
        let (Ok(source), Ok(client_message_id)) = (
            ClientStamp::new(&message.source),
            ClientStamp::new(&message.client_message_id),
        ) else {
            return TurnOutcome::refused(
                TurnRefusal::InvalidMessage,
                "A message names its source and its own id as single tokens: letters, digits, \
                 and any of \":._-\", at most 64 characters."
                    .to_owned(),
            );
        };
        let outcome = {
            let mut routes = self.inner.routes.lock().await;
            let (conversation, character) =
                match self.route(&mut routes, &message.conversation_id).await {
                    Ok(found) => found,
                    Err(refused) => return refused,
                };
            let stamp = TurnStamp {
                conversation_id: conversation.clone(),
                source: source.clone(),
                client_message_id: client_message_id.clone(),
            };
            let line = Line {
                sender: message.sender_id.clone(),
                source,
                text: message.text.clone(),
            };

            self.inner
                .ledger
                .submit(conversation, client_message_id, line, || {
                    self.take(character, stamp, message)
                })
        };

        outcome.await
    }

    /// The confirmations parked now, by character, oldest first.
    #[must_use]
    pub fn pending_confirmations(&self) -> Vec<PendingConfirmation> {
        self.handles()
            .iter()
            .flat_map(|handle| handle.broker().pending())
            .collect()
    }

    /// Answers the confirmation `id`, which the one character that parked
    /// it settles.
    #[must_use]
    pub fn answer_confirmation(&self, id: &str, answer: Answer) -> ConfirmationAnswer {
        self.handles()
            .iter()
            .map(|handle| handle.broker().answer(id, answer))
            .find(|answered| *answered != ConfirmationAnswer::Unknown)
            .unwrap_or(ConfirmationAnswer::Unknown)
    }

    /// Every event from now on. A stream that opens with a snapshot reads
    /// health, the pending confirmations and the running turns after it
    /// subscribes, so it hears every event after its snapshot, and at worst
    /// one the snapshot already holds.
    #[must_use]
    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.inner.world.events.sender.subscribe()
    }

    /// The turns in progress, each with its drafts so far.
    #[must_use]
    pub fn running_turns(&self) -> Vec<RunningTurn> {
        self.inner
            .world
            .events
            .running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .turns()
    }

    /// Starts `character`, or joins the start in flight, and answers once it
    /// settles: an explicit start is the person's retry of a failed one.
    pub async fn start_character(&self, character: &str) -> StartOutcome {
        let stopped = || StartOutcome::Refused {
            reason: StartRefusal::GatewayStopped,
            message: "The daemon is stopped.".to_owned(),
        };

        if self.inner.characters().stopped {
            return stopped();
        }

        let world = Arc::clone(&self.inner.world);
        let wanted = character.to_owned();
        let found = blocking(move || {
            discover(world.home.root())
                .find(&wanted)
                .cloned()
                .map_err(|error| sentence(&error))
        })
        .await;
        let definition = match found {
            Ok(definition) => definition,
            Err(message) => {
                return StartOutcome::Refused {
                    reason: StartRefusal::UnknownCharacter,
                    message,
                };
            }
        };

        if !self.begin(&definition.profile.id).await {
            return stopped();
        }

        let world = Arc::clone(&self.inner.world);
        let (definition, settings) = blocking(move || {
            let settings = settings_now(&world, &definition);

            (definition, settings)
        })
        .await;

        StartOutcome::Settled {
            character: self.summary(
                &definition,
                settings.is_none_or(|settings| settings.host().enabled),
            ),
        }
    }

    /// Makes the running characters match the settings. A request while a
    /// pass runs joins it and marks one more pass after it, so the newest
    /// roster has the last word; passes never overlap.
    pub async fn reconcile(&self) -> ReconcilePlan {
        if self.inner.characters().stopped {
            return ReconcilePlan::default();
        }

        let daemon = self.clone();

        self.inner
            .reconciler
            .reconcile(move || {
                let daemon = daemon.clone();

                Box::pin(async move { daemon.pass().await })
            })
            .await
    }

    /// What the gateway calls once a settings change landed: the roster as
    /// it now stands goes out at once, to every surface, and a reconcile
    /// pass acts on it behind the answer.
    pub async fn settings_changed(&self) {
        self.health_changed().await;

        let daemon = self.clone();

        tokio::spawn(async move { daemon.reconcile().await });
    }

    /// Counts a stream of `connector` present until the presence is let go;
    /// health changes when the count crosses zero.
    pub async fn connector_present(&self, connector: &Connector) -> Presence {
        let first = {
            let mut presence = self.inner.presence();
            let count = presence.entry(connector.id().clone()).or_default();

            *count += 1;
            *count == 1
        };

        if first {
            self.health_changed().await;
        }

        Presence {
            daemon: self.clone(),
            connector: connector.id().clone(),
            runtime: tokio::runtime::Handle::current(),
        }
    }

    /// Stops every character, for good: no start follows. A boot, a reload
    /// or a recovery in flight is overtaken, a turn in flight finishes, and
    /// the reconcile pass in flight is waited for.
    pub async fn stop(&self) {
        let handles: Vec<Arc<CharacterHandle>> = {
            let mut characters = self.inner.characters();

            characters.stopped = true;
            characters.handles.values().cloned().collect()
        };

        for handle in &handles {
            handle.signal_stop();
        }

        self.inner.reconciler.settled().await;
        join_all(handles.iter().map(|handle| handle.stopped())).await;
    }

    pub(crate) fn handle(&self, id: &Identifier) -> Option<Arc<CharacterHandle>> {
        self.inner.characters().handles.get(id).cloned()
    }

    pub(crate) fn handles(&self) -> Vec<Arc<CharacterHandle>> {
        self.inner.characters().handles.values().cloned().collect()
    }

    /// The roster as the disk says it is now.
    pub(crate) async fn roster(&self) -> Roster {
        let world = Arc::clone(&self.inner.world);

        blocking(move || Roster::read(&world)).await
    }

    /// Starts `id` on her actor, built now unless one runs: answered once
    /// her start settles; false once the daemon stopped.
    pub(crate) async fn begin(&self, id: &Identifier) -> bool {
        match self.running(id).await {
            Some(handle) => {
                handle.start().await;
                true
            }
            None => false,
        }
    }

    /// Her actor, built now unless one runs; one whose stop is under way is
    /// waited for first, so that one actor at a time holds what is hers.
    /// None once the daemon stopped.
    async fn running(&self, id: &Identifier) -> Option<Arc<CharacterHandle>> {
        loop {
            let stopping = {
                let mut characters = self.inner.characters();

                if characters.stopped {
                    return None;
                }

                match characters.handles.get(id) {
                    Some(handle) if !handle.ended() => return Some(Arc::clone(handle)),
                    Some(handle) if !handle.gone() => Arc::clone(handle),
                    _ => {
                        let handle = Arc::new(CharacterHandle::spawn(
                            Arc::clone(&self.inner.world),
                            id.clone(),
                        ));

                        characters.handles.insert(id.clone(), Arc::clone(&handle));
                        return Some(handle);
                    }
                }
            };

            stopping.stopped().await;
        }
    }

    async fn health_changed(&self) {
        let health = self.health().await;

        self.inner
            .world
            .events
            .emit(Event::HealthChanged { health });
    }

    fn summary(&self, definition: &CharacterDefinition, enabled: bool) -> CharacterSummary {
        let health = self
            .handle(&definition.profile.id)
            .map(|handle| handle.health());

        CharacterSummary {
            id: definition.profile.id.clone(),
            display_name: definition.profile.display_name.clone(),
            enabled,
            state: health.as_ref().map(|health| health.state),
            diagnostic: health.as_ref().and_then(|health| health.diagnostic.clone()),
            maintenance: health.and_then(|health| health.maintenance),
        }
    }

    /// Her actor while it takes lines. Who runs is the reconciler's to say,
    /// so the roster is not read to reach her: the next reconcile stops one
    /// whose package left, and she is then no character to reach.
    pub(crate) fn live(&self, id: &Identifier) -> Option<Arc<CharacterHandle>> {
        self.handle(id).filter(|handle| !handle.ended())
    }

    /// A new submission's line put in her queue at once, unless she takes
    /// none now, and how its delivery ended, announced to every surface.
    fn take(
        &self,
        character: Identifier,
        stamp: TurnStamp,
        message: Message,
    ) -> impl Future<Output = TurnOutcome> + Send + 'static {
        let answer = match self.live(&character) {
            // Refused at once, while a turn ahead of it still runs.
            Some(_) if message.sender_id != Participant::local_user_id().as_str() => {
                std::future::ready(TurnOutcome::refused(
                    TurnRefusal::SenderNotSupported,
                    format!(
                        "Conversation \"{}\" accepts messages from its local user only; \"{}\" \
                         is not driven yet.",
                        stamp.conversation_id, message.sender_id
                    ),
                ))
                .boxed()
            }
            Some(handle) => handle
                .deliver(Request {
                    stamp: stamp.clone(),
                    text: message.text,
                })
                .boxed(),
            None => {
                let daemon = self.clone();
                let character = character.clone();

                async move {
                    match daemon.unreached(character.as_str()).await {
                        Unreached::NotInstalled(sentence) => {
                            TurnOutcome::refused(TurnRefusal::UnknownCharacter, sentence)
                        }
                        Unreached::Unavailable(sentence) => {
                            TurnOutcome::refused(TurnRefusal::CharacterUnavailable, sentence)
                        }
                    }
                }
                .boxed()
            }
        };
        let events = Arc::clone(&self.inner.world.events);

        async move {
            let outcome = answer.await;

            events.emit(Event::turn_completed(character, stamp, &outcome));
            outcome
        }
    }

    /// Why `character` takes nothing now, the roster read to say it: she is
    /// not installed, has no runtime, or hers takes nothing.
    async fn unreached(&self, character: &str) -> Unreached {
        let world = Arc::clone(&self.inner.world);
        let discovery = blocking(move || discover(world.home.root())).await;

        let Some(definition) = installed(&discovery, character) else {
            let installed: Vec<&str> = discovery
                .characters
                .iter()
                .map(|definition| definition.profile.id.as_str())
                .collect();

            return Unreached::NotInstalled(format!(
                "Character \"{character}\" is not installed. Installed characters: {}.",
                if installed.is_empty() {
                    "(none)".to_owned()
                } else {
                    installed.join(", ")
                }
            ));
        };

        Unreached::Unavailable(match self.handle(&definition.profile.id) {
            Some(handle) => handle.unavailable(),
            None => format!("Character \"{character}\" has not been started."),
        })
    }

    /// The character `conversation` belongs to: the route this run holds from
    /// an open or an earlier delivery, else the store's record of it,
    /// remembered once found.
    async fn route(
        &self,
        routes: &mut HashMap<ConversationId, Identifier>,
        conversation: &str,
    ) -> Result<(ConversationId, Identifier), TurnOutcome> {
        let unknown = || {
            TurnOutcome::refused(
                TurnRefusal::UnknownConversation,
                format!("Conversation \"{conversation}\" does not exist."),
            )
        };
        let Ok(id) = ConversationId::new(conversation) else {
            return Err(unknown());
        };

        if let Some(character) = routes.get(&id).cloned() {
            return Ok((id, character));
        }

        let home = self.inner.world.home.clone();
        let wanted = id.clone();
        let character = match blocking(move || home.conversation(&wanted)).await {
            Ok(record) => character_of(&record).ok_or_else(|| {
                TurnOutcome::refused(
                    TurnRefusal::UnknownConversation,
                    format!("Conversation \"{id}\" has no character to answer it."),
                )
            })?,
            Err(StorageError::ConversationNotFound(_)) => return Err(unknown()),
            Err(error) => {
                return Err(TurnOutcome::refused(
                    TurnRefusal::ConversationUnreadable,
                    format!("Conversation \"{id}\" cannot be read: {}", sentence(&error)),
                ));
            }
        };

        routes.insert(id.clone(), character.clone());
        Ok((id, character))
    }
}

/// Why a character takes nothing now, in a sentence.
enum Unreached {
    NotInstalled(String),
    Unavailable(String),
}

/// The character among a conversation's participants.
pub(crate) fn character_of(conversation: &Conversation) -> Option<Identifier> {
    conversation
        .participants()
        .iter()
        .find(|participant| participant.kind == VisibleMessageRole::Character)
        .map(|participant| participant.id.clone())
}

fn installed<'d>(discovery: &'d Discovery, character: &str) -> Option<&'d CharacterDefinition> {
    discovery
        .characters
        .iter()
        .find(|definition| definition.profile.id.as_str() == character)
}

/// Runs `work` on the blocking pool, where the store may wait on a lock; a
/// panic there is the caller's, as it would be inline.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    match tokio::task::spawn_blocking(work).await {
        Ok(done) => done,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}
