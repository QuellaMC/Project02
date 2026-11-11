//! A phone's world of the test's own: apps written in the tests, the
//! plugin store's files held in memory, and a clock that reads one moment.

use std::collections::BTreeMap;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use jiff::tz::TimeZone;
use p02_contracts::{LeasedFiles, StoreError};
use p02_core::Timestamp;
use p02_phone::{App, Now};
use serde_json::{Map, Value, json};

/// Far past every limit a call runs under.
const WAIT: Duration = Duration::from_secs(60);

/// The files of a plugin store, in memory: each document a value, and how
/// many times one was written.
#[derive(Debug, Default)]
pub(crate) struct Files {
    pub(crate) documents: BTreeMap<String, Value>,
    pub(crate) writes: usize,
}

impl LeasedFiles for Files {
    fn read_json(&self, path: &str) -> Result<Option<Value>, StoreError> {
        Ok(self.documents.get(path).cloned())
    }

    fn read_jsonl(&self, _: &str) -> Result<Vec<Value>, StoreError> {
        unreachable!("the phone keeps no log")
    }

    fn count_jsonl(&self, _: &str) -> Result<u64, StoreError> {
        unreachable!("the phone keeps no log")
    }

    fn write_json(&mut self, path: &str, value: &Value) -> Result<(), StoreError> {
        self.documents.insert(path.to_owned(), value.clone());
        self.writes += 1;
        Ok(())
    }

    fn append_jsonl(&mut self, _: &str, _: &Value) -> Result<(), StoreError> {
        unreachable!("the phone keeps no log")
    }
}

/// Noon in New York on Saturday 7 March 2026, the day before its clocks go
/// forward an hour at 2 AM.
pub(crate) fn now() -> Now {
    at("2026-03-07T17:00:00.000Z")
}

/// `moment` in New York.
pub(crate) fn at(moment: &str) -> Now {
    in_zone(moment, "America/New_York")
}

/// `moment` where the person is in `zone`.
pub(crate) fn in_zone(moment: &str, zone: &str) -> Now {
    Now::new(
        Timestamp::new(moment).unwrap(),
        TimeZone::get(zone).unwrap(),
    )
}

/// `moment` in milliseconds since the epoch.
pub(crate) fn millis(moment: &str) -> i64 {
    Timestamp::new(moment).unwrap().unix_millis()
}

/// The manifest of Notes, which opens on its one view, with `fields` in
/// place of its own and without those `fields` sets to `null`.
pub(crate) fn manifest(fields: &Value) -> String {
    let mut manifest = json!({
        "format": "project02.app.v1",
        "id": "notes",
        "name": "Notes",
        "summary": "What she writes down",
        "icon": "notebook",
        "tint": "orange",
        "views": [{"id": "all", "title": "All", "icon": "doc"}],
        "opensOn": "all",
        "actions": [],
    });

    for (field, value) in fields.as_object().unwrap() {
        if value.is_null() {
            manifest.as_object_mut().unwrap().remove(field);
        } else {
            manifest[field] = value.clone();
        }
    }

    manifest.to_string()
}

/// A view of this `id` and `title`.
pub(crate) fn view(id: &str, title: &str) -> Value {
    json!({"id": id, "title": title, "icon": "doc"})
}

/// Actions of these `names`, each shown on the view `all` and taking any
/// object.
pub(crate) fn actions(names: &[&str]) -> Value {
    names
        .iter()
        .map(|name| {
            json!({
                "name": name,
                "description": "Something to do.",
                "did": format!("Did {name}"),
                "view": "all",
                "input": {"type": "object"},
            })
        })
        .collect()
}

/// The app `script` makes with the manifest of Notes and `fields`.
pub(crate) fn app(fields: &Value, script: &str) -> App {
    App::new(&manifest(fields), script).unwrap()
}

pub(crate) fn input(value: &Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

/// What `work` returns, on a thread of its own: a limit that broke fails
/// the test instead of hanging it.
pub(crate) fn bounded<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    let (sender, receiver) = mpsc::channel();

    thread::spawn(move || sender.send(work()));
    receiver
        .recv_timeout(WAIT)
        .expect("the call stopped within its limits")
}
