use serde_json::{Map, Value};

use crate::redaction::is_credential_key;

/// How much a JSON value may hold where it comes in from elsewhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JsonLimits {
    /// Levels of nesting below the value itself.
    pub depth: usize,
    /// Items of one array, or entries of one object.
    pub entries_per_container: usize,
    /// Values of every kind, containers and the value itself included.
    pub nodes: usize,
    /// UTF-8 bytes of one string or object key.
    pub string_bytes: usize,
    /// UTF-8 bytes of every string and object key together.
    pub total_string_bytes: usize,
}

impl Default for JsonLimits {
    fn default() -> Self {
        Self {
            depth: 16,
            entries_per_container: 256,
            nodes: 4_096,
            string_bytes: 16 * 1_024,
            total_string_bytes: 64 * 1_024,
        }
    }
}

/// What becomes of the values of credential-named keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Credentials {
    Keep,
    /// Each such value, whatever its kind, becomes `"[redacted]"`, after it
    /// has counted against the limits.
    Redact,
}

/// The first place in document order where a value broke a limit. Each
/// message begins with that place, spelled from the name the caller gave the
/// value: `result.items[2]`, or the name alone for a limit on the whole.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum BoundJsonError {
    #[error("{path} exceeds the JSON depth limit")]
    Depth { path: String },
    #[error("{path} exceeds the JSON container entry limit")]
    Entries { path: String },
    #[error("{path} exceeds the JSON node limit")]
    Nodes { path: String },
    #[error("{path} exceeds the JSON string byte limit")]
    StringBytes { path: String },
    #[error("{path} exceeds the aggregate JSON text limit")]
    TotalStringBytes { path: String },
    #[error("{path} must be a JSON object")]
    NotAnObject { path: String },
}

/// `value`, named `name` in errors, once it is known to keep within
/// `limits`, with the values of credential-named keys redacted if asked.
///
/// # Errors
///
/// [`BoundJsonError`] for the first limit `value` breaks.
pub fn bound_json(
    mut value: Value,
    name: &str,
    limits: JsonLimits,
    credentials: Credentials,
) -> Result<Value, BoundJsonError> {
    Tally {
        name,
        limits,
        nodes: 0,
        string_bytes: 0,
    }
    .visit(&value, name, 0)?;

    if credentials == Credentials::Redact {
        redact_credentials(&mut value);
    }

    Ok(value)
}

/// [`bound_json`] for a value that must be an object.
///
/// # Errors
///
/// [`BoundJsonError`] for the first limit `value` breaks, or
/// [`BoundJsonError::NotAnObject`] when it keeps to them but is not an
/// object.
pub fn bound_json_object(
    value: Value,
    name: &str,
    limits: JsonLimits,
    credentials: Credentials,
) -> Result<Map<String, Value>, BoundJsonError> {
    match bound_json(value, name, limits, credentials)? {
        Value::Object(entries) => Ok(entries),
        _ => Err(BoundJsonError::NotAnObject {
            path: name.to_owned(),
        }),
    }
}

struct Tally<'a> {
    name: &'a str,
    limits: JsonLimits,
    nodes: usize,
    string_bytes: usize,
}

impl Tally<'_> {
    fn visit(&mut self, value: &Value, path: &str, depth: usize) -> Result<(), BoundJsonError> {
        self.nodes += 1;
        if depth > self.limits.depth {
            return Err(BoundJsonError::Depth {
                path: path.to_owned(),
            });
        }
        if self.nodes > self.limits.nodes {
            return Err(BoundJsonError::Nodes {
                path: self.name.to_owned(),
            });
        }

        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
            Value::String(text) => self.count_string(text, || path.to_owned()),
            Value::Array(items) => {
                self.count_entries(items.len(), path)?;
                for (index, item) in items.iter().enumerate() {
                    self.visit(item, &format!("{path}[{index}]"), depth + 1)?;
                }
                Ok(())
            }
            Value::Object(entries) => {
                self.count_entries(entries.len(), path)?;
                for (key, item) in entries {
                    self.count_string(key, || format!("{path} object key"))?;
                    self.visit(item, &format!("{path}.{key}"), depth + 1)?;
                }
                Ok(())
            }
        }
    }

    fn count_entries(&self, entries: usize, path: &str) -> Result<(), BoundJsonError> {
        if entries > self.limits.entries_per_container {
            return Err(BoundJsonError::Entries {
                path: path.to_owned(),
            });
        }

        Ok(())
    }

    fn count_string(
        &mut self,
        text: &str,
        path: impl FnOnce() -> String,
    ) -> Result<(), BoundJsonError> {
        self.string_bytes += text.len();
        if text.len() > self.limits.string_bytes {
            return Err(BoundJsonError::StringBytes { path: path() });
        }
        if self.string_bytes > self.limits.total_string_bytes {
            return Err(BoundJsonError::TotalStringBytes {
                path: self.name.to_owned(),
            });
        }

        Ok(())
    }
}

/// Makes the value of every credential-named key in `value`, however deep,
/// `"[redacted]"`, whatever its kind.
pub fn redact_credentials(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(redact_credentials),
        Value::Object(entries) => {
            for (key, item) in entries.iter_mut() {
                if is_credential_key(key) {
                    *item = Value::from("[redacted]");
                } else {
                    redact_credentials(item);
                }
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn bound(value: Value) -> Result<Value, String> {
        bound_json(value, "result", JsonLimits::default(), Credentials::Keep)
            .map_err(|error| error.to_string())
    }

    fn redacted(value: Value) -> Result<Value, String> {
        bound_json(value, "result", JsonLimits::default(), Credentials::Redact)
            .map_err(|error| error.to_string())
    }

    fn nested(depth: usize) -> Value {
        (0..depth).fold(Value::Null, |inner, _| json!([inner]))
    }

    fn nulls(count: usize) -> Value {
        Value::Array(vec![Value::Null; count])
    }

    #[test]
    fn a_string_is_held_to_its_utf8_bytes_and_the_first_one_over_is_named() {
        let limit = JsonLimits::default().string_bytes;
        let exact = "\u{754c}".repeat(limit / 3);
        let over = format!("{exact}\u{754c}");

        assert_eq!(bound(json!(exact)), Ok(json!(exact)));
        assert_eq!(
            bound(json!({"items": ["fine", over], "later": "x".repeat(limit + 1)})),
            Err("result.items[1] exceeds the JSON string byte limit".to_owned())
        );
    }

    #[test]
    fn a_redacted_credential_counts_against_the_limits_first() {
        let oversized =
            json!({"authorization": "x".repeat(JsonLimits::default().string_bytes + 1)});

        assert_eq!(
            redacted(oversized),
            Err("result.authorization exceeds the JSON string byte limit".to_owned())
        );
    }

    #[test]
    fn strings_together_are_held_to_the_aggregate_limit() {
        let segment = "x".repeat(JsonLimits::default().string_bytes);
        let exact = json!([segment, segment, segment, segment]);

        assert_eq!(bound(exact.clone()), Ok(exact));
        assert_eq!(
            bound(json!([segment, segment, segment, segment, "x"])),
            Err("result exceeds the aggregate JSON text limit".to_owned())
        );
    }

    #[test]
    fn an_object_key_is_a_string_like_any_other() {
        let key = "k".repeat(JsonLimits::default().string_bytes + 1);

        assert_eq!(
            bound(json!({key: true})),
            Err("result object key exceeds the JSON string byte limit".to_owned())
        );
    }

    #[test]
    fn depth_entries_and_nodes_are_accepted_to_the_limit_and_refused_one_past_it() {
        let limits = JsonLimits::default();
        let exact_nodes = Value::Array((0..15).map(|_| nulls(255)).chain([nulls(254)]).collect());
        let over_nodes = Value::Array((0..16).map(|_| nulls(255)).collect());

        assert!(bound(nested(limits.depth)).is_ok());
        assert_eq!(
            bound(nested(limits.depth + 1)),
            Err(format!(
                "result{} exceeds the JSON depth limit",
                "[0]".repeat(limits.depth + 1)
            ))
        );
        assert!(bound(nulls(limits.entries_per_container)).is_ok());
        assert_eq!(
            bound(nulls(limits.entries_per_container + 1)),
            Err("result exceeds the JSON container entry limit".to_owned())
        );
        assert!(bound(exact_nodes).is_ok());
        assert_eq!(
            bound(over_nodes),
            Err("result exceeds the JSON node limit".to_owned())
        );
    }

    #[test]
    fn credential_named_values_are_redacted_at_any_depth_when_asked() {
        let output = json!({
            "api_key": "super-secret",
            "nested": {"password": {"hint": "open-sesame"}, "safe": "kept"},
            "list": [{"access_token": 7, "label": "kept"}],
            "prompt_tokens": 12,
        });

        assert_eq!(
            redacted(output.clone()),
            Ok(json!({
                "api_key": "[redacted]",
                "nested": {"password": "[redacted]", "safe": "kept"},
                "list": [{"access_token": "[redacted]", "label": "kept"}],
                "prompt_tokens": 12,
            }))
        );
        assert_eq!(bound(output.clone()), Ok(output));
    }

    #[test]
    fn an_object_is_required_where_one_is_asked_for() {
        let object = |value| {
            bound_json_object(value, "input", JsonLimits::default(), Credentials::Keep)
                .map(Value::Object)
                .map_err(|error| error.to_string())
        };

        assert_eq!(object(json!({"a": 1})), Ok(json!({"a": 1})));
        assert_eq!(
            object(json!([1])),
            Err("input must be a JSON object".to_owned())
        );
    }
}
