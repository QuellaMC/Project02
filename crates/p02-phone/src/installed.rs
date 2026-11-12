//! The apps installed on her phone, among the files its caller hands in:
//! each one's own file, `apps/<app-id>.txt`, beside what it keeps, and
//! `installed.json`, the list of them as her phone lists them without
//! running any.

use std::iter;
use std::sync::Arc;

use p02_contracts::{LeasedFiles, StoreError};
use p02_shared::Identifier;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::app::App;
use crate::data::Kept;
use crate::error::PhoneError;
use crate::front::PhoneState;
use crate::manifest::View;
use crate::phone::Phone;

const LIST: &str = "installed.json";
const UNREAD_LIST: &str =
    "the list of the apps installed on the phone does not read, and was passed over";

/// Where an app installed on her phone came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Catalog,
    File,
}

/// An app on her phone as her phone lists it, without running it: what
/// its manifest says to name and draw it by, its version, whether it wakes
/// her, and where it came from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub id: Identifier,
    pub name: String,
    pub summary: String,
    pub version: String,
    pub icon: String,
    pub tint: String,
    pub wakes: bool,
    pub views: Vec<View>,
    pub opens_on: Identifier,
    /// Where it came from; none for an app the phone comes with.
    pub source: Option<Source>,
}

/// What is on her phone: the apps it comes with, then those installed on
/// it by name, then the App Store, and what of the list of the installed
/// was passed over, a sentence each.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OnPhone {
    pub apps: Vec<Listed>,
    pub passed_over: Vec<String>,
}

/// The list of the apps installed on her phone, as `files` keep it.
#[derive(Debug, Default)]
struct Installed {
    apps: Vec<Listed>,
    passed_over: Vec<String>,
}

impl Listed {
    fn of(app: &App, source: Option<Source>) -> Self {
        Self {
            id: app.id().clone(),
            name: app.name().to_owned(),
            summary: app.summary().to_owned(),
            version: app.version().to_owned(),
            icon: app.icon().to_owned(),
            tint: app.tint().to_owned(),
            wakes: app.wakes(),
            views: app.views().to_vec(),
            opens_on: app.opens_on().clone(),
            source,
        }
    }
}

impl Installed {
    /// The list, read forgivingly: no file is none installed, and a list,
    /// or an entry of it, that does not read is passed over and said.
    fn read(files: &dyn LeasedFiles) -> Result<Self, StoreError> {
        let Some(list) = files.read_json(LIST)? else {
            return Ok(Self::default());
        };
        let Some(entries) = list.get("apps").and_then(Value::as_array) else {
            return Ok(Self {
                apps: Vec::new(),
                passed_over: vec![UNREAD_LIST.to_owned()],
            });
        };
        let mut installed = Self::default();

        for entry in entries {
            match Listed::deserialize(entry) {
                Ok(listed) if listed.source.is_some() => installed.apps.push(listed),
                Ok(_) => installed
                    .passed_over
                    .push(unread(entry, "it says not where it came from")),
                Err(error) => installed
                    .passed_over
                    .push(unread(entry, &error.to_string())),
            }
        }

        Ok(installed)
    }

    /// Replaces the list with this one, whole.
    fn write(&self, files: &mut dyn LeasedFiles) -> Result<(), StoreError> {
        files.write_json(LIST, &json!({"apps": self.apps}))
    }
}

impl Phone {
    /// What is on her phone, as `files` keep it, without running anything:
    /// the apps compiled into the daemon, then those installed on it by
    /// name, then the App Store.
    ///
    /// # Errors
    ///
    /// The store's, when it fails.
    pub fn apps(&self, files: &dyn LeasedFiles) -> Result<OnPhone, StoreError> {
        let Installed {
            apps: mut installed,
            passed_over,
        } = Installed::read(files)?;

        installed.sort_by_cached_key(|app| app.name.to_lowercase());

        Ok(OnPhone {
            apps: self
                .bundled
                .iter()
                .map(|app| Listed::of(app, None))
                .chain(installed)
                .chain(iter::once(Listed::of(&self.store, None)))
                .collect(),
            passed_over,
        })
    }

    /// The app of `id` installed on her phone, as `files` keep it, made from
    /// its file.
    pub(crate) fn installed(
        &self,
        files: &dyn LeasedFiles,
        id: &str,
    ) -> Result<Arc<App>, PhoneError> {
        let listed = Installed::read(files)?
            .apps
            .into_iter()
            .find(|app| app.id.as_str() == id)
            .ok_or_else(|| PhoneError::NoApp(id.to_owned()))?;
        let cannot_run = |why: String| PhoneError::CannotRun {
            app: listed.name.clone(),
            why,
        };
        let text = files
            .read_text(&script(&listed.id))?
            .ok_or_else(|| cannot_run("its file is gone".to_owned()))?;

        self.made(&text).map_err(cannot_run)
    }

    /// Installs on her phone, in `files`, the app `text` makes, which came
    /// from `source`. An app of its id already installed is replaced by it,
    /// keeping what it keeps: that is an update.
    ///
    /// # Errors
    ///
    /// [`PhoneError::NotAnApp`] when `text` makes no app,
    /// [`PhoneError::IdTaken`] when the phone comes with an app of its id,
    /// or the store's. An app refused writes nothing.
    pub fn install(
        &self,
        files: &mut dyn LeasedFiles,
        text: &str,
        source: Source,
    ) -> Result<(), PhoneError> {
        let app = self.made(text).map_err(PhoneError::NotAnApp)?;

        if let Some(taken) = self.comes_with(app.id().as_str()) {
            return Err(PhoneError::IdTaken(taken.name().to_owned()));
        }

        let mut installed = Installed::read(files)?;

        files.write_text(&script(app.id()), text)?;
        installed.apps.retain(|kept| kept.id != *app.id());
        installed.apps.push(Listed::of(&app, Some(source)));
        Ok(installed.write(files)?)
    }

    /// Removes the app of `id` installed on her phone, in `files`: what it
    /// keeps, with its rings, its file, and its place on the list. When she
    /// had it in front, her home screen is. Each step can be taken again,
    /// so a removal a crash cut short is finished by removing it again.
    ///
    /// # Errors
    ///
    /// [`PhoneError::ComesWithPhone`] for an app the phone comes with,
    /// [`PhoneError::NoApp`] for one not installed, or the store's.
    pub fn remove(&self, files: &mut dyn LeasedFiles, id: &str) -> Result<(), PhoneError> {
        if let Some(kept) = self.comes_with(id) {
            return Err(PhoneError::ComesWithPhone(kept.name().to_owned()));
        }

        let mut installed = Installed::read(files)?;
        let place = installed
            .apps
            .iter()
            .position(|app| app.id.as_str() == id)
            .ok_or_else(|| PhoneError::NoApp(id.to_owned()))?;
        let removed = installed.apps.remove(place);

        Kept::remove(files, &removed.id)?;
        files.remove(&script(&removed.id))?;
        PhoneState::close(files, &removed.id)?;
        installed.write(files)?;
        Ok(())
    }
}

/// The file of the installed app of `id`: its text.
fn script(id: &Identifier) -> String {
    format!("apps/{id}.txt")
}

/// What is said of `entry`, an entry of the list that does not read, and
/// `why`.
fn unread(entry: &Value, why: &str) -> String {
    let named = entry
        .get("id")
        .and_then(Value::as_str)
        .map_or_else(String::new, |id| format!(" \"{id}\""));

    format!(
        "the app{named} on the list of the apps installed on the phone does not read, and was \
         passed over: {why}"
    )
}
