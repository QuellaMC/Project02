//! The reconciler: one rule for boot and for every settings change, which
//! makes the characters running match the roster as the disk says it is.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared, join_all};
use p02_characters::{CharacterDefinition, Discovery, discover};
use p02_config::{CharacterSettings, Diagnostic, ReadSettingsError, Resolution};
use p02_shared::Identifier;

use crate::character::{Built, Reconciled};
use crate::daemon::{Daemon, World};
use crate::outcome::ReconcilePlan;

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
            Err(ReadSettingsError::Unloadable { diagnostics }) => diagnostics,
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
    running: Option<Shared<BoxFuture<'static, ReconcilePlan>>>,
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
    /// while it runs, and answers with what every run set in motion; a
    /// request while it runs joins it.
    pub(crate) fn reconcile(
        self: &Arc<Self>,
        pass: impl Fn() -> BoxFuture<'static, ReconcilePlan> + Send + Sync + 'static,
    ) -> Shared<BoxFuture<'static, ReconcilePlan>> {
        let mut passes = self.passes();

        if let Some(running) = passes.running.clone() {
            passes.again = true;
            return running;
        }

        let reconciler = Arc::clone(self);
        let task = tokio::spawn(async move {
            let mut plan = ReconcilePlan::default();

            loop {
                plan.merge(pass().await);

                let mut passes = reconciler.passes();

                if !passes.again {
                    passes.running = None;
                    return plan;
                }

                passes.again = false;
            }
        });
        let reconciler = Arc::clone(self);
        let running = async move {
            task.await.unwrap_or_else(|_| {
                // A pass that broke ends the run, so the next request starts
                // one afresh.
                *reconciler.passes() = Passes::default();
                ReconcilePlan::default()
            })
        }
        .boxed()
        .shared();

        passes.running = Some(running.clone());
        running
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

/// What one character's part of a pass did.
enum Did {
    Started(Identifier),
    Stopped(Identifier),
    Reloaded(Identifier),
    Nothing,
}

impl Daemon {
    /// One pass of the rule: an enabled character who runs nothing starts,
    /// one who failed starts again, one who is ready and would be built from
    /// other settings now reloads, and a disabled one who still runs stops,
    /// as does one whose package left the roster.
    pub(crate) async fn pass(&self) -> ReconcilePlan {
        let roster = self.roster().await;
        let mut work: Vec<BoxFuture<'_, Did>> = Vec::new();

        for (definition, settings) in roster.characters() {
            let id = definition.profile.id.clone();
            let running = self.handle(&id).filter(|handle| !handle.ended());

            if settings.is_none_or(|settings| settings.host().enabled) {
                let now = settings.map(|settings| Built {
                    settings: settings.clone(),
                    character: definition.character_ref(),
                });

                work.push(Box::pin(async move {
                    let Some(handle) = running else {
                        return if self.begin(&id).await {
                            Did::Started(id)
                        } else {
                            Did::Nothing
                        };
                    };

                    match handle.reconcile(now).await {
                        Reconciled::Started => Did::Started(id),
                        Reconciled::Reloaded => Did::Reloaded(id),
                        Reconciled::Unchanged => Did::Nothing,
                    }
                }));
            } else if let Some(handle) = running {
                work.push(Box::pin(async move {
                    handle.stop().await;
                    Did::Stopped(id)
                }));
            }
        }

        for handle in self.handles() {
            let left = !roster
                .characters()
                .any(|(definition, _)| definition.profile.id == *handle.id());

            if left && !handle.ended() {
                work.push(Box::pin(async move {
                    handle.stop().await;
                    Did::Stopped(handle.id().clone())
                }));
            }
        }

        let mut plan = ReconcilePlan::default();

        for did in join_all(work).await {
            match did {
                Did::Started(id) => plan.starting.push(id),
                Did::Stopped(id) => plan.stopping.push(id),
                Did::Reloaded(id) => plan.reloading.push(id),
                Did::Nothing => {}
            }
        }

        plan
    }
}
