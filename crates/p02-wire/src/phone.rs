//! Her phone as a client reads it: her apps, what she has in front with
//! its screen, what she last did and what rings; and one view's screen, on
//! request. A screen is one piece of data, which her phone reads from the
//! app and her window draws: what the window shows is what she reads.

use p02_core::Timestamp;
use p02_shared::Identifier;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Her phone as it stands, read from her data whether she runs or not:
/// her apps, in her phone's order; what she has in front, none her home
/// screen; what she last did on it; and what rings, which nothing does but
/// while a ring's moment of hers runs.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(optional_fields)]
pub enum PhoneOutcome {
    Ok {
        apps: Vec<PhoneApp>,
        #[serde(skip_serializing_if = "Option::is_none")]
        front: Option<PhoneFront>,
        #[serde(skip_serializing_if = "Option::is_none")]
        did: Option<PhoneDid>,
        ringing: Vec<PhoneRing>,
    },
    Refused {
        reason: PhoneRefusal,
        message: String,
    },
    /// Her phone could not be read.
    Failed { message: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PhoneRefusal {
    UnknownCharacter,
    /// Her settings give her no phone.
    NoPhone,
}

/// An app on her phone as her window draws it and her settings show it:
/// the line she knows it by, its version and where it came from; its icon
/// and the tint of its tile, names of the page's own set, which falls back
/// for one it does not know; whether it says it wakes her, and whether the
/// person lets it; its views, in its order; and the view it opens on.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PhoneApp {
    pub id: Identifier,
    pub name: String,
    pub summary: String,
    pub version: String,
    pub source: AppSource,
    pub icon: String,
    pub tint: String,
    /// Whether it says it wakes her: only such an app sets a ring.
    pub wakes: bool,
    /// Whether the person lets it wake her: yes unless they said it may
    /// not.
    pub may_wake: bool,
    pub views: Vec<AppView>,
    pub opens_on: Identifier,
}

/// Where an app on her phone came from: it comes with her phone, it is the
/// App Store's, or the person added it from a file nobody read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum AppSource {
    BuiltIn,
    Catalog,
    File,
}

/// A view of an app, which she opens it on: a tab, in the Clock.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
pub struct AppView {
    pub id: Identifier,
    pub title: String,
    pub icon: String,
}

/// The app and the view she has in front, and that view's screen, or,
/// when it cannot be shown, the sentence saying why in its place.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct PhoneFront {
    pub app_id: Identifier,
    pub view_id: Identifier,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen: Option<Screen>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// What she last did on her phone: the app, a few words in the past tense,
/// and when.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PhoneDid {
    pub app_id: Identifier,
    pub words: String,
    pub at: Timestamp,
}

/// A ring the moment of hers that runs now tells her: its app's name, its
/// title, its body when it has one, and the time it was set for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct PhoneRing {
    pub app_name: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub at: Timestamp,
}

/// One view of an app on her phone, as a person looking around it sees it:
/// its screen, or why there is none. Looking changes nothing of hers.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ScreenOutcome {
    Ok {
        screen: Screen,
    },
    Refused {
        reason: ScreenRefusal,
        message: String,
    },
    /// Her phone could not be read.
    Failed {
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ScreenRefusal {
    UnknownCharacter,
    /// Her settings give her no phone.
    NoPhone,
    UnknownApp,
    UnknownView,
    /// The app failed to show the view, which the message says.
    AppFailed,
}

/// What a view of an app shows: its pieces, top to bottom.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Screen {
    pub items: Vec<ScreenItem>,
}

/// A piece of a screen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
#[ts(optional_fields)]
pub enum ScreenItem {
    /// Rows on a card, under a header if it has one.
    List {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        header: Option<String>,
        rows: Vec<ScreenRow>,
    },
    /// One large reading, with a label above and a caption below if it has
    /// them.
    Readout {
        /// The thing's own id, which she passes to an action to change it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        /// The reading as of the call.
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        caption: Option<String>,
        /// How the reading moves, when it does.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        live: Option<LiveReading>,
    },
    /// A line of plain words, as for a view with nothing in it yet.
    Text { text: String },
    /// An app's header: its tile, its name, a small line under it and its
    /// status, as a store's page of the app shows them.
    App {
        /// The app's own id, which she passes to an action.
        id: String,
        tile: ScreenTile,
        name: String,
        subtitle: String,
        status: String,
    },
}

/// A row of a list: a title, a time or both.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ScreenRow {
    /// The thing's own id, which she passes to an action to change it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// An app's tile at the row's start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile: Option<ScreenTile>,
    /// A small line above.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// A small line below.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    /// A clock reading, shown large.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    /// Plain text at the row's end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// A switch, shown on or off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub switch: Option<bool>,
}

/// An app's tile as a screen draws it: its icon and its tint, names of the
/// page's own set, as an app's on her home screen are.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ScreenTile {
    pub icon: String,
    pub tint: String,
}

/// How a readout's reading moves, in milliseconds since the epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "counts", rename_all = "lowercase", deny_unknown_fields)]
pub enum LiveReading {
    /// The time since `from`.
    Up { from: i64 },
    /// The time left until `to`, out of a whole of `of` milliseconds.
    Down { to: i64, of: i64 },
}
