//! Her phone as a client reads it, from her data whether she runs or not:
//! her apps, those it comes with and those installed on it, what she has
//! in front with its screen, what she last did on it and what rings; and
//! one view's screen, which a person looking around her phone reads, and
//! which changes nothing of hers.

use std::sync::Arc;
use std::time::{Duration, Instant};

use p02_characters::discover;
use p02_config::Resolution;
use p02_contracts::{CharacterStorage, FileStoreBackend, LeasedFiles, StoreError};
use p02_phone::{Account, Listed, Now, OnPhone, Phone, PhoneError, Source, it_may};
use p02_plugins::{PHONE_PLUGIN, keyed_accounts};
use p02_shared::{Identifier, error_chain, error_sentence, sentence};
use p02_store::CharacterData;
use p02_wire::{
    AppAccount, AppSource, AppView, Namespace, PersonAccount, PhoneApp, PhoneDid, PhoneFront,
    PhoneOutcome, PhoneRefusal, PhoneRing, Screen, ScreenOutcome, ScreenRefusal,
};

use crate::daemon::{Daemon, World, blocking};
use crate::reconcile::settings_now;

/// How long her phone's store is waited for, which a call of her phone's
/// tools holds a moment at most.
const LEASE: Duration = Duration::from_secs(10);

/// Why her phone was not reached, in a sentence: the daemon knows no such
/// character, her settings give her none, or it could not be read.
pub(crate) enum Unread {
    UnknownCharacter(String),
    NoPhone(String),
    Failed(String),
}

/// Her phone as the daemon reaches it, whether she runs or not: whose it
/// is, the phone every character has, and its store in her data.
#[derive(Clone, Debug)]
pub(crate) struct HerPhone {
    /// Her id, as the daemon knows her.
    pub(crate) id: Identifier,
    pub(crate) phone: &'static Phone,
    store: Arc<dyn FileStoreBackend>,
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
            HerPhone::of(&world, &character).and_then(|her| {
                let keyed = keyed(&world);

                her.with(|phone, files| shown(phone, files, &Now::system(), ringing, &keyed))
            })
        })
        .await
        .unwrap_or_else(PhoneOutcome::from)
    }

    /// The screen of `app`'s `view` on her phone, as someone looking around
    /// it sees it: read as her phone is, and changing nothing of hers.
    pub async fn phone_screen(&self, character: &str, app: &str, view: &str) -> ScreenOutcome {
        let world = Arc::clone(self.world());
        let (character, app, view) = (character.to_owned(), app.to_owned(), view.to_owned());

        blocking(move || {
            HerPhone::of(&world, &character).and_then(|her| {
                her.with(|phone, files| looked(phone.look(files, &app, &view, &Now::system())))
            })
        })
        .await
        .unwrap_or_else(ScreenOutcome::from)
    }

    /// The phone of `character`, read on the blocking pool as
    /// [`HerPhone::of`] reads it.
    pub(crate) async fn her_phone(&self, character: &str) -> Result<HerPhone, Unread> {
        let world = Arc::clone(self.world());
        let character = character.to_owned();

        blocking(move || HerPhone::of(&world, &character)).await
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

impl HerPhone {
    /// The phone of `character` in `world`, her data made if she has none
    /// yet. The daemon must know her, and her settings switch her phone on;
    /// settings that cannot be read do not take it from her, since her start
    /// says what is wrong with them.
    pub(crate) fn of(world: &World, character: &str) -> Result<Self, Unread> {
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

        Ok(Self {
            id: definition.profile.id.clone(),
            phone,
            store: data.file_store(plugin),
        })
    }

    /// What `work` makes of her phone under a lease of its store, on the
    /// calling thread, which waits on the disk.
    pub(crate) fn with<T>(
        &self,
        work: impl FnOnce(&Phone, &mut dyn LeasedFiles) -> Result<T, Unread>,
    ) -> Result<T, Unread> {
        let mut files =
            lease(self.store.as_ref()).map_err(|error| Unread::Failed(unread(&error)))?;

        work(self.phone, files.as_mut())
    }

    /// What is on her phone, read under a lease of its store, on the
    /// calling thread.
    pub(crate) fn apps(&self) -> Result<OnPhone, StoreError> {
        self.phone.apps(lease(self.store.as_ref())?.as_ref())
    }
}

/// Her phone's store under its lease, waited for as long as a call of her
/// phone's tools holds it at most.
pub(crate) fn lease(store: &dyn FileStoreBackend) -> Result<Box<dyn LeasedFiles + '_>, StoreError> {
    store.lease(Instant::now() + LEASE)
}

/// Her phone as `files` keep it at `now`, with `ringing` what rings on it
/// and `keyed` the accounts whose key the person gave her phone.
fn shown(
    phone: &Phone,
    files: &dyn LeasedFiles,
    now: &Now,
    ringing: Vec<PhoneRing>,
    keyed: &[&Account],
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

            Some(Box::new(PhoneFront {
                app_id: front.app,
                view_id: front.view,
                screen,
                message,
            }))
        }
    };

    Ok(PhoneOutcome::Ok {
        apps: on_phone
            .apps
            .iter()
            .map(|app| drawn(app, &on_phone, keyed))
            .collect(),
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

/// `app`, on her phone as `on_phone` has it, as her window draws it and
/// her settings show it, `keyed` the accounts whose key the person gave her
/// phone.
pub(crate) fn drawn(app: &Listed, on_phone: &OnPhone, keyed: &[&Account]) -> PhoneApp {
    PhoneApp {
        id: app.id.clone(),
        name: app.name.clone(),
        summary: app.summary.clone(),
        version: app.version.clone(),
        source: match app.source {
            None => AppSource::BuiltIn,
            Some(Source::Catalog) => AppSource::Catalog,
            Some(Source::File) => AppSource::File,
        },
        icon: app.icon.clone(),
        tint: app.tint.clone(),
        wakes: app.asks.wakes(),
        may_wake: on_phone.may_wake(app),
        it_may: it_may(&app.asks),
        account: app.asks.account().map(|account| AppAccount {
            id: account_id(account),
            name: account.name().to_owned(),
            has_key: keyed.contains(&account),
        }),
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

/// The accounts her phone knows, as health says them: each with whether
/// the person gave her phone its key, and where a key comes from.
pub(crate) fn accounts(world: &World) -> Vec<PersonAccount> {
    let keyed = keyed(world);

    Account::all()
        .iter()
        .map(|account| PersonAccount {
            id: account_id(account),
            name: account.name().to_owned(),
            has_key: keyed.contains(&account),
            key_from: account.key_from().to_owned(),
        })
        .collect()
}

/// The accounts whose key the person gave her phone, as the home's
/// settings, which alone hold a key, give it to every character's phone:
/// none while they cannot be read. It waits on the disk.
pub(crate) fn keyed(world: &World) -> Vec<&'static Account> {
    Resolution::home(&world.home, &world.sections)
        .map(|home| {
            keyed_accounts(|field| home.section_value(Namespace::Plugins, PHONE_PLUGIN, field))
        })
        .unwrap_or_default()
}

/// The id of `account`, one of the phone's own, as a client is told it.
fn account_id(account: &Account) -> Identifier {
    Identifier::new(account.id()).expect("the phone's accounts have ids")
}

/// Why her phone could not be read, in a sentence: `error` and its causes.
pub(crate) fn unread(error: &dyn std::error::Error) -> String {
    sentence(&format!(
        "her phone could not be read: {}",
        error_chain(error)
    ))
}

impl From<Unread> for PhoneOutcome {
    fn from(unread: Unread) -> Self {
        match unread {
            Unread::UnknownCharacter(message) => Self::Refused {
                reason: PhoneRefusal::UnknownCharacter,
                message,
            },
            Unread::NoPhone(message) => Self::Refused {
                reason: PhoneRefusal::NoPhone,
                message,
            },
            Unread::Failed(message) => Self::Failed { message },
        }
    }
}

impl From<Unread> for ScreenOutcome {
    fn from(unread: Unread) -> Self {
        match unread {
            Unread::UnknownCharacter(message) => Self::Refused {
                reason: ScreenRefusal::UnknownCharacter,
                message,
            },
            Unread::NoPhone(message) => Self::Refused {
                reason: ScreenRefusal::NoPhone,
                message,
            },
            Unread::Failed(message) => Self::Failed { message },
        }
    }
}
