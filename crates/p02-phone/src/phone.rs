//! Her phone: its apps opened and used by her and looked at by the person,
//! what she has in front and last did, and the rings its apps set.

use p02_contracts::{LeasedFiles, StoreError};
use p02_shared::{Credentials, Identifier, JsonLimits, bound_json};
use p02_wire::Screen;
use serde_json::{Map, Value};

use crate::app::App;
use crate::data::{Kept, Ring};
use crate::engine::{self, Failure};
use crate::error::PhoneError;
use crate::front::PhoneState;
use crate::host::{Access, Host};
use crate::manifest::View;
use crate::time::Now;

/// Her phone, made from its apps.
#[derive(Clone, Debug)]
pub struct Phone {
    apps: Vec<App>,
}

/// An app opened: the app, the view it shows, and that view's screen. The
/// open stands whether or not her phone could keep what she now has in
/// front: when it could not, `unkept` says why.
#[derive(Debug)]
pub struct Opened<'a> {
    pub app: &'a App,
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

/// A ring set on the phone, with its app's id and name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetRing {
    pub app: Identifier,
    pub app_name: String,
    pub ring: Ring,
}

impl Phone {
    #[must_use]
    pub fn new(apps: Vec<App>) -> Self {
        Self { apps }
    }

    #[must_use]
    pub fn apps(&self) -> &[App] {
        &self.apps
    }

    /// The app of `id` on the phone.
    ///
    /// # Errors
    ///
    /// [`PhoneError::NoApp`] when the phone has none.
    pub fn app(&self, id: &str) -> Result<&App, PhoneError> {
        self.apps
            .iter()
            .find(|app| app.id().as_str() == id)
            .ok_or_else(|| PhoneError::NoApp(id.to_owned()))
    }

    /// She opens `app` on `view`, or on the view it opens on when none is
    /// named: it is in front of her, with that view's screen, and opening
    /// it is what she last did, at `now`. What she has in front is kept
    /// once the screen came back, and an open whose keeping failed still
    /// stands.
    ///
    /// # Errors
    ///
    /// [`PhoneError`] when there is no such app or view, when the screen
    /// fails or is not one the phone takes, or when the store fails to be
    /// read. An open the phone refuses or the app fails puts nothing in
    /// front.
    pub fn open(
        &self,
        files: &mut dyn LeasedFiles,
        app: &str,
        view: Option<&str>,
        now: &Now,
    ) -> Result<Opened<'_>, PhoneError> {
        let app = self.app(app)?;
        let view = match view {
            None => app.opens_on(),
            Some(view) => view_of(app, view)?,
        };
        let screen = screen(files, app, view, now)?;

        let unkept =
            PhoneState::put(files, app, view, &format!("Opened {}", app.name()), now).err();

        Ok(Opened {
            app,
            view: view.clone(),
            screen,
            unkept,
        })
    }

    /// `app`'s `view` as someone looking at her phone sees it, by a call
    /// that only reads: nothing is put in front of her.
    ///
    /// # Errors
    ///
    /// [`PhoneError`] when there is no such app or view, when the screen
    /// fails or is not one the phone takes, or when the store fails.
    pub fn look(
        &self,
        files: &dyn LeasedFiles,
        app: &str,
        view: &str,
        now: &Now,
    ) -> Result<Screen, PhoneError> {
        let app = self.app(app)?;

        screen(files, app, view_of(app, view)?, now)
    }

    /// What she has in front on her phone and what she last did on it.
    ///
    /// # Errors
    ///
    /// The store's, when it fails.
    pub fn state(&self, files: &dyn LeasedFiles) -> Result<PhoneState, StoreError> {
        PhoneState::read(files, self)
    }

    /// Takes `app`'s `action` on `input`, once its contract admits it, and
    /// saves what the action changed when it answered what the phone takes:
    /// the action's view is then in front of her, and the action is what
    /// she last did, at `now`. What she has in front is kept after what the
    /// action changed, and an action whose keeping failed still stands:
    /// failing it would have her take it twice.
    ///
    /// # Errors
    ///
    /// [`PhoneError`] when there is no such app or action, its contract
    /// refuses `input`, the action fails, answers what the phone does not
    /// take or would keep more than it holds, or when the store fails. A
    /// call the phone refuses or the app fails saves nothing.
    pub fn act(
        &self,
        files: &mut dyn LeasedFiles,
        app: &str,
        action: &str,
        input: &Map<String, Value>,
        now: &Now,
    ) -> Result<Acted, PhoneError> {
        let app = self.app(app)?;
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
        let host = Host::new(kept.clone(), now.clone(), Access::ReadWrite);
        let answered = engine::call(
            app.script(),
            &host,
            action.name().as_str(),
            &Value::Object(input.clone()),
        )
        .map_err(|failure| failed(app, failure))?;
        let answer = answered
            .and_then(|answer| {
                bound_json(answer, "answer", JsonLimits::default(), Credentials::Keep)
                    .map_err(|problem| problem.to_string())
            })
            .map_err(|problem| PhoneError::Answer {
                app: app.name().to_owned(),
                problem,
            })?;
        let after = host.kept();

        if after != kept {
            after.fits().map_err(|problem| PhoneError::KeepsTooMuch {
                app: app.name().to_owned(),
                problem,
            })?;
            after.write(files, app.id())?;
        }

        let unkept = PhoneState::put(files, app, action.view(), action.did(), now).err();

        Ok(Acted {
            answer,
            view: action.view().clone(),
            screen: screen(files, app, action.view(), now),
            unkept,
        })
    }

    /// Every ring set on the phone, of all its apps, soonest first.
    ///
    /// # Errors
    ///
    /// The store's, when it fails.
    pub fn rings(&self, files: &dyn LeasedFiles) -> Result<Vec<SetRing>, StoreError> {
        let mut set = Vec::new();

        for app in &self.apps {
            set.extend(
                Kept::read(files, app.id())?
                    .rings()
                    .iter()
                    .map(|ring| SetRing {
                        app: app.id().clone(),
                        app_name: app.name().to_owned(),
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
    /// moved meanwhile is left alone. A `rang` that fails still lets its
    /// ring go, and comes back as the failure.
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
            let Some(app) = self.apps.iter().find(|app| *app.id() == told.app) else {
                continue;
            };
            let kept = Kept::read(files, app.id())?;

            if !kept.holds(&told.ring) {
                continue;
            }

            let mut after = rang(app, &kept, &told.ring, now).unwrap_or_else(|failure| {
                failures.push(failure);
                kept
            });

            after.let_go(&told.ring);
            after.write(files, app.id())?;
        }

        Ok(failures)
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

/// What `app`'s `view` shows, by a call that only reads.
fn screen(
    files: &dyn LeasedFiles,
    app: &App,
    view: &Identifier,
    now: &Now,
) -> Result<Screen, PhoneError> {
    let host = Host::new(Kept::read(files, app.id())?, now.clone(), Access::ReadOnly);

    engine::call(app.script(), &host, "screen", &Value::from(view.as_str()))
        .map_err(|failure| failed(app, failure))?
        .and_then(crate::screen::read)
        .map_err(|problem| PhoneError::Screen {
            app: app.name().to_owned(),
            problem,
        })
}

/// What `app` keeps once its `rang` heard `ring`, or why that failed.
/// Nothing reads what `rang` answers.
fn rang(app: &App, kept: &Kept, ring: &Ring, now: &Now) -> Result<Kept, PhoneError> {
    if !app.hears_rings() {
        return Ok(kept.clone());
    }

    let host = Host::new(kept.clone(), now.clone(), Access::ReadWrite);
    let _ = engine::call(app.script(), &host, "rang", &ring.shown())
        .map_err(|failure| failed(app, failure))?;
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
