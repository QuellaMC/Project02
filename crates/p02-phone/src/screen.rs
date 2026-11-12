//! What a view of an app shows: one piece of data, which the person's
//! window draws and she reads, in the pieces the phone knows by name.

use p02_shared::{Credentials, JsonLimits, bound_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A view's screen: its pieces, top to bottom.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Screen {
    pub items: Vec<Item>,
}

/// A piece of a screen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Item {
    /// Rows on a card, under a header if it has one.
    List {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        header: Option<String>,
        rows: Vec<Row>,
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
        live: Option<Live>,
    },
    /// A line of plain words, as for a view with nothing in it yet.
    Text { text: String },
}

/// A row of a list: a title, a time or both.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Row {
    /// The thing's own id, which she passes to an action to change it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
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

/// How a readout's reading moves, in milliseconds since the epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "counts", rename_all = "lowercase", deny_unknown_fields)]
pub enum Live {
    /// The time since `from`.
    Up { from: i64 },
    /// The time left until `to`, out of a whole of `of` milliseconds.
    Down { to: i64, of: i64 },
}

impl Screen {
    /// The screen `shown` is, once it keeps within the JSON limits and
    /// holds only pieces and fields the phone knows; otherwise why not.
    pub(crate) fn read(shown: Value) -> Result<Self, String> {
        let shown = bound_json(shown, "screen", JsonLimits::default(), Credentials::Keep)
            .map_err(|problem| problem.to_string())?;
        let screen: Self = serde_json::from_value(shown).map_err(|problem| problem.to_string())?;
        let untitled = screen.items.iter().any(|item| match item {
            Item::List { rows, .. } => rows
                .iter()
                .any(|row| row.title.is_none() && row.time.is_none()),
            Item::Readout { .. } | Item::Text { .. } => false,
        });

        if untitled {
            Err("a row of a list has neither a title nor a time".to_owned())
        } else {
            Ok(screen)
        }
    }
}
