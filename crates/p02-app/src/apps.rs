//! Her apps in the person's hands, whether she runs or not: the App Store's
//! catalog as they browse it for her, an app given to her from it or from
//! a file, an app removed, and their say on whether one may wake her. Each
//! is their own act, which asks nobody, made on her phone under a lease of
//! its store, and no request is made under a lease. Each that changed her
//! phone says so on the stream, and has her actor, while she runs, read its
//! rings again, as after a turn of hers.

use p02_phone::{CatalogApp, CatalogError, Installed, OnPhone, PhoneError, Source, it_may};
use p02_plugins::{Installable, NotInstallable, installable};
use p02_shared::{Identifier, sentence};
use p02_wire::{
    AppInstallOutcome, AppInstallRefusal, AppPreviewOutcome, AppRemoveOutcome, AppRemoveRefusal,
    AppWakeOutcome, AppWakeRefusal, Event, PhoneRefusal, StoreApp, StoreOutcome,
};

use crate::daemon::{Daemon, blocking};
use crate::phone::{HerPhone, Unread, drawn, unread};

/// What is said of a file the person picked that is not text.
const NOT_TEXT: &str = "This file is not text, so it holds no app.";

impl Daemon {
    /// The App Store's catalog for the person to browse for `character`,
    /// read anew: each app as its page in the store says it, with how it
    /// stands on her phone.
    pub async fn phone_store(&self, character: &str) -> StoreOutcome {
        let her = match self.her_phone(character).await {
            Ok(her) => her,
            Err(unread) => return unread.into(),
        };
        let catalog = match self.world().catalog.catalog().await {
            Ok(catalog) => catalog,
            Err(unread) => {
                return StoreOutcome::Failed {
                    message: sentence(&unread.to_string()),
                };
            }
        };

        blocking(move || -> Result<StoreOutcome, Unread> {
            let on_phone = her.apps().map_err(|error| Unread::Failed(unread(&error)))?;

            Ok(StoreOutcome::Ok {
                apps: catalog
                    .apps()
                    .iter()
                    .map(|app| store_app(app, &on_phone))
                    .collect(),
            })
        })
        .await
        .unwrap_or_else(StoreOutcome::from)
    }

    /// Gives `character` the App Store's app `app`, as her own ask for it
    /// is prepared: the catalog read anew, and the app's file fetched and
    /// judged against what it lists. An older version on her phone is
    /// replaced, keeping what it keeps: that is an update.
    pub async fn install_app(&self, character: &str, app: &str) -> AppInstallOutcome {
        let her = match self.her_phone(character).await {
            Ok(her) => her,
            Err(unread) => return unread.into(),
        };
        let reader = her.clone();
        let Installable { text, .. } =
            match installable(her.phone, &self.world().catalog, app, move || reader.apps()).await {
                Ok(Ok(installable)) => installable,
                Ok(Err(refusal)) => return not_installable(app, &refusal),
                Err(failure) => {
                    return AppInstallOutcome::Failed {
                        message: unread(&failure),
                    };
                }
            };

        self.give(her, text, Source::Catalog).await
    }

    /// What the app `file` holds would put on the phone of `character`,
    /// judged as adding it judges it, with nothing written: what the app is
    /// and may do, and the version of it on her phone that adding it
    /// replaces.
    pub async fn preview_app(&self, character: &str, file: Vec<u8>) -> AppPreviewOutcome {
        let her = match self.her_phone(character).await {
            Ok(her) => her,
            Err(unread) => return unread.into(),
        };

        blocking(move || -> Result<AppPreviewOutcome, Unread> {
            let refused = |message| AppPreviewOutcome::Refused {
                reason: AppInstallRefusal::NotAnApp,
                message,
            };
            let Ok(text) = String::from_utf8(file) else {
                return Ok(refused(NOT_TEXT.to_owned()));
            };
            let app = match her.phone.preview(&text) {
                Ok(app) => app,
                Err(refusal) => {
                    return Ok(AppPreviewOutcome::Refused {
                        reason: refusal_of(&refusal),
                        message: sentence(&refusal.to_string()),
                    });
                }
            };
            let on_phone = her.apps().map_err(|error| Unread::Failed(unread(&error)))?;

            Ok(AppPreviewOutcome::Ok {
                id: app.id().clone(),
                name: app.name().to_owned(),
                summary: app.summary().to_owned(),
                icon: app.icon().to_owned(),
                tint: app.tint().to_owned(),
                version: app.version().to_owned(),
                wakes: app.wakes(),
                it_may: said(app.wakes()),
                replaces: on_phone
                    .app(app.id().as_str())
                    .map(|on_phone| on_phone.version.clone()),
            })
        })
        .await
        .unwrap_or_else(AppPreviewOutcome::from)
    }

    /// Gives `character` the app `file` holds, which nobody read, at the
    /// person's own risk: judged as a preview judges it, and replacing an
    /// app of its id on her phone, whatever its version or source, keeping
    /// what it keeps.
    pub async fn add_app(&self, character: &str, file: Vec<u8>) -> AppInstallOutcome {
        let her = match self.her_phone(character).await {
            Ok(her) => her,
            Err(unread) => return unread.into(),
        };
        let Ok(text) = String::from_utf8(file) else {
            return AppInstallOutcome::Refused {
                reason: AppInstallRefusal::NotAnApp,
                message: NOT_TEXT.to_owned(),
            };
        };

        self.give(her, text, Source::File).await
    }

    /// Removes `app` from the phone of `character`: what it keeps, with its
    /// rings, and what the person said of it go with it, and when she had it
    /// in front, her home screen is.
    pub async fn remove_app(&self, character: &str, app: &str) -> AppRemoveOutcome {
        let app = app.to_owned();

        self.change(character, move |her| {
            her.with(|phone, files| match phone.remove(files, &app) {
                Ok(()) => Ok(AppRemoveOutcome::Ok),
                Err(PhoneError::Store(error)) => Err(Unread::Failed(unread(&error))),
                Err(refusal) => Ok(AppRemoveOutcome::Refused {
                    reason: match refusal {
                        PhoneError::ComesWithPhone(_) => AppRemoveRefusal::ComesWithPhone,
                        _ => AppRemoveRefusal::UnknownApp,
                    },
                    message: sentence(&refusal.to_string()),
                }),
            })
        })
        .await
    }

    /// Lets `app` on the phone of `character` wake her, or not, as the
    /// person says: kept with her phone until the app is removed. While it
    /// may not, its rings stay set and nothing tells them to her; once it
    /// may again, one whose time passed rings, late.
    pub async fn let_app_wake(&self, character: &str, app: &str, allowed: bool) -> AppWakeOutcome {
        let app = app.to_owned();

        self.change(character, move |her| {
            her.with(|phone, files| match phone.let_wake(files, &app, allowed) {
                Ok(()) => Ok(AppWakeOutcome::Ok),
                Err(PhoneError::Store(error)) => Err(Unread::Failed(unread(&error))),
                Err(refusal) => Ok(AppWakeOutcome::Refused {
                    reason: match refusal {
                        PhoneError::CannotWake(_) => AppWakeRefusal::CannotWake,
                        _ => AppWakeRefusal::UnknownApp,
                    },
                    message: sentence(&refusal.to_string()),
                }),
            })
        })
        .await
    }

    /// Installs on her phone the app `text` makes, which came from
    /// `source`, as her phone installs any.
    async fn give(&self, her: HerPhone, text: String, source: Source) -> AppInstallOutcome {
        self.change_her(her, move |her| {
            her.with(|phone, files| {
                // What the person said of her apps, which installing keeps.
                let before = phone
                    .apps(files)
                    .map_err(|error| Unread::Failed(unread(&error)))?;

                match phone.install(files, &text, source) {
                    Ok(Installed { app, replaced }) => Ok(AppInstallOutcome::Ok {
                        app: drawn(&app, &before),
                        replaced,
                    }),
                    Err(PhoneError::Store(error)) => Err(Unread::Failed(unread(&error))),
                    Err(refusal) => Ok(AppInstallOutcome::Refused {
                        reason: refusal_of(&refusal),
                        message: sentence(&refusal.to_string()),
                    }),
                }
            })
        })
        .await
    }

    /// What `work` makes of the phone of `character` on the blocking pool,
    /// as [`Daemon::change_her`] makes it.
    async fn change<T: Changed>(
        &self,
        character: &str,
        work: impl FnOnce(&HerPhone) -> Result<T, Unread> + Send + 'static,
    ) -> T {
        match self.her_phone(character).await {
            Ok(her) => self.change_her(her, work).await,
            Err(unread) => unread.into(),
        }
    }

    /// What `work` makes of `her` phone on the blocking pool; when it changed
    /// her phone, the stream says so, and her actor, while she runs, reads
    /// its rings again, in the same piece of work, which a caller that stops
    /// waiting does not cut in two.
    async fn change_her<T: Changed>(
        &self,
        her: HerPhone,
        work: impl FnOnce(&HerPhone) -> Result<T, Unread> + Send + 'static,
    ) -> T {
        let daemon = self.clone();

        blocking(move || {
            let outcome = work(&her).unwrap_or_else(T::from);

            if outcome.changed() {
                daemon.phone_changed(&her.id);
            }

            outcome
        })
        .await
    }

    /// Her phone changed by the person's hand: the stream says so, and her
    /// actor, while she runs, reads its rings again.
    fn phone_changed(&self, character: &Identifier) {
        self.world().events.emit(Event::PhoneChanged {
            character_id: character.clone(),
        });

        if let Some(handle) = self.live(character) {
            handle.phone_changed();
        }
    }
}

/// An outcome of the person's change of her phone, which says why her
/// phone was not reached as every verb on it does, and whether it changed
/// her phone.
trait Changed: From<Unread> + Send + 'static {
    fn changed(&self) -> bool;
}

impl Changed for AppInstallOutcome {
    fn changed(&self) -> bool {
        matches!(self, Self::Ok { .. })
    }
}

impl Changed for AppRemoveOutcome {
    fn changed(&self) -> bool {
        matches!(self, Self::Ok)
    }
}

impl Changed for AppWakeOutcome {
    fn changed(&self) -> bool {
        matches!(self, Self::Ok)
    }
}

/// `app` of the App Store as its page there says it, with how it stands
/// on her phone, whose apps are `on_phone`.
fn store_app(app: &CatalogApp, on_phone: &OnPhone) -> StoreApp {
    StoreApp {
        id: app.id().clone(),
        name: app.name().to_owned(),
        summary: app.summary().to_owned(),
        icon: app.icon().to_owned(),
        tint: app.tint().to_owned(),
        version: app.version().to_owned(),
        changes: app.changes().to_owned(),
        wakes: app.wakes(),
        it_may: said(app.wakes()),
        status: app.status(&on_phone.apps),
    }
}

/// What an app that does or does not wake her may do, a line each, as the
/// App Store says it.
fn said(wakes: bool) -> Vec<String> {
    it_may(wakes).into_iter().map(str::to_owned).collect()
}

/// Why her phone refused an app given to her.
fn refusal_of(refusal: &PhoneError) -> AppInstallRefusal {
    match refusal {
        PhoneError::IdTaken(_) => AppInstallRefusal::ComesWithPhone,
        _ => AppInstallRefusal::NotAnApp,
    }
}

/// The App Store's app `id` not given to her, said to the person; a
/// catalog that could not be read is a failure, said as its reader says it.
fn not_installable(id: &str, refusal: &NotInstallable) -> AppInstallOutcome {
    let (reason, message) = match refusal {
        NotInstallable::ComesWithPhone(name) => (
            AppInstallRefusal::ComesWithPhone,
            format!("{name} comes with her phone: there is nothing to install."),
        ),
        NotInstallable::NotInStore(_) => (
            AppInstallRefusal::NotInStore,
            format!("There is no app \"{id}\" in the App Store."),
        ),
        NotInstallable::AlreadyInstalled(held) => (
            AppInstallRefusal::AlreadyInstalled,
            format!("{} {} is on her phone already.", held.name, held.version),
        ),
        NotInstallable::Catalog(error @ CatalogError::NotTheApp { .. }) => {
            (AppInstallRefusal::NotAsListed, sentence(&error.to_string()))
        }
        NotInstallable::Catalog(error) => {
            return AppInstallOutcome::Failed {
                message: sentence(&error.to_string()),
            };
        }
    };

    AppInstallOutcome::Refused { reason, message }
}

impl From<Unread> for StoreOutcome {
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

impl From<Unread> for AppPreviewOutcome {
    fn from(unread: Unread) -> Self {
        match unread {
            Unread::UnknownCharacter(message) => Self::Refused {
                reason: AppInstallRefusal::UnknownCharacter,
                message,
            },
            Unread::NoPhone(message) => Self::Refused {
                reason: AppInstallRefusal::NoPhone,
                message,
            },
            Unread::Failed(message) => Self::Failed { message },
        }
    }
}

impl From<Unread> for AppInstallOutcome {
    fn from(unread: Unread) -> Self {
        match unread {
            Unread::UnknownCharacter(message) => Self::Refused {
                reason: AppInstallRefusal::UnknownCharacter,
                message,
            },
            Unread::NoPhone(message) => Self::Refused {
                reason: AppInstallRefusal::NoPhone,
                message,
            },
            Unread::Failed(message) => Self::Failed { message },
        }
    }
}

impl From<Unread> for AppRemoveOutcome {
    fn from(unread: Unread) -> Self {
        match unread {
            Unread::UnknownCharacter(message) => Self::Refused {
                reason: AppRemoveRefusal::UnknownCharacter,
                message,
            },
            Unread::NoPhone(message) => Self::Refused {
                reason: AppRemoveRefusal::NoPhone,
                message,
            },
            Unread::Failed(message) => Self::Failed { message },
        }
    }
}

impl From<Unread> for AppWakeOutcome {
    fn from(unread: Unread) -> Self {
        match unread {
            Unread::UnknownCharacter(message) => Self::Refused {
                reason: AppWakeRefusal::UnknownCharacter,
                message,
            },
            Unread::NoPhone(message) => Self::Refused {
                reason: AppWakeRefusal::NoPhone,
                message,
            },
            Unread::Failed(message) => Self::Failed { message },
        }
    }
}
