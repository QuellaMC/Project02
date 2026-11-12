//! Whether an app may wake her, as the person says it: `muted.json`, among
//! the files its caller hands in, beside the apps' own, lists the apps they
//! said may not, and every other may. It is said of an app, so it goes when
//! the app is removed, and an update keeps it.

use p02_contracts::{LeasedFiles, StoreError};
use p02_shared::Identifier;
use serde::Deserialize;
use serde_json::json;

use crate::error::PhoneError;
use crate::installed::OnPhone;
use crate::phone::Phone;

const PATH: &str = "muted.json";
const UNREAD: &str = "the list of the apps that may not wake her does not read, and was passed over: \
                      each may wake her";

/// The apps the person said may not wake her, by id.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Muted(Vec<Identifier>);

#[derive(Deserialize)]
struct Document {
    apps: Vec<Identifier>,
}

impl Muted {
    /// The list as `files` keep it, read forgivingly: no file is nothing
    /// said, and a list that does not read is passed over, which the
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

    /// Whether the person said the app of `id` may not wake her.
    pub(crate) fn holds(&self, id: &Identifier) -> bool {
        self.0.contains(id)
    }

    /// Forgets what the person said of the app of `id`, which is leaving her
    /// phone: a list that never named it is left as it is.
    pub(crate) fn forget(files: &mut dyn LeasedFiles, id: &Identifier) -> Result<(), StoreError> {
        let (mut muted, _) = Self::read(files)?;

        if muted.holds(id) {
            muted.0.retain(|kept| kept != id);
            muted.write(files)?;
        }

        Ok(())
    }

    /// Replaces the list with this one, whole.
    fn write(&self, files: &mut dyn LeasedFiles) -> Result<(), StoreError> {
        files.write_json(PATH, &json!({"apps": self.0}))
    }
}

impl Phone {
    /// Lets the app of `id` on her phone wake her, or not, as the person
    /// says, in `files`: their say is kept with her phone, and an app may
    /// wake her unless they said it may not. While it may not, its rings
    /// stay set and nothing tells them to her.
    ///
    /// # Errors
    ///
    /// [`PhoneError::NoApp`] for an app not on her phone,
    /// [`PhoneError::CannotWake`] for one that does not say it wakes her,
    /// or the store's.
    pub fn let_wake(
        &self,
        files: &mut dyn LeasedFiles,
        id: &str,
        allowed: bool,
    ) -> Result<(), PhoneError> {
        let OnPhone {
            apps, mut muted, ..
        } = self.apps(files)?;
        let app = apps
            .into_iter()
            .find(|app| app.id.as_str() == id)
            .ok_or_else(|| PhoneError::NoApp(id.to_owned()))?;

        if !app.wakes {
            return Err(PhoneError::CannotWake(app.name));
        }

        muted.0.retain(|kept| *kept != app.id);

        if !allowed {
            muted.0.push(app.id);
        }

        Ok(muted.write(files)?)
    }
}
