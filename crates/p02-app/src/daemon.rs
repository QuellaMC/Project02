//! The daemon: the one object every surface reaches the characters
//! through. It holds the actors, the routes from conversations to them, the
//! reconciler and the events, and answers every condition a client can
//! reach with an outcome, never an error.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::join_all;
use p02_characters::{CharacterDefinition, discover, is_bundled};
use p02_config::{
    Connector, Sections, apply_change, config_view, connector_config_view, connectors,
};
use p02_contracts::{
    FactoryInput, Manifest, PluginError, RoleModelAdapter, RuntimePlugin, SetupCheck,
};
use p02_core::{ClientStamp, Conversation, ConversationId, VisibleMessageRole};
use p02_plugins::AppCatalog;
use p02_shared::{BaseUrl, Identifier, error_sentence};
use p02_store::{CharacterData, Home, QueuedLine, Queueing, StorageError};
use p02_wire::{
    Answer, ChangeOutcome, CharacterSummary, ConfigChange, ConfigHealth, ConfigTarget, ConfigView,
    ConfirmationAnswer, ConnectorBot, ConnectorBotsOutcome, ConnectorBotsRefusal,
    ConnectorConfigView, ConnectorPresence, Event, Health, HistoryOutcome, OpenOutcome,
    OpenRefusal, PackagesHealth, PendingConfirmation, ProtocolVersion, StartOutcome, StartRefusal,
    SubmitOutcome, TurnRefusal,
};
use tokio::sync::mpsc;

use crate::character::{CharacterHandle, model};
use crate::history::{self, HistoryPage};
use crate::outcome::{duplicate, package_report, storage_failure};
use crate::pairing::Pairings;
use crate::reconcile::{Reconciler, Roster, settings_now};

type Factory =
    dyn Fn(&FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> + Send + Sync;

/// A plugin the daemon can run for a character: its manifest, the check of
/// whether her settings are enough to build it, and what builds an
/// instance of it from them.
#[derive(Clone)]
pub struct Plugin {
    manifest: Manifest,
    check: SetupCheck,
    factory: Arc<Factory>,
}

impl Plugin {
    #[must_use]
    pub fn new(
        manifest: Manifest,
        check: SetupCheck,
        factory: impl Fn(&FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        Self {
            manifest,
            check,
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
    /// How long a pairing request waits for the person's answer.
    pub pairing: Duration,
    /// How long the model may say nothing; the provider's own bound when
    /// none.
    pub model_silence: Option<Duration>,
    /// How long a settings document's lock is waited for while its holder
    /// makes no progress, the wait starting again whenever it changes
    /// hands: as long as the store waits out a short guarded write, since
    /// characters start together and one's first start on a loaded disk
    /// holds the home's lock a while.
    pub settings_lock: Duration,
    /// How long an event stream stays silent before it pings, to say it is
    /// alive, so that a client's own timeout never takes a quiet stream for
    /// a dead one.
    pub ping: Duration,
    /// How long a client may leave what it was sent untaken, a frame of
    /// its stream or at a stop an answer, before it is taken for gone: a
    /// client that reads takes it in milliseconds, whatever burst it
    /// comes in, so this only ever meets one that stopped.
    pub grace: Duration,
    /// The minute a character's heartbeat counts in: her settings space
    /// her moments of her own so many of them apart.
    pub minute: Duration,
}

impl Default for Durations {
    fn default() -> Self {
        Self {
            confirmation: Duration::from_mins(5),
            pairing: Duration::from_hours(1),
            model_silence: None,
            settings_lock: Duration::from_secs(10),
            ping: Duration::from_secs(15),
            grace: Duration::from_secs(2),
            minute: Duration::from_mins(1),
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
    /// Where the App Store's catalog is: the build's own, unless the test
    /// switch names another.
    pub app_catalog: BaseUrl,
}

/// A line a client delivers into a conversation.
#[derive(Clone, Debug)]
pub struct Message {
    pub conversation_id: String,
    pub text: String,
    /// The surface the line came from.
    pub source: ClientStamp,
    /// The id the client submitted the line under, which a repeat reuses.
    pub client_message_id: ClientStamp,
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
/// for every character's, the App Store's catalog her phone reads, and the
/// events.
#[derive(Debug)]
pub(crate) struct World {
    pub(crate) home: Home,
    pub(crate) sections: Sections,
    pub(crate) plugins: Vec<Plugin>,
    pub(crate) durations: Durations,
    pub(crate) test_provider: Option<Arc<dyn RoleModelAdapter>>,
    pub(crate) catalog: Arc<AppCatalog>,
    pub(crate) events: Arc<Events>,
}

impl World {
    pub(crate) fn plugin(&self, id: &Identifier) -> Option<&Plugin> {
        self.plugins
            .iter()
            .find(|plugin| plugin.manifest.id() == id)
    }
}

/// Every event, announced in one order, which every subscriber hears whole:
/// none is dropped for a subscriber that reads behind, since the stream a
/// client follows numbers every event and a gap in it would be a lie.
#[derive(Debug, Default)]
pub(crate) struct Events {
    subscribers: Mutex<Vec<mpsc::UnboundedSender<Event>>>,
}

impl Events {
    pub(crate) fn emit(&self, event: Event) {
        let mut subscribers = self.subscribers();

        // A subscriber that let go hears nothing more.
        subscribers.retain(|subscriber| !subscriber.is_closed());

        if let Some((last, others)) = subscribers.split_last() {
            for subscriber in others {
                let _ = subscriber.send(event.clone());
            }

            let _ = last.send(event);
        }
    }

    fn subscribe(&self) -> mpsc::UnboundedReceiver<Event> {
        let (subscriber, events) = mpsc::unbounded_channel();

        self.subscribers().push(subscriber);
        events
    }

    fn subscribers(&self) -> MutexGuard<'_, Vec<mpsc::UnboundedSender<Event>>> {
        self.subscribers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
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
    /// delivery holds it from its routing until its line is in her inbox,
    /// and deliveries take it in the order they came.
    routes: tokio::sync::Mutex<HashMap<ConversationId, Identifier>>,
    reconciler: Arc<Reconciler>,
    presence: Mutex<BTreeMap<Identifier, Connected>>,
    pairings: Pairings,
}

/// A connector on the stream: how many streams of it are open, and the
/// bots it last said it runs, none once the last stream ended.
#[derive(Clone, Debug, Default)]
struct Connected {
    streams: usize,
    bots: Vec<ConnectorBot>,
}

/// The daemon, held by what it owns without keeping it alive: a
/// character's own settings, and a pairing request's deadline.
#[derive(Clone, Debug)]
pub(crate) struct WeakDaemon(Weak<Inner>);

impl WeakDaemon {
    pub(crate) fn upgrade(&self) -> Option<Daemon> {
        self.0.upgrade().map(|inner| Daemon { inner })
    }
}

/// The actors the daemon built, and whether it stopped, which ends every
/// start.
#[derive(Debug, Default)]
struct Characters {
    stopped: bool,
    handles: BTreeMap<Identifier, Arc<CharacterHandle>>,
}

/// A connector's stream counted as present while this is held: health
/// shows the connector connected, and the stream's end lets it go, the
/// last stream's end the connector's bots with it.
#[derive(Debug)]
#[must_use = "a connector counts as present only while its presence is held"]
pub struct Presence {
    daemon: Daemon,
    connector: Identifier,
    runtime: tokio::runtime::Handle,
}

impl Presence {
    /// Health as it now stands, read and sent to every surface on the
    /// blocking pool.
    fn announce(&self) {
        let daemon = self.daemon.clone();

        self.runtime
            .spawn_blocking(move || daemon.announce_health());
    }
}

impl Drop for Presence {
    fn drop(&mut self) {
        let last = {
            let mut presence = self.daemon.inner.presence();
            let connected = presence.entry(self.connector.clone()).or_default();

            connected.streams = connected.streams.saturating_sub(1);

            if connected.streams == 0 {
                connected.bots.clear();
            }

            connected.streams == 0
        };

        if last {
            self.announce();
        }
    }
}

impl Inner {
    fn characters(&self) -> MutexGuard<'_, Characters> {
        self.characters
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn presence(&self) -> MutexGuard<'_, BTreeMap<Identifier, Connected>> {
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
            app_catalog,
        } = settings;

        Ok(Self {
            inner: Arc::new(Inner {
                world: Arc::new(World {
                    home,
                    sections: Sections::new(
                        plugins
                            .iter()
                            .map(|plugin| (plugin.manifest.clone(), plugin.check)),
                    ),
                    plugins,
                    durations,
                    test_provider,
                    catalog: Arc::new(AppCatalog::new(app_catalog)),
                    events: Arc::default(),
                }),
                characters: Mutex::default(),
                routes: tokio::sync::Mutex::default(),
                reconciler: Arc::default(),
                presence: Mutex::default(),
                pairings: Pairings::default(),
            }),
        })
    }

    /// The waits this daemon keeps, which its socket keeps too.
    #[must_use]
    pub fn durations(&self) -> Durations {
        self.inner.world.durations
    }

    /// The daemon's whole state, read now: the roster as the disk says it
    /// is, each character's state as her actor published it, and the
    /// connectors on the stream, each with its bots.
    pub async fn health(&self) -> Health {
        let daemon = self.clone();

        blocking(move || daemon.health_now()).await
    }

    /// [`Daemon::health`], read on the calling thread, which waits on the
    /// disk.
    fn health_now(&self) -> Health {
        let roster = Roster::read(&self.inner.world);

        Health {
            protocol_version: ProtocolVersion,
            home_root: self.inner.world.home.root().display().to_string(),
            config: ConfigHealth {
                diagnostics: roster.home_diagnostics.clone(),
            },
            packages: PackagesHealth {
                diagnostics: roster
                    .discovery
                    .diagnostics
                    .iter()
                    .map(package_report)
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
                    .map(|connector| {
                        let Connected { streams, bots } =
                            presence.get(connector.id()).cloned().unwrap_or_default();

                        ConnectorPresence {
                            id: connector.id().clone(),
                            connected: streams > 0,
                            bots,
                        }
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
            return OpenOutcome::Refused {
                reason: OpenRefusal::CharacterUnavailable,
                message: self.unavailable(character),
            };
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

    /// Queues `message` in the inbox of the character its conversation
    /// belongs to, and answers once it is there: she takes it in its turn,
    /// and the stream tells how that ended. A line sent again is answered
    /// as her inbox has it, queued already or taken as the message it
    /// became, whether or not she takes lines now. Its routing and its
    /// place in her inbox are one step, which lines take in the order they
    /// came, so they reach her in that order; a new line for a character
    /// that is starting, or who waits for a model, waits for her, and one
    /// for a character who failed or does not run is refused, saying why.
    pub async fn deliver(&self, message: Message) -> SubmitOutcome {
        let mut routes = self.inner.routes.lock().await;
        let (conversation, character) =
            match self.route(&mut routes, &message.conversation_id).await {
                Ok(found) => found,
                Err(refused) => return refused,
            };
        let taker = self.live(&character).filter(|handle| handle.takes_lines());
        let line = QueuedLine {
            conversation_id: conversation,
            source: message.source,
            client_message_id: message.client_message_id,
            text: message.text,
        };
        let home = self.inner.world.home.clone();
        let id = line.client_message_id.clone();
        let her = character.clone();
        // The line and the word to her that it waits are one piece of work,
        // which a client that hangs up meanwhile does not cut in two.
        let queued = blocking(move || {
            let data = CharacterData::ensure(&home, &her)?;
            let Some(taker) = taker else {
                return data.sent_before(&line);
            };
            let queued = data.queue(&line)?;

            if queued == Queueing::Queued {
                taker.queued();
            }

            Ok(Some(queued))
        })
        .await;

        drop(routes);

        match queued {
            Ok(Some(Queueing::Queued)) => SubmitOutcome::Queued,
            Ok(Some(Queueing::AlreadyQueued)) => SubmitOutcome::AlreadyQueued,
            Ok(Some(Queueing::Taken(message_id))) => SubmitOutcome::Refused {
                reason: TurnRefusal::DuplicateSubmission,
                message: duplicate(&id, &message_id),
            },
            Ok(None) => SubmitOutcome::Refused {
                reason: TurnRefusal::CharacterUnavailable,
                message: self.unavailable(character.as_str()),
            },
            Err(error) => SubmitOutcome::Failed(storage_failure(&error)),
        }
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

    /// Every event from now on, in the order it is announced, each one
    /// kept until it is read: a subscriber that reads behind falls behind
    /// and misses nothing.
    #[must_use]
    pub fn events(&self) -> mpsc::UnboundedReceiver<Event> {
        self.inner.world.events.subscribe()
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
                .map_err(|error| error_sentence(&error))
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

    /// Makes the characters running at the call match the settings, and
    /// answers once they do: the pass runs on a task of its own whether or
    /// not the answer is awaited. A request while a pass runs joins it and
    /// marks one more pass after it, so the newest roster has the last
    /// word; passes never overlap.
    pub fn reconcile(&self) -> impl Future<Output = ()> + Send + 'static {
        if self.inner.characters().stopped {
            return std::future::ready(()).boxed();
        }

        let daemon = self.clone();

        self.inner
            .reconciler
            .reconcile(move || daemon.pass())
            .boxed()
    }

    /// The settings of `target` as its settings screen shows them, their AI
    /// model judged as a character's start judges hers.
    pub async fn config_view(&self, target: ConfigTarget) -> ConfigView {
        let world = Arc::clone(&self.inner.world);

        blocking(move || {
            config_view(
                &world.home,
                &world.sections,
                &discover(world.home.root()),
                &target,
                |host| model(&world, host).map(drop),
            )
        })
        .await
    }

    /// Makes `change` as [`Daemon::change_settings`] makes every change, on
    /// the blocking pool, so a caller that stops waiting leaves nothing of
    /// it undone.
    pub async fn apply_change(&self, change: ConfigChange) -> ChangeOutcome {
        let daemon = self.clone();

        blocking(move || daemon.change_settings(&change)).await
    }

    /// What connector `connector` runs on, for the home and for each
    /// character switched on, secrets in the clear.
    pub async fn connector_config(&self, connector: &str) -> ConnectorConfigView {
        let world = Arc::clone(&self.inner.world);
        let connector = connector.to_owned();

        blocking(move || {
            connector_config_view(
                &world.home,
                &world.sections,
                &discover(world.home.root()),
                &connector,
            )
        })
        .await
    }

    /// The one way the settings change, a client's change and a
    /// character's own plugin's alike: made as p02-config makes every
    /// change, under the documents' locks; once it lands, health as it now
    /// stands goes out to every surface before the answer does, and a
    /// reconcile pass acts on it behind the answer, on a task of its own,
    /// by its rule. It waits on the disk.
    pub(crate) fn change_settings(&self, change: &ConfigChange) -> ChangeOutcome {
        let world = &self.inner.world;
        let outcome = apply_change(
            &world.home,
            &world.sections,
            &discover(world.home.root()),
            change,
            world.durations.settings_lock,
        );

        if matches!(outcome, ChangeOutcome::Applied { .. }) {
            self.announce_health();
            tokio::spawn(self.reconcile());
        }

        outcome
    }

    /// Counts a stream of `connector` present from now until the presence
    /// is let go; health changes when the count crosses zero, and goes out
    /// to every surface on a task of its own.
    pub fn connector_present(&self, connector: &Connector) -> Presence {
        let presence = Presence {
            daemon: self.clone(),
            connector: connector.id().clone(),
            runtime: tokio::runtime::Handle::current(),
        };
        let first = {
            let mut counts = self.inner.presence();
            let connected = counts.entry(connector.id().clone()).or_default();

            connected.streams += 1;
            connected.streams == 1
        };

        if first {
            presence.announce();
        }

        presence
    }

    /// Keeps `bots` as the table of connector `connector`, in place of the
    /// one it held, while a stream of it is open: health shows it from then
    /// on, and goes out to every surface, before the answer does, when the
    /// table changed. A connector with no stream open is refused, so health
    /// never shows the bots of one that is off the stream.
    pub async fn connector_bots(
        &self,
        connector: &str,
        bots: Vec<ConnectorBot>,
    ) -> ConnectorBotsOutcome {
        let connector = match p02_config::connector(connector) {
            Ok(connector) => connector,
            Err(unknown) => {
                return ConnectorBotsOutcome::Refused {
                    reason: ConnectorBotsRefusal::UnknownConnector,
                    message: unknown.to_string(),
                };
            }
        };
        let changed = {
            let mut presence = self.inner.presence();
            let Some(connected) = presence
                .get_mut(connector.id())
                .filter(|connected| connected.streams > 0)
            else {
                return ConnectorBotsOutcome::Refused {
                    reason: ConnectorBotsRefusal::NotConnected,
                    message: format!(
                        "Connector \"{}\" has no event stream open, and its bots are kept only \
                         while one is.",
                        connector.id()
                    ),
                };
            };
            let changed = connected.bots != bots;

            connected.bots = bots;
            changed
        };

        if changed {
            let daemon = self.clone();

            blocking(move || daemon.announce_health()).await;
        }

        ConnectorBotsOutcome::Kept
    }

    /// Stops every character, for good: no start follows. A boot or a
    /// recovery in flight is overtaken, a turn in flight finishes and is
    /// announced, the lines queued behind it wait in her inbox, and the
    /// reconcile pass in flight is waited for; once it answers, everything
    /// the stop ended has been announced.
    pub async fn stop(&self) {
        self.inner.pairings.stop();

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

    pub(crate) fn downgrade(&self) -> WeakDaemon {
        WeakDaemon(Arc::downgrade(&self.inner))
    }

    pub(crate) fn world(&self) -> &Arc<World> {
        &self.inner.world
    }

    pub(crate) fn pairings(&self) -> &Pairings {
        &self.inner.pairings
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
    async fn begin(&self, id: &Identifier) -> bool {
        match self.actor(id).await {
            Some(Actor::Running(handle) | Actor::Built(handle)) => {
                handle.start().await;
                true
            }
            None => false,
        }
    }

    /// Her actor, built now unless one runs; one whose stop is under way is
    /// waited for first, so that one actor at a time holds what is hers.
    /// None once the daemon stopped.
    pub(crate) async fn actor(&self, id: &Identifier) -> Option<Actor> {
        loop {
            let stopping = {
                let mut characters = self.inner.characters();

                if characters.stopped {
                    return None;
                }

                match characters.handles.get(id) {
                    Some(handle) if !handle.ended() => {
                        return Some(Actor::Running(Arc::clone(handle)));
                    }
                    Some(handle) if !handle.gone() => Arc::clone(handle),
                    _ => {
                        let handle = Arc::new(CharacterHandle::spawn(self, id.clone()));

                        characters.handles.insert(id.clone(), Arc::clone(&handle));
                        return Some(Actor::Built(handle));
                    }
                }
            };

            stopping.stopped().await;
        }
    }

    /// Health as it now stands, sent to every surface; it waits on the
    /// disk.
    pub(crate) fn announce_health(&self) {
        let health = self.health_now();

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
            built_in: is_bundled(&definition.profile.id),
            state: health.as_ref().map(|health| health.state).into(),
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

    /// The sentence `character` answers with while she takes nothing.
    fn unavailable(&self, character: &str) -> String {
        Identifier::new(character)
            .ok()
            .and_then(|id| self.handle(&id))
            .map_or_else(
                || format!("Character \"{character}\" is not running."),
                |handle| handle.unavailable(),
            )
    }

    /// The character `conversation` belongs to: the route this run holds from
    /// an open or an earlier delivery, else the store's record of it,
    /// remembered once found.
    async fn route(
        &self,
        routes: &mut HashMap<ConversationId, Identifier>,
        conversation: &str,
    ) -> Result<(ConversationId, Identifier), SubmitOutcome> {
        let unknown = || SubmitOutcome::Refused {
            reason: TurnRefusal::UnknownConversation,
            message: format!("Conversation \"{conversation}\" does not exist."),
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
            Ok(record) => character_of(&record).ok_or_else(unknown)?,
            Err(StorageError::ConversationNotFound(_)) => return Err(unknown()),
            Err(error) => {
                return Err(SubmitOutcome::Refused {
                    reason: TurnRefusal::UnknownConversation,
                    message: format!(
                        "Conversation \"{id}\" cannot be read: {}",
                        error_sentence(&error)
                    ),
                });
            }
        };

        routes.insert(id.clone(), character.clone());
        Ok((id, character))
    }
}

/// A character's actor as the daemon found it: one that ran already, or one
/// built now, whose boot is under way.
pub(crate) enum Actor {
    Running(Arc<CharacterHandle>),
    Built(Arc<CharacterHandle>),
}

/// The character among a conversation's participants.
pub(crate) fn character_of(conversation: &Conversation) -> Option<Identifier> {
    conversation
        .participants()
        .iter()
        .find(|participant| participant.kind == VisibleMessageRole::Character)
        .map(|participant| participant.id.clone())
}

/// Runs `work` on the blocking pool, where the store may wait on a lock; a
/// panic there is the caller's, as it would be inline.
pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    match tokio::task::spawn_blocking(work).await {
        Ok(done) => done,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}
