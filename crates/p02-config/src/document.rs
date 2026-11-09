//! A settings document: read from its file forgivingly, and written back.

use std::collections::BTreeMap;
use std::fmt::Display;
use std::io;
use std::path::Path;

use p02_shared::read_file;
use serde_json::{Map, Value};

use crate::declaration::{HostField, Namespace, VERSION, host_fields};
use crate::diagnostic::{Code, Diagnostic};

const TOP_LEVEL: [&str; 4] = ["version", "project02", "plugins", "connectors"];
const STANZA: [&str; 2] = ["enabled", "config"];

/// A document as its file was found.
#[derive(Debug)]
pub(crate) enum Read {
    Absent,
    /// The file is there but holds no document: it cannot be read, is not
    /// JSON, or is no object. Nothing is taken from it, and nothing is
    /// written over it.
    Unreadable(Diagnostic),
    Document(Document),
}

impl Read {
    /// Reads the document at `path`, a file that is not there being no
    /// document at all.
    pub(crate) fn file(path: &Path) -> Self {
        let bytes = match read_file(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Self::Absent,
            Err(_) => return unreadable(path, "could not be read"),
        };

        match serde_json::from_slice(&bytes) {
            Ok(Value::Object(raw)) => Self::Document(Document::parse(raw)),
            Ok(_) => unreadable(path, "is not a JSON object"),
            Err(error) => unreadable(path, format_args!("is not valid JSON ({error})")),
        }
    }

    /// The document read, an absent file being an empty one, or what keeps
    /// it from being read.
    pub(crate) fn usable(self) -> Result<Document, Box<Diagnostic>> {
        match self {
            Self::Absent => Ok(Document::empty()),
            Self::Unreadable(diagnostic) => Err(Box::new(diagnostic)),
            Self::Document(document) => Ok(document),
        }
    }
}

fn unreadable(path: &Path, why: impl Display) -> Read {
    Read::Unreadable(Diagnostic::error(
        Code::Unreadable,
        format!(
            "The settings file {} {why}: fix it or remove it.",
            path.display()
        ),
    ))
}

/// A document that is a JSON object, as authored, beside what of it is
/// used: the host's fields and each section's stanza, by id. What it holds
/// that the settings do not know is not used, and said.
#[derive(Clone, Debug)]
pub(crate) struct Document {
    raw: Map<String, Value>,
    ignored: Vec<Diagnostic>,
    host: Map<String, Value>,
    plugins: BTreeMap<String, Stanza>,
    connectors: BTreeMap<String, Stanza>,
}

/// A section's stanza, `{enabled?, config?}`, as authored, with what is
/// wrong with its shape: a key it does not know, a warning, and a stanza or
/// config that is no object, an error of the section.
#[derive(Clone, Debug)]
pub(crate) struct Stanza {
    /// The switch as authored, whatever it holds: one that is not a
    /// boolean is still a switch, refused, and judged where it is the
    /// nearest, as a field's value is.
    pub(crate) enabled: Option<Value>,
    pub(crate) config: Option<Map<String, Value>>,
    pub(crate) findings: Vec<Diagnostic>,
}

impl Document {
    /// The document a file that is not there stands for, and the one a
    /// first write starts from.
    pub(crate) fn empty() -> Self {
        let mut raw = Map::new();

        raw.insert("version".to_owned(), Value::from(VERSION));
        Self::parse(raw)
    }

    /// `raw`, every part the settings know taken as authored. Its version
    /// is not judged: a home a newer build wrote is refused by its marker.
    pub(crate) fn parse(raw: Map<String, Value>) -> Self {
        let mut ignored: Vec<Diagnostic> = unknown(&raw, &TOP_LEVEL)
            .map(|key| ignored_key(key, key.clone()))
            .collect();
        let host = match raw.get("project02") {
            None => Map::new(),
            Some(Value::Object(fields)) => host_values(fields, &mut ignored),
            Some(_) => {
                ignored.push(not_an_object("project02"));
                Map::new()
            }
        };
        let plugins = stanzas(Namespace::Plugins, raw.get("plugins"), &mut ignored);
        let connectors = stanzas(Namespace::Connectors, raw.get("connectors"), &mut ignored);

        Self {
            raw,
            ignored,
            host,
            plugins,
            connectors,
        }
    }

    pub(crate) fn raw(&self) -> &Map<String, Value> {
        &self.raw
    }

    /// What of the document is not used, outside any section.
    pub(crate) fn ignored(&self) -> &[Diagnostic] {
        &self.ignored
    }

    /// The value the document gives host field `name`, whatever it is.
    pub(crate) fn host_value(&self, name: &str) -> Option<&Value> {
        self.host.get(name)
    }

    pub(crate) fn stanzas(&self, namespace: Namespace) -> &BTreeMap<String, Stanza> {
        match namespace {
            Namespace::Plugins => &self.plugins,
            Namespace::Connectors => &self.connectors,
        }
    }

    pub(crate) fn stanza(&self, namespace: Namespace, id: &str) -> Option<&Stanza> {
        self.stanzas(namespace).get(id)
    }
}

/// `document` as its file holds it: indented by two spaces, with a
/// trailing newline, so a person can read and edit it.
pub(crate) fn encode(document: &Map<String, Value>) -> Vec<u8> {
    // An object of JSON values has nothing serde_json could refuse.
    let mut bytes = serde_json::to_vec_pretty(document).expect("a JSON object always serializes");

    bytes.push(b'\n');
    bytes
}

/// The warning for a key at `path` the settings do not know.
pub(crate) fn ignored_key(name: &str, path: String) -> Diagnostic {
    Diagnostic::warning(
        Code::Ignored,
        format!("\"{name}\" is not a setting, so it is not used."),
    )
    .at(path)
}

fn not_an_object(path: &str) -> Diagnostic {
    Diagnostic::warning(
        Code::Ignored,
        format!("{path} must be an object, so nothing in it is used."),
    )
    .at(path)
}

fn host_values(fields: &Map<String, Value>, ignored: &mut Vec<Diagnostic>) -> Map<String, Value> {
    let known: Vec<&str> = host_fields().iter().map(HostField::name).collect();

    ignored.extend(unknown(fields, &known).map(|key| ignored_key(key, format!("project02.{key}"))));
    fields
        .iter()
        .filter(|(name, _)| known.contains(&name.as_str()))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

fn stanzas(
    namespace: Namespace,
    value: Option<&Value>,
    ignored: &mut Vec<Diagnostic>,
) -> BTreeMap<String, Stanza> {
    match value {
        None => BTreeMap::new(),
        Some(Value::Object(entries)) => entries
            .iter()
            .map(|(id, value)| (id.clone(), Stanza::parse(namespace, id, value)))
            .collect(),
        Some(_) => {
            ignored.push(not_an_object(namespace.as_str()));
            BTreeMap::new()
        }
    }
}

impl Stanza {
    fn parse(namespace: Namespace, id: &str, value: &Value) -> Self {
        let path = format!("{}.{id}", namespace.as_str());
        let refused = |at: String| {
            Diagnostic::error(Code::ValueInvalid, format!("{at} must be an object."))
                .at(at)
                .in_section(namespace, id)
        };
        let Value::Object(entries) = value else {
            return Self {
                enabled: None,
                config: None,
                findings: vec![refused(path)],
            };
        };
        let mut findings: Vec<Diagnostic> = unknown(entries, &STANZA)
            .map(|key| ignored_key(key, format!("{path}.{key}")).in_section(namespace, id))
            .collect();
        let config = match entries.get("config") {
            None => None,
            Some(Value::Object(config)) => Some(config.clone()),
            Some(_) => {
                findings.push(refused(format!("{path}.config")));
                None
            }
        };

        Self {
            enabled: entries.get("enabled").cloned(),
            config,
            findings,
        }
    }
}

/// The keys of `object` outside `known`, in code-point order.
pub(crate) fn unknown<'a>(
    object: &'a Map<String, Value>,
    known: &[&str],
) -> impl Iterator<Item = &'a String> {
    let mut keys: Vec<&String> = object
        .keys()
        .filter(|key| !known.contains(&key.as_str()))
        .collect();

    keys.sort();
    keys.into_iter()
}
