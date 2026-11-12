//! Her phone: the apps it comes with and those installed on it, opened and
//! used by her and looked at by the person, what she has in front and last
//! did, and the rings its apps set.

use std::collections::HashMap;
use std::iter;
use std::sync::{Arc, Mutex, PoisonError};

use p02_contracts::{LeasedFiles, StoreError};
use p02_shared::{Credentials, Identifier, JsonLimits, bound_json};
use p02_wire::Screen;
use serde_json::{Map, Value};

use crate::app::{App, Runs};
use crate::data::{Kept, Ring};
use crate::engine::{self, Failure};
use crate::error::PhoneError;
use crate::front::PhoneState;
use crate::host::{Access, Host};
use crate::manifest::View;
use crate::net::{End, Exchange, Fetch, Net};
use crate::store;
use crate::time::Now;

/// A phone: the apps it comes with, the App Store among them, and, for
/// every character, the apps installed on hers, which each call finds in
/// the files it is given.
#[derive(Debug)]
pub struct Phone {
    /// The apps compiled into the daemon.
    pub(crate) bundled: Vec<Arc<App>>,
    pub(crate) store: Arc<App>,
    /// Each installed app made from its text, or why the text makes none,
    /// by that text: made once, and kept while the text is unchanged.
    made: Mutex<HashMap<String, Result<Arc<App>, String>>>,
}

/// An app opened: the app, the view it shows, and that view's screen. The
/// open stands whether or not her phone could keep what she now has in
/// front: when it could not, `unkept` says why.
#[derive(Debug)]
pub struct Opened {
    pub app: Arc<App>,
    pub view: Identifier,
    pub screen: Screen,
    pub unkept: Option<StoreError>,
}

/// What an action did: its answer, the view the phone shows after it, and
/// that view's screen, or why it could not be shown. The action stands,
/// saved, either way, and whether or not her phone could keep what she now
/// has in front: when it could not, `unkept` says why.
#[derive(Debug)]
pub struct Acted {
    pub answer: Value,
    pub view: Identifier,
    pub screen: Result<Screen, PhoneError>,
    pub unkept: Option<StoreError>,
}

/// What an action came to on the exchanges it was given: it acted, or it
/// asks for one more request, which its caller makes, with no lease held,
/// before it takes the action again with what came of it.
#[derive(Debug)]
pub enum Acting {
    Acted(Acted),
    Asks(Fetch),
}

/// A ring set on the phone, with its app's id and name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetRing {
    pub app: Identifier,
    pub app_name: String,
    pub ring: Ring,
}

impl Phone {
    /// A phone that comes with `apps`, and the App Store.
    #[must_use]
    pub fn new(apps: Vec<App>) -> Self {
        Self {
            bundled: apps.into_iter().map(Arc::new).collect(),
            store: Arc::new(store::app()),
            made: Mutex::default(),
        }
    }

    /// The app of `id` the phone comes with: one compiled into the daemon,
    /// or the App Store. No app installs over it, and none removes it.
    #[must_use]
    pub fn comes_with(&self, id: &str) -> Option<&Arc<App>> {
        self.bundled
            .iter()
            .chain(iter::once(&self.store))
            .find(|app| app.id().as_str() == id)
    }

    /// The app of `id` on her phone, as `files` keep it: one it comes with,
    /// or one installed on it, made from its file.
    ///
    /// # Errors
    ///
    /// [`PhoneError::NoApp`] when her phone has none,
    /// [`PhoneError::CannotRun`] for an app installed whose file is gone or
    /// no longer makes it, or the store's.
    pub fn app(&self, files: &dyn LeasedFiles, id: &str) -> Result<Arc<App>, PhoneError> {
        match self.comes_with(id) {
            Some(app) => Ok(Arc::clone(app)),
            None => self.installed(files, id),
        }
    }

    /// She opens `app` on `view`, or on the view it opens on when none is
    /// named: it is in front of her, with that view's screen, and opening
    /// it is what she last did, at `now`. What she has in front is kept
    /// once the screen came back, and an open whose keeping failed still
    /// stands.
    ///
    /// # Errors
    ///
    /// [`PhoneError`] when there is no such app or view, when the app
    /// cannot run, when the screen fails or is not one the phone takes, or
    /// when the store fails to be read. An open the phone refuses or the
    /// app fails puts nothing in front.
    pub fn open(
        &self,
        files: &mut dyn LeasedFiles,
        app: &str,
        view: Option<&str>,
        now: &Now,
    ) -> Result<Opened, PhoneError> {
        let app = self.app(files, app)?;
        let view = match view {
            None => app.opens_on().clone(),
            Some(view) => view_of(&app, view)?.clone(),
        };
        let screen = self.screen(files, &app, &view, now)?;

        let unkept =
            PhoneState::put(files, &app, &view, &format!("Opened {}", app.name()), now).err();

        Ok(Opened {
            app,
            view,
            screen,
            unkept,
        })
    }

    /// `app`'s `view` as someone looking at her phone sees it, by a call
    /// that only reads: nothing is put in front of her.
    ///
    /// # Errors
    ///
    /// [`PhoneError`] when there is no such app or view, when the app
    /// cannot run, when the screen fails or is not one the phone takes, or
    /// when the store fails.
    pub fn look(
        &self,
        files: &dyn LeasedFiles,
        app: &str,
        view: &str,
        now: &Now,
    ) -> Result<Screen, PhoneError> {
        let app = self.app(files, app)?;

        self.screen(files, &app, view_of(&app, view)?, now)
    }

    /// What she has in front on her phone and what she last did on it.
    ///
    /// # Errors
    ///
    /// The store's, when it fails.
    pub fn state(&self, files: &dyn LeasedFiles) -> Result<PhoneState, StoreError> {
        PhoneState::read(files, &self.apps(files)?.apps)
    }

    /// Takes `app`'s `action` on `input`, once its contract admits it, and
    /// saves what the action changed when it answered what the phone takes:
    /// the action's view is then in front of her, and the action is what
    /// she last did, at `now`. What she has in front is kept after what the
    /// action changed, and an action whose keeping failed still stands:
    /// failing it would have her take it twice.
    ///
    /// The action runs from what the app keeps, its n-th `phone.net.fetch`
    /// answered by the n-th of `exchanges`, those of its runs before. A run
    /// that asks for a request none answers yet ends there, keeping
    /// nothing, and the call asks for it: its caller makes it and takes the
    /// action again, at the same `now`, with what came of it.
    ///
    /// # Errors
    ///
    /// [`PhoneError`] when there is no such app or action, the app cannot
    /// run, its contract refuses `input`, the action fails, as it does by a
    /// fifth request or one other than it asked at that place before,
    /// answers what the phone does not take or would keep more than it
    /// holds, or when the store fails. A call the phone refuses or the app
    /// fails saves nothing.
    pub fn act(
        &self,
        files: &mut dyn LeasedFiles,
        app: &str,
        action: &str,
        input: &Map<String, Value>,
        exchanges: &[Exchange],
        now: &Now,
    ) -> Result<Acting, PhoneError> {
        let app = self.app(files, app)?;
        let action = app
            .actions()
            .iter()
            .find(|kept| kept.name().as_str() == action)
            .ok_or_else(|| PhoneError::NoAction {
                app: app.name().to_owned(),
                action: action.to_owned(),
            })?;

        action
            .input()
            .validate(action.name(), input)
            .map_err(|rejection| PhoneError::Input {
                app: app.name().to_owned(),
                rejection,
            })?;

        let kept = Kept::read(files, app.id())?;
        let (answer, after) = match app.runs() {
            Runs::Script { text, .. } => {
                let host = Host::new(
                    kept.clone(),
                    now.clone(),
                    Access::ReadWrite { wakes: app.wakes() },
                    Some(Net::new(app.asks(), exchanges)),
                );
                let ran = engine::call(
                    text,
                    &host,
                    action.name().as_str(),
                    &Value::Object(input.clone()),
                );

                match host.end() {
                    Some(End::Asks(fetch)) => return Ok(Acting::Asks(fetch)),
                    Some(End::Fails(words)) => {
                        return Err(PhoneError::Threw {
                            app: app.name().to_owned(),
                            thrown: words.to_owned(),
                        });
                    }
                    None => {}
                }

                let answer = ran
                    .map_err(|failure| failed(&app, failure))?
                    .and_then(|answer| {
                        bound_json(answer, "answer", JsonLimits::default(), Credentials::Keep)
                            .map_err(|problem| problem.to_string())
                    })
                    .map_err(|problem| PhoneError::Answer {
                        app: app.name().to_owned(),
                        problem,
                    })?;

                (answer, host.kept())
            }
            Runs::Store => store::show(&kept, &self.apps(files)?.apps, input).map_err(|words| {
                PhoneError::Refused {
                    app: app.name().to_owned(),
                    words,
                }
            })?,
        };

        if after != kept {
            after.fits().map_err(|problem| PhoneError::KeepsTooMuch {
                app: app.name().to_owned(),
                problem,
            })?;
            after.write(files, app.id())?;
        }

        let unkept = PhoneState::put(files, &app, action.view(), action.did(), now).err();

        Ok(Acting::Acted(Acted {
            answer,
            view: action.view().clone(),
            screen: self.screen(files, &app, action.view(), now),
            unkept,
        }))
    }

    /// Every ring that may wake her, of all her phone's apps, soonest first,
    /// read without running any: an app's rings while it says it wakes her
    /// and the person did not say it may not. Any other app's stay set, and
    /// nothing tells them to her.
    ///
    /// # Errors
    ///
    /// The store's, when it fails.
    pub fn rings(&self, files: &dyn LeasedFiles) -> Result<Vec<SetRing>, StoreError> {
        let on_phone = self.apps(files)?;
        let mut set = Vec::new();

        for app in on_phone
            .apps
            .iter()
            .filter(|app| app.wakes && on_phone.may_wake(app))
        {
            set.extend(
                Kept::read(files, &app.id)?
                    .rings()
                    .iter()
                    .map(|ring| SetRing {
                        app: app.id.clone(),
                        app_name: app.name.clone(),
                        ring: ring.clone(),
                    }),
            );
        }

        set.sort_by(|one, other| one.ring.at().cmp(other.ring.at()));
        Ok(set)
    }

    /// Takes `rings`, from [`Phone::rings`], as told to her. Each still set
    /// for its time is heard by its app's `rang`, if it has one, as a call
    /// of its own that saves all or nothing, and then leaves the app's file
    /// unless `rang` set it anew for another time. A ring cancelled or
    /// moved meanwhile, or of an app no longer on her phone, is left alone.
    /// A `rang` that fails, or an app that cannot run, still lets its ring
    /// go, and comes back as the failure.
    ///
    /// # Errors
    ///
    /// The store's, when it fails; the rings it did not reach stay set.
    pub fn told(
        &self,
        files: &mut dyn LeasedFiles,
        rings: &[SetRing],
        now: &Now,
    ) -> Result<Vec<PhoneError>, StoreError> {
        let mut failures = Vec::new();

        for told in rings {
            let app = match self.app(files, told.app.as_str()) {
                Err(PhoneError::NoApp(_)) => continue,
                Err(PhoneError::Store(error)) => return Err(error),
                app => app,
            };
            let kept = Kept::read(files, &told.app)?;

            if !kept.holds(&told.ring) {
                continue;
            }

            let mut after = app
                .and_then(|app| rang(&app, &kept, &told.ring, now))
                .unwrap_or_else(|failure| {
                    failures.push(failure);
                    kept
                });

            after.let_go(&told.ring);
            after.write(files, &told.app)?;
        }

        Ok(failures)
    }

    /// The app `text` makes, or why it makes none, in the words of the first
    /// rule it breaks: made at the first call that needs it, and kept.
    pub(crate) fn made(&self, text: &str) -> Result<Arc<App>, String> {
        let mut made = self.made.lock().unwrap_or_else(PoisonError::into_inner);

        if let Some(app) = made.get(text) {
            return app.clone();
        }

        let app = App::new(text)
            .map(Arc::new)
            .map_err(|refusal| refusal.to_string());

        made.insert(text.to_owned(), app.clone());
        app
    }

    /// What `app`'s `view` shows, as `files` keep it, by a call that only
    /// reads.
    fn screen(
        &self,
        files: &dyn LeasedFiles,
        app: &App,
        view: &Identifier,
        now: &Now,
    ) -> Result<Screen, PhoneError> {
        let kept = Kept::read(files, app.id())?;

        match app.runs() {
            Runs::Script { text, .. } => {
                let host = Host::new(kept, now.clone(), Access::ReadOnly, None);

                engine::call(text, &host, "screen", &Value::from(view.as_str()))
                    .map_err(|failure| failed(app, failure))?
                    .and_then(crate::screen::read)
                    .map_err(|problem| PhoneError::Screen {
                        app: app.name().to_owned(),
                        problem,
                    })
            }
            Runs::Store => Ok(store::screen(&kept, &self.apps(files)?.apps)),
        }
    }
}

/// The view of `app` named `view`.
fn view_of<'a>(app: &'a App, view: &str) -> Result<&'a Identifier, PhoneError> {
    app.views()
        .iter()
        .map(View::id)
        .find(|kept| kept.as_str() == view)
        .ok_or_else(|| PhoneError::NoView {
            app: app.name().to_owned(),
            view: view.to_owned(),
        })
}

/// What `app` keeps once its `rang` heard `ring`, or why that failed.
/// Nothing reads what `rang` answers.
fn rang(app: &App, kept: &Kept, ring: &Ring, now: &Now) -> Result<Kept, PhoneError> {
    let Runs::Script {
        text,
        hears_rings: true,
    } = app.runs()
    else {
        return Ok(kept.clone());
    };
    let host = Host::new(
        kept.clone(),
        now.clone(),
        Access::ReadWrite { wakes: app.wakes() },
        None,
    );
    let _ =
        engine::call(text, &host, "rang", &ring.shown()).map_err(|failure| failed(app, failure))?;
    let after = host.kept();

    after.fits().map_err(|problem| PhoneError::KeepsTooMuch {
        app: app.name().to_owned(),
        problem,
    })?;
    Ok(after)
}

/// What `failure` of a call into `app` says.
fn failed(app: &App, failure: Failure) -> PhoneError {
    let app = app.name().to_owned();

    match failure {
        Failure::Refused(words) => PhoneError::Refused { app, words },
        Failure::Threw(thrown) => PhoneError::Threw { app, thrown },
        Failure::TookTooLong => PhoneError::TookTooLong { app },
        Failure::OutOfMemory => PhoneError::OutOfMemory { app },
    }
}
