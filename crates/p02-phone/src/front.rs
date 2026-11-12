//! `phone.json`: what she has in front on her phone and what she last did
//! on it, among the files its caller hands in, beside the apps' own.

use p02_contracts::{LeasedFiles, StoreError};
use p02_core::Timestamp;
use p02_shared::Identifier;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::app::App;
use crate::installed::Listed;
use crate::time::Now;

const PATH: &str = "phone.json";

/// What she has in front on her phone, none her home screen, and what she
/// last did on it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PhoneState {
    pub front: Option<Front>,
    pub did: Option<Did>,
}

/// An app she has in front, on one of its views.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Front {
    pub app: Identifier,
    pub view: Identifier,
}

/// What she last did on her phone: the app, a few words in the past tense,
/// and when.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Did {
    pub app: Identifier,
    pub words: String,
    pub at: Timestamp,
}

impl PhoneState {
    /// What her phone, whose apps are `apps`, keeps of her in `files`, read
    /// forgivingly: no file is her home screen with nothing done, and so is
    /// each part that does not read or names an app or a view no longer on
    /// the phone.
    pub(crate) fn read(files: &dyn LeasedFiles, apps: &[Listed]) -> Result<Self, StoreError> {
        let Some(document) = files.read_json(PATH)? else {
            return Ok(Self::default());
        };
        let on_phone = |id: &Identifier| apps.iter().find(|app| app.id == *id);
        let front = document
            .get("front")
            .and_then(|front| Front::deserialize(front).ok())
            .filter(|front| {
                on_phone(&front.app)
                    .is_some_and(|app| app.views.iter().any(|view| *view.id() == front.view))
            });
        let did = document
            .get("did")
            .and_then(|did| Did::deserialize(did).ok())
            .filter(|did| on_phone(&did.app).is_some());

        Ok(Self { front, did })
    }

    /// Puts `app`, on `view`, in front of her, and says she `did` it at
    /// `now`, in place of what the file held.
    pub(crate) fn put(
        files: &mut dyn LeasedFiles,
        app: &App,
        view: &Identifier,
        did: &str,
        now: &Now,
    ) -> Result<(), StoreError> {
        let front = Front {
            app: app.id().clone(),
            view: view.clone(),
        };
        let did = Did {
            app: app.id().clone(),
            words: did.to_owned(),
            at: now.at().clone(),
        };

        files.write_json(PATH, &json!({"front": front, "did": did}))
    }

    /// Closes `app` when she has it in front, so her home screen is, and
    /// leaves the rest of the file as it was.
    pub(crate) fn close(files: &mut dyn LeasedFiles, app: &Identifier) -> Result<(), StoreError> {
        let Some(mut document) = files.read_json(PATH)? else {
            return Ok(());
        };
        let in_front = document
            .get("front")
            .and_then(|front| Front::deserialize(front).ok())
            .is_some_and(|front| front.app == *app);

        match document.as_object_mut() {
            Some(parts) if in_front => {
                parts.remove("front");
                files.write_json(PATH, &document)
            }
            _ => Ok(()),
        }
    }
}
