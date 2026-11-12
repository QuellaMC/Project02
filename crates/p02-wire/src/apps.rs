//! Her apps in the person's hands: the App Store's catalog as they browse
//! it for her, what an app's file would put on her phone, and what came of
//! giving her an app, removing one, and saying whether one may wake her.
//! Each is the person's own act, which asks nobody, and none needs her to
//! be running.

use p02_shared::Identifier;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::phone::{PhoneApp, PhoneRefusal};

/// The App Store's catalog as the person browses it for her, read anew:
/// each app as its page in the store says it, with the version of it on
/// her phone; or why it could not be read.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum StoreOutcome {
    Ok {
        apps: Vec<StoreApp>,
    },
    Refused {
        reason: PhoneRefusal,
        message: String,
    },
    /// The catalog, or her phone, could not be read.
    Failed {
        message: String,
    },
}

/// An app of the App Store as its page there says it: its tile, its
/// version and what changed in it, whether it says it wakes her, what it
/// may do, a line each, and how it stands on her phone.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct StoreApp {
    pub id: Identifier,
    pub name: String,
    pub summary: String,
    pub icon: String,
    pub tint: String,
    pub version: String,
    pub changes: String,
    pub wakes: bool,
    pub it_may: Vec<String>,
    pub status: StoreAppStatus,
}

/// How an app of the App Store stands on her phone, versions ordered as
/// their three numbers: not on it; on it in an older version than the
/// store's, which the store's updates; or on it in the store's version or
/// a newer one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum StoreAppStatus {
    NotOnPhone,
    Update,
    Installed,
}

/// What an app's file would put on her phone, judged as adding it judges
/// it, with nothing written: what the app is, what it may do, a line each,
/// and the version of it on her phone that adding it replaces; or why the
/// file adds none.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(optional_fields)]
pub enum AppPreviewOutcome {
    Ok {
        id: Identifier,
        name: String,
        summary: String,
        icon: String,
        tint: String,
        version: String,
        wakes: bool,
        it_may: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        replaces: Option<String>,
    },
    Refused {
        reason: AppInstallRefusal,
        message: String,
    },
    /// Her phone could not be read.
    Failed { message: String },
}

/// What came of giving her an app, from the App Store or from a file: the
/// app as her phone now lists it, and the version of it that it replaced,
/// when it replaced one; or why it was not given.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(optional_fields)]
pub enum AppInstallOutcome {
    Ok {
        app: PhoneApp,
        #[serde(skip_serializing_if = "Option::is_none")]
        replaced: Option<String>,
    },
    /// Nothing was written.
    Refused {
        reason: AppInstallRefusal,
        message: String,
    },
    /// The App Store, or her phone, could not be read or written: her
    /// phone is as it was.
    Failed { message: String },
}

/// Why an app is not given to her: an app of the App Store, or one from a
/// file, which a preview of it says too.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum AppInstallRefusal {
    UnknownCharacter,
    /// Her settings give her no phone.
    NoPhone,
    /// The App Store lists no such app.
    NotInStore,
    /// The phone comes with an app of that id.
    ComesWithPhone,
    /// Her phone holds the app in the version the App Store lists.
    AlreadyInstalled,
    /// The app's file is not what the App Store lists.
    NotAsListed,
    /// The file makes no app.
    NotAnApp,
}

/// What came of removing an app from her phone: it is gone, with what it
/// kept and its rings; or why it was not removed.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AppRemoveOutcome {
    Ok,
    /// Nothing was removed.
    Refused {
        reason: AppRemoveRefusal,
        message: String,
    },
    /// Her phone could not be read or written.
    Failed {
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum AppRemoveRefusal {
    UnknownCharacter,
    /// Her settings give her no phone.
    NoPhone,
    UnknownApp,
    /// The app comes with her phone: it cannot be removed.
    ComesWithPhone,
}

/// The person's say on whether an app may wake her.
#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AppWakeBody {
    pub allowed: bool,
}

/// What came of the person's say on whether an app may wake her: it is
/// kept; or why it is not.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AppWakeOutcome {
    Ok,
    Refused {
        reason: AppWakeRefusal,
        message: String,
    },
    /// Her phone could not be read or written.
    Failed {
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum AppWakeRefusal {
    UnknownCharacter,
    /// Her settings give her no phone.
    NoPhone,
    UnknownApp,
    /// The app does not say it wakes her: it sets no ring.
    CannotWake,
}
