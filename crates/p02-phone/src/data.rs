//! What an app keeps, in its one file: `apps/<app-id>.json` among the files
//! its caller hands in, holding `{"storage": {...}, "rings": [...]}`.

use p02_contracts::{LeasedFiles, StoreError};
use p02_core::Timestamp;
use p02_shared::{BoundJsonError, Credentials, Identifier, JsonLimits, bound_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// What an app keeps: its storage, a JSON value under each key, and its
/// rings, soonest first.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Kept {
    pub(crate) storage: Map<String, Value>,
    rings: Vec<Ring>,
}

/// A ring an app set: at a moment, with a title and maybe a body. An app
/// knows its rings by their ids, which are its own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ring {
    id: String,
    at: Timestamp,
    title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body: Option<String>,
}

impl Ring {
    pub(crate) fn new(id: String, at: Timestamp, title: String, body: Option<String>) -> Self {
        Self {
            id,
            at,
            title,
            body,
        }
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub fn at(&self) -> &Timestamp {
        &self.at
    }

    #[must_use]
    pub fn title(&self) -> &str {
        &self.title
    }

    #[must_use]
    pub fn body(&self) -> Option<&str> {
        self.body.as_deref()
    }

    /// The ring as a script meets it: `at` in milliseconds since the epoch.
    pub(crate) fn shown(&self) -> Value {
        let mut shown = json!({
            "id": self.id,
            "at": self.at.unix_millis(),
            "title": self.title,
        });

        if let Some(body) = &self.body {
            shown["body"] = json!(body);
        }

        shown
    }

    /// Whether `other` is this ring, still set for the same time.
    fn is(&self, other: &Self) -> bool {
        self.id == other.id && self.at == other.at
    }
}

impl Kept {
    /// What `app` keeps, read forgivingly: no file, or no member, is an
    /// empty one, and a ring that does not read is passed over.
    pub(crate) fn read(files: &dyn LeasedFiles, app: &Identifier) -> Result<Self, StoreError> {
        let Some(document) = files.read_json(&path(app))? else {
            return Ok(Self::default());
        };
        let storage = document
            .get("storage")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut kept = Self {
            storage,
            rings: Vec::new(),
        };

        for ring in document
            .get("rings")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Ok(ring) = Ring::deserialize(ring) {
                kept.set_ring(ring);
            }
        }

        Ok(kept)
    }

    /// Replaces what `app`'s file holds with this, whole.
    pub(crate) fn write(
        &self,
        files: &mut dyn LeasedFiles,
        app: &Identifier,
    ) -> Result<(), StoreError> {
        files.write_json(&path(app), &self.document())
    }

    /// Whether this keeps within the JSON limits the store holds a file
    /// to; a value past them is named from `phone`, as the script names
    /// what it keeps.
    pub(crate) fn fits(&self) -> Result<(), BoundJsonError> {
        bound_json(
            self.document(),
            "phone",
            JsonLimits::default(),
            Credentials::Keep,
        )
        .map(drop)
    }

    pub(crate) fn rings(&self) -> &[Ring] {
        &self.rings
    }

    /// Sets `ring`, in place of the ring of its id if there is one.
    pub(crate) fn set_ring(&mut self, ring: Ring) {
        self.rings.retain(|kept| kept.id != ring.id);

        let place = self
            .rings
            .partition_point(|kept| (&kept.at, &kept.id) <= (&ring.at, &ring.id));
        self.rings.insert(place, ring);
    }

    pub(crate) fn cancel_ring(&mut self, id: &str) {
        self.rings.retain(|kept| kept.id != id);
    }

    /// Whether `ring` is still set for its time.
    pub(crate) fn holds(&self, ring: &Ring) -> bool {
        self.rings.iter().any(|kept| kept.is(ring))
    }

    /// Lets `ring` go, unless it was set anew for another time.
    pub(crate) fn let_go(&mut self, ring: &Ring) {
        self.rings.retain(|kept| !kept.is(ring));
    }

    fn document(&self) -> Value {
        json!({"storage": self.storage, "rings": self.rings})
    }
}

fn path(app: &Identifier) -> String {
    format!("apps/{app}.json")
}
