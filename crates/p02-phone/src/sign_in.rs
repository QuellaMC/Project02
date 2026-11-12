//! How an app that asks a model is signed in on her phone, as the person
//! said it: `signed-in.json`, among the files its caller hands in, beside
//! the apps' own, holds for each app signed in the connection of the
//! person's it is signed in with and the model chosen for it, if one was.
//! Every other app is signed out. It is said of an app, so it goes when
//! the app is removed, and an update keeps it.

use std::collections::BTreeMap;

use p02_contracts::{LeasedFiles, StoreError};
use p02_shared::Identifier;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::account::Account;
use crate::error::PhoneError;
use crate::installed::{Listed, OnPhone};
use crate::phone::Phone;

const PATH: &str = "signed-in.json";
const UNREAD: &str = "the list of the apps signed in on the phone does not read, and was passed \
                      over: each is signed out";

/// How an app is signed in: the connection of the person's it asks
/// through, by the id its caller knows it by, and the model the person
/// chose for it, none while it asks the one its connection starts with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedIn {
    pub connection: Identifier,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// The apps signed in on her phone, by id.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SignIns(BTreeMap<Identifier, SignedIn>);

#[derive(Deserialize)]
struct Document {
    apps: BTreeMap<Identifier, SignedIn>,
}

impl SignIns {
    /// The list as `files` keep it, read forgivingly: no file is none
    /// signed in, and a list that does not read is passed over, which the
    /// sentence beside it says.
    pub(crate) fn read(files: &dyn LeasedFiles) -> Result<(Self, Option<String>), StoreError> {
        let Some(document) = files.read_json(PATH)? else {
            return Ok((Self::default(), None));
        };

        Ok(match Document::deserialize(&document) {
            Ok(Document { apps }) => (Self(apps), None),
            Err(_) => (Self::default(), Some(UNREAD.to_owned())),
        })
    }

    /// How the app of `id` is signed in, while it is.
    pub(crate) fn of(&self, id: &Identifier) -> Option<&SignedIn> {
        self.0.get(id)
    }

    /// Forgets how the app of `id`, which is leaving her phone, was signed
    /// in: a list that never named it is left as it is.
    pub(crate) fn forget(files: &mut dyn LeasedFiles, id: &Identifier) -> Result<(), StoreError> {
        let (mut sign_ins, _) = Self::read(files)?;

        if sign_ins.0.remove(id).is_some() {
            sign_ins.write(files)?;
        }

        Ok(())
    }

    /// Replaces the list with this one, whole.
    fn write(&self, files: &mut dyn LeasedFiles) -> Result<(), StoreError> {
        files.write_json(PATH, &json!({"apps": self.0}))
    }
}

impl OnPhone {
    /// The app of `id` on her phone that signs in, with the connection of
    /// the person's it signs in to.
    ///
    /// # Errors
    ///
    /// [`PhoneError::NoApp`] for an app not on her phone, and
    /// [`PhoneError::SignsInToNothing`] for one whose account is no
    /// connection.
    pub fn signing_in(&self, id: &str) -> Result<(&Listed, &'static Account), PhoneError> {
        let app = self
            .app(id)
            .ok_or_else(|| PhoneError::NoApp(id.to_owned()))?;
        let connection = app
            .asks
            .connection()
            .ok_or_else(|| PhoneError::SignsInToNothing(app.name.clone()))?;

        Ok((app, connection))
    }

    /// How `app` is signed in, while it is.
    #[must_use]
    pub fn signed_in(&self, app: &Listed) -> Option<&SignedIn> {
        self.sign_ins.of(&app.id)
    }
}

impl Phone {
    /// Signs the app of `id` on her phone in as `signed_in` says, or out
    /// with none, in `files`, as the person says: kept with her phone, the
    /// list written whole, until the app is removed.
    ///
    /// # Errors
    ///
    /// [`PhoneError::NoApp`] for an app not on her phone,
    /// [`PhoneError::SignsInToNothing`] for one whose account is no
    /// connection, or the store's.
    pub fn sign_in(
        &self,
        files: &mut dyn LeasedFiles,
        id: &str,
        signed_in: Option<SignedIn>,
    ) -> Result<(), PhoneError> {
        let on_phone = self.apps(files)?;
        let (app, _) = on_phone.signing_in(id)?;
        let mut sign_ins = on_phone.sign_ins.clone();

        match signed_in {
            Some(signed_in) => sign_ins.0.insert(app.id.clone(), signed_in),
            None => sign_ins.0.remove(&app.id),
        };

        Ok(sign_ins.write(files)?)
    }
}
