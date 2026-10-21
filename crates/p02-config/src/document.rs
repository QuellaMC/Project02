//! A settings document: read from its file, judged, and written back.

use std::collections::BTreeMap;
use std::io;
use std::path::Path;

use p02_shared::{BoundJsonError, Credentials, JsonLimits, bound_json_object, read_at_most};
use serde_json::{Map, Value};

use crate::declaration::{HostField, Namespace, VERSION, host_field, host_fields};
use crate::diagnostic::{Code, Diagnostic};

/// The most a document may weigh on disk, and in all its text together.
const MAX_BYTES: usize = 256 * 1_024;

const TOP_LEVEL: [&str; 4] = ["version", "project02", "plugins", "connectors"];
const STANZA: [&str; 2] = ["enabled", "config"];

/// A document as its file was found.
#[derive(Debug)]
pub(crate) enum Read {
    Absent,
    /// The file is there but holds no document: it cannot be read, is no
    /// JSON object, or is past the limits. Nothing is taken from it, and
    /// nothing is written over it.
    Unreadable(Diagnostic),
    Document(Document),
}

impl Read {
    /// Reads the document at `path`, no more of it than a document may
    /// weigh, a file that is not there being no document at all.
    pub(crate) fn file(path: &Path) -> Self {
        let bytes = match read_at_most(path, MAX_BYTES + 1) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Self::Absent,
            Err(_) => {
                return Self::Unreadable(Diagnostic::error(
                    Code::ReadFailed,
                    format!("Runtime config file could not be read: {}.", path.display()),
                ));
            }
        };

        if bytes.len() > MAX_BYTES {
            return Self::Unreadable(Diagnostic::error(
                Code::LimitExceeded,
                format!("Runtime config file exceeds the {MAX_BYTES}-byte size limit."),
            ));
        }

        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(error) => {
                return Self::Unreadable(Diagnostic::error(
                    Code::MalformedJson,
                    format!("Runtime config file is not valid JSON: {error}."),
                ));
            }
        };
        let limits = JsonLimits {
            total_string_bytes: MAX_BYTES,
            ..JsonLimits::default()
        };

        match bound_json_object(value, "config", limits, Credentials::Keep) {
            Ok(raw) => Self::Document(Document::parse(raw)),
            Err(BoundJsonError::NotAnObject { .. }) => Self::Unreadable(Diagnostic::error(
                Code::NotObject,
                "Runtime config must be an object.",
            )),
            Err(error) => Self::Unreadable(Diagnostic::error(
                Code::LimitExceeded,
                format!("Runtime config exceeds safe JSON limits: {error}."),
            )),
        }
    }

    /// The document read, an absent file being an empty one, or the
    /// diagnostics that keep it from being used.
    pub(crate) fn usable(self) -> Result<Document, Vec<Diagnostic>> {
        match self {
            Self::Absent => Ok(Document::empty()),
            Self::Unreadable(diagnostic) => Err(vec![diagnostic]),
            Self::Document(document) if document.problems.is_empty() => Ok(document),
            Self::Document(document) => Err(document.problems),
        }
    }
}

/// A document that is a JSON object, as authored, beside what of it is
/// valid. A problem of the document as a whole leaves it unusable; a
/// problem of one section's stanza stays with that section.
#[derive(Clone, Debug)]
pub(crate) struct Document {
    raw: Map<String, Value>,
    problems: Vec<Diagnostic>,
    host: Map<String, Value>,
    plugins: BTreeMap<String, Stanza>,
    connectors: BTreeMap<String, Stanza>,
}

/// A section's stanza, `{enabled?, config?}`, as authored, with the
/// problems of its shape.
#[derive(Clone, Debug)]
pub(crate) struct Stanza {
    pub(crate) enabled: Option<bool>,
    pub(crate) config: Option<Map<String, Value>>,
    pub(crate) problems: Vec<Diagnostic>,
}

impl Document {
    /// The document a file that is not there stands for, and the one a
    /// first write starts from.
    pub(crate) fn empty() -> Self {
        let mut raw = Map::new();

        raw.insert("version".to_owned(), Value::from(VERSION));
        Self::parse(raw)
    }

    pub(crate) fn parse(raw: Map<String, Value>) -> Self {
        let mut problems = Vec::new();

        for key in unknown(&raw, &TOP_LEVEL) {
            problems.push(
                Diagnostic::error(
                    Code::UnknownTopLevelField,
                    format!("Unknown runtime config field \"{key}\"."),
                )
                .at(key),
            );
        }

        if raw.get("version").and_then(Value::as_str) != Some(VERSION) {
            problems.push(
                Diagnostic::error(
                    Code::VersionUnsupported,
                    format!("Runtime config version must be \"{VERSION}\"."),
                )
                .at("version"),
            );
        }

        let host = match raw.get("project02") {
            None => Map::new(),
            Some(Value::Object(fields)) => host_values(fields, &mut problems),
            Some(_) => {
                problems.push(
                    Diagnostic::error(
                        Code::Project02NotObject,
                        "Runtime config project02 section must be an object.",
                    )
                    .at("project02"),
                );
                Map::new()
            }
        };
        let plugins = stanzas(Namespace::Plugins, raw.get("plugins"), &mut problems);
        let connectors = stanzas(Namespace::Connectors, raw.get("connectors"), &mut problems);

        Self {
            raw,
            problems,
            host,
            plugins,
            connectors,
        }
    }

    pub(crate) fn raw(&self) -> &Map<String, Value> {
        &self.raw
    }

    pub(crate) fn problems(&self) -> &[Diagnostic] {
        &self.problems
    }

    /// The value the document gives host field `name`, when it is one the
    /// field takes.
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

fn host_values(fields: &Map<String, Value>, problems: &mut Vec<Diagnostic>) -> Map<String, Value> {
    let known: Vec<&str> = host_fields().iter().map(HostField::name).collect();

    for key in unknown(fields, &known) {
        problems.push(
            Diagnostic::error(
                Code::UnknownProject02Field,
                format!("Unknown Project02 config field \"{key}\"."),
            )
            .at(format!("project02.{key}")),
        );
    }

    let mut values = Map::new();

    for (name, value) in fields {
        let Some(field) = host_field(name) else {
            continue;
        };

        if field.accepts(value) {
            values.insert(name.clone(), value.clone());
        } else {
            problems.push(Diagnostic::error(field.code, field.sentence.clone()).at(field.path()));
        }
    }

    values
}

fn stanzas(
    namespace: Namespace,
    value: Option<&Value>,
    problems: &mut Vec<Diagnostic>,
) -> BTreeMap<String, Stanza> {
    match value {
        None => BTreeMap::new(),
        Some(Value::Object(entries)) => entries
            .iter()
            .map(|(id, value)| (id.clone(), Stanza::parse(namespace, id, value)))
            .collect(),
        Some(_) => {
            let code = match namespace {
                Namespace::Plugins => Code::PluginsNotObject,
                Namespace::Connectors => Code::ConnectorsNotObject,
            };

            problems.push(
                Diagnostic::error(
                    code,
                    format!("Runtime config {} must be an object.", namespace.as_str()),
                )
                .at(namespace.as_str()),
            );
            BTreeMap::new()
        }
    }
}

impl Stanza {
    fn parse(namespace: Namespace, id: &str, value: &Value) -> Self {
        let path = format!("{}.{id}", namespace.as_str());
        let problem = |code, message: String, at: String| {
            Diagnostic::error(code, message)
                .at(at)
                .in_section(namespace, id)
        };
        let Value::Object(entries) = value else {
            return Self {
                enabled: None,
                config: None,
                problems: vec![problem(
                    Code::PluginNotObject,
                    format!("{path} must be an object."),
                    path.clone(),
                )],
            };
        };
        let mut problems: Vec<Diagnostic> = unknown(entries, &STANZA)
            .map(|key| {
                problem(
                    Code::UnknownPluginWrapperField,
                    format!(
                        "{path} has unknown field \"{key}\": a section holds only enabled and \
                         config."
                    ),
                    format!("{path}.{key}"),
                )
            })
            .collect();
        let enabled = match entries.get("enabled") {
            None => None,
            Some(Value::Bool(enabled)) => Some(*enabled),
            Some(_) => {
                problems.push(problem(
                    Code::BooleanInvalid,
                    format!("{path}.enabled must be a boolean."),
                    format!("{path}.enabled"),
                ));
                None
            }
        };
        let config = match entries.get("config") {
            None => None,
            Some(Value::Object(config)) => Some(config.clone()),
            Some(_) => {
                problems.push(problem(
                    Code::PluginConfigNotObject,
                    format!("{path}.config must be an object."),
                    format!("{path}.config"),
                ));
                None
            }
        };

        Self {
            enabled,
            config,
            problems,
        }
    }
}

/// The keys of `object` outside `known`, in code-point order.
fn unknown<'a>(object: &'a Map<String, Value>, known: &[&str]) -> impl Iterator<Item = &'a String> {
    let mut keys: Vec<&String> = object
        .keys()
        .filter(|key| !known.contains(&key.as_str()))
        .collect();

    keys.sort();
    keys.into_iter()
}
