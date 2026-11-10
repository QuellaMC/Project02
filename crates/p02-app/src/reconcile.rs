//! The reconciler: one rule for boot and for every settings change, which
//! makes the characters running match the roster as the disk says it is.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared, join_all};
use p02_characters::{CharacterDefinition, Discovery, discover};
use p02_config::{CharacterSettings, ReadSettingsError, Resolution};
use p02_wire::Diagnostic;

use crate::character::CharacterHandle;
use crate::daemon::{Actor, Daemon, World};

/// The installed roster as the disk says it is now: what discovery found,
/// what the home's settings say of themselves, and each character's
/// settings as resolved now.
#[derive(Debug)]
pub(crate) struct Roster {
    pub(crate) discovery: Discovery,
    pub(crate) home_diagnostics: Vec<Diagnostic>,
    /// In the order of `discovery.characters`; none for a character whose
    /// settings cannot be resolved.
    settings: Vec<Option<CharacterSettings>>,
}

impl Roster {
    pub(crate) fn read(world: &World) -> Self {
        let discovery = discover(world.home.root());
        let home_diagnostics = match Resolution::home(&world.home, &world.sections) {
            Ok(resolution) => resolution.diagnostics().to_vec(),
            Err(ReadSettingsError::Unreadable(diagnostic)) => vec![*diagnostic],
            Err(ReadSettingsError::Storage(_) | ReadSettingsError::UnknownCharacter(_)) => {
                Vec::new()
            }
        };
        let settings = discovery
            .characters
            .iter()
            .map(|definition| settings_now(world, definition))
            .collect();

        Self {
            discovery,
            home_diagnostics,
            settings,
        }
    }

    /// Each installed character, in id order, with her settings now.
    pub(crate) fn characters(
        &self,
    ) -> impl Iterator<Item = (&CharacterDefinition, Option<&CharacterSettings>)> {
        self.discovery
            .characters
            .iter()
            .zip(self.settings.iter().map(Option::as_ref))
    }
}

/// `definition`'s settings as resolved now; none when they cannot be, as a
/// damaged data directory leaves them, so that her damage never hides the
/// roster and her start reports it.
pub(crate) fn settings_now(
    world: &World,
    definition: &CharacterDefinition,
) -> Option<CharacterSettings> {
    Resolution::character(&world.home, &world.sections, definition)
        .ok()
        .map(|resolution| resolution.settings())
}

/// The passes, which never overlap.
#[derive(Debug, Default)]
pub(crate) struct Reconciler {
    passes: Mutex<Passes>,
}

#[derive(Default)]
struct Passes {
    running: Option<Shared<BoxFuture<'static, ()>>>,
    /// A request came while a pass ran: one more pass follows it.
    again: bool,
}

impl std::fmt::Debug for Passes {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Passes")
            .field("running", &self.running.is_some())
            .field("again", &self.again)
            .finish()
    }
}

impl Reconciler {
    /// Runs `pass` as a task of its own, again for as long as requests come
    /// while it runs, and answers once the last run ended; a request while
    /// it runs joins it. The first pass is made at the request, so it
    /// judges what runs at that moment, and each after it as it begins.
    pub(crate) fn reconcile(
        self: &Arc<Self>,
        pass: impl Fn() -> BoxFuture<'static, ()> + Send + Sync + 'static,
    ) -> Shared<BoxFuture<'static, ()>> {
        let first = pass();
        let mut passes = self.passes();

        if let Some(running) = passes.running.clone() {
            passes.again = true;
            return running;
        }

        let reconciler = Arc::clone(self);
        let task = tokio::spawn(async move {
            first.await;

            while reconciler.more() {
                pass().await;
            }
        });
        let reconciler = Arc::clone(self);
        let running = async move {
            if task.await.is_err() {
                // A pass that broke ends the run, so the next request starts
                // one afresh.
                *reconciler.passes() = Passes::default();
            }
        }
        .boxed()
        .shared();

        passes.running = Some(running.clone());
        running
    }

    /// Whether a request came while the last pass ran, which one more pass
    /// answers; when none came the run ends, under the lock a request
    /// takes, so none falls between.
    fn more(&self) -> bool {
        let mut passes = self.passes();
        let again = std::mem::take(&mut passes.again);

        if !again {
            passes.running = None;
        }

        again
    }

    /// Answered once no pass runs.
    pub(crate) async fn settled(&self) {
        let running = self.passes().running.clone();

        if let Some(running) = running {
            running.await;
        }
    }

    fn passes(&self) -> MutexGuard<'_, Passes> {
        self.passes.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Daemon {
    /// One pass of the rule over the characters running now, against the
    /// roster as the pass reads it: an enabled character who runs nothing
    /// starts, one who failed starts again, one who runs is brought up to
    /// date with her settings, built again when they changed, unless a turn
    /// of hers runs, which meets them before its next request, and a
    /// disabled one who runs stops, as does one whose package left the
    /// roster. One started after now, by a client, is the next pass's to
    /// judge.
    pub(crate) fn pass(&self) -> BoxFuture<'static, ()> {
        let running: Vec<Arc<CharacterHandle>> = self
            .handles()
            .into_iter()
            .filter(|handle| !handle.ended())
            .collect();
        let daemon = self.clone();

        Box::pin(async move { daemon.judge(running).await })
    }

    async fn judge(&self, running: Vec<Arc<CharacterHandle>>) {
        let roster = self.roster().await;
        let mut work: Vec<BoxFuture<'_, ()>> = Vec::new();

        for (definition, settings) in roster.characters() {
            let id = definition.profile.id.clone();
            let running = running
                .iter()
                .find(|handle| *handle.id() == id && !handle.ended())
                .cloned();

            if settings.is_none_or(|settings| settings.host().enabled) {
                work.push(Box::pin(async move {
                    match running {
                        Some(handle) => handle.start().await,
                        // One a client started since the pass was asked
                        // for is the client's.
                        None => {
                            if let Some(Actor::Built(handle)) = self.actor(&id).await {
                                handle.start().await;
                            }
                        }
                    }
                }));
            } else if let Some(handle) = running {
                work.push(Box::pin(async move { handle.stop().await }));
            }
        }

        for handle in running {
            let left = !roster
                .characters()
                .any(|(definition, _)| definition.profile.id == *handle.id());

            if left && !handle.ended() {
                work.push(Box::pin(async move { handle.stop().await }));
            }
        }

        join_all(work).await;
    }
}
