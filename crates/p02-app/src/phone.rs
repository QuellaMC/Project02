//! Her phone as a client reads it, from her data whether she runs or not:
//! her apps, those it comes with and those installed on it, what she has
//! in front with its screen, what she last did on it and what rings; and
//! one view's screen, which a person looking around her phone reads, and
//! which changes nothing of hers.

use std::sync::Arc;
use std::time::{Duration, Instant};

use p02_characters::discover;
use p02_contracts::{CharacterStorage, FileStoreBackend, LeasedFiles, StoreError};
use p02_phone::{Listed, Now, Phone, PhoneError};
use p02_plugins::PHONE_PLUGIN;
use p02_shared::{Identifier, error_chain, error_sentence, sentence};
use p02_store::CharacterData;
use p02_wire::{
    AppView, PhoneApp, PhoneDid, PhoneFront, PhoneOutcome, PhoneRefusal, PhoneRing, Screen,
    ScreenOutcome, ScreenRefusal,
};

use crate::daemon::{Daemon, World, blocking};
use crate::reconcile::settings_now;

/// How long her phone's store is waited for, which a call of her phone's
/// tools holds a moment at most.
const LEASE: Duration = Duration::from_secs(10);

/// Why her phone was not read, in a sentence: the daemon knows no such
/// character, her settings give her none, or it could not be read.
enum Unread {
    UnknownCharacter(String),
    NoPhone(String),
    Failed(String),
}

impl Daemon {
    /// Her phone as it stands: her apps, what she has in front with its
    /// screen and what she last did on it, read from her data on the
    /// blocking pool under a lease of its store, and what rings on it as
    /// her actor last published.
    pub async fn phone(&self, character: &str) -> PhoneOutcome {
        let world = Arc::clone(self.world());
        let ringing = self.ringing(character);
        let character = character.to_owned();

        blocking(move || {
            match with_phone(&world, &character, |phone, files| {
                shown(phone, files, &Now::system(), ringing)
            }) {
                Ok(shown) => shown,
                Err(Unread::UnknownCharacter(message)) => PhoneOutcome::Refused {
                    reason: PhoneRefusal::UnknownCharacter,
                    message,
                },
                Err(Unread::NoPhone(message)) => PhoneOutcome::Refused {
                    reason: PhoneRefusal::NoPhone,
                    message,
                },
                Err(Unread::Failed(message)) => PhoneOutcome::Failed { message },
            }
        })
        .await
    }

    /// The screen of `app`'s `view` on her phone, as someone looking around
    /// it sees it: read as her phone is, and changing nothing of hers.
    pub async fn phone_screen(&self, character: &str, app: &str, view: &str) -> ScreenOutcome {
        let world = Arc::clone(self.world());
        let (character, app, view) = (character.to_owned(), app.to_owned(), view.to_owned());

        blocking(move || {
            match with_phone(&world, &character, |phone, files| {
                looked(phone.look(files, &app, &view, &Now::system()))
            }) {
                Ok(looked) => looked,
                Err(Unread::UnknownCharacter(message)) => ScreenOutcome::Refused {
                    reason: ScreenRefusal::UnknownCharacter,
                    message,
                },
                Err(Unread::NoPhone(message)) => ScreenOutcome::Refused {
                    reason: ScreenRefusal::NoPhone,
                    message,
                },
                Err(Unread::Failed(message)) => ScreenOutcome::Failed { message },
            }
        })
        .await
    }

    /// What rings on the phone of `character` as her actor last published
    /// it: nothing while she has none.
    fn ringing(&self, character: &str) -> Vec<PhoneRing> {
        Identifier::new(character)
            .ok()
            .and_then(|id| self.handle(&id))
            .map(|handle| handle.health().ringing)
            .unwrap_or_default()
    }
}

/// Her phone's store under its lease, waited for as long as a call of her
/// phone's tools holds it at most.
pub(crate) fn lease(store: &dyn FileStoreBackend) -> Result<Box<dyn LeasedFiles + '_>, StoreError> {
    store.lease(Instant::now() + LEASE)
}

/// What `read` makes of the phone of `character` under a lease of its
/// store in her data, which is made if she has none yet. The daemon must
/// know her, and her settings switch her phone on; settings that cannot be
/// read do not take it from her, since her start says what is wrong with
/// them.
fn with_phone<T>(
    world: &World,
    character: &str,
    read: impl FnOnce(&Phone, &dyn LeasedFiles) -> Result<T, Unread>,
) -> Result<T, Unread> {
    let discovery = discover(world.home.root());
    let definition = discovery
        .find(character)
        .map_err(|error| Unread::UnknownCharacter(error_sentence(&error)))?;
    let settings = settings_now(world, definition);
    let plugin = world
        .plugins
        .iter()
        .map(|plugin| plugin.manifest().id())
        .find(|id| id.as_str() == PHONE_PLUGIN)
        .filter(|phone| {
            settings.is_none_or(|settings| settings.plugins().any(|(id, _)| id == *phone))
        })
        .ok_or_else(|| {
            Unread::NoPhone(format!(
                "{} has no phone: her settings switch it off.",
                definition.profile.display_name
            ))
        })?;
    let phone = Phone::bundled().map_err(|error| Unread::Failed(unread(error)))?;
    let data = CharacterData::ensure(&world.home, &definition.profile.id)
        .map_err(|error| Unread::Failed(unread(&error)))?;
    let store = data.file_store(plugin);
    let files = lease(store.as_ref()).map_err(|error| Unread::Failed(unread(&error)))?;

    read(phone, files.as_ref())
}

/// Her phone as `files` keep it at `now`, with `ringing` what rings on it.
fn shown(
    phone: &Phone,
    files: &dyn LeasedFiles,
    now: &Now,
    ringing: Vec<PhoneRing>,
) -> Result<PhoneOutcome, Unread> {
    let on_phone = phone
        .apps(files)
        .map_err(|error| Unread::Failed(unread(&error)))?;
    let state = phone
        .state(files)
        .map_err(|error| Unread::Failed(unread(&error)))?;
    let front = match state.front {
        None => None,
        Some(front) => {
            let (screen, message) =
                match phone.look(files, front.app.as_str(), front.view.as_str(), now) {
                    Ok(screen) => (Some(screen), None),
                    Err(PhoneError::Store(error)) => return Err(Unread::Failed(unread(&error))),
                    Err(failure) => (None, Some(sentence(&failure.to_string()))),
                };

            Some(PhoneFront {
                app_id: front.app,
                view_id: front.view,
                screen,
                message,
            })
        }
    };

    Ok(PhoneOutcome::Ok {
        apps: on_phone.apps.iter().map(drawn).collect(),
        front,
        did: state.did.map(|did| PhoneDid {
            app_id: did.app,
            words: did.words,
            at: did.at,
        }),
        ringing,
    })
}

/// What came of a look at a view: its screen, or the phone's refusal of
/// it in its own sentence.
fn looked(looked: Result<Screen, PhoneError>) -> Result<ScreenOutcome, Unread> {
    let refusal = match looked {
        Ok(screen) => return Ok(ScreenOutcome::Ok { screen }),
        Err(PhoneError::Store(error)) => return Err(Unread::Failed(unread(&error))),
        Err(refusal) => refusal,
    };
    let reason = match refusal {
        PhoneError::NoApp(_) => ScreenRefusal::UnknownApp,
        PhoneError::NoView { .. } => ScreenRefusal::UnknownView,
        _ => ScreenRefusal::AppFailed,
    };

    Ok(ScreenOutcome::Refused {
        reason,
        message: sentence(&refusal.to_string()),
    })
}

/// `app` as her window draws it.
fn drawn(app: &Listed) -> PhoneApp {
    PhoneApp {
        id: app.id.clone(),
        name: app.name.clone(),
        icon: app.icon.clone(),
        tint: app.tint.clone(),
        views: app
            .views
            .iter()
            .map(|view| AppView {
                id: view.id().clone(),
                title: view.title().to_owned(),
                icon: view.icon().to_owned(),
            })
            .collect(),
        opens_on: app.opens_on.clone(),
    }
}

/// Why her phone could not be read, in a sentence: `error` and its causes.
fn unread(error: &dyn std::error::Error) -> String {
    sentence(&format!(
        "her phone could not be read: {}",
        error_chain(error)
    ))
}
