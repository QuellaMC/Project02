//! What every reader but a section's owner sees of the settings: secrets,
//! and values under names shaped like a credential's, as `[redacted]`.

use p02_contracts::ConfigField;
use p02_shared::{is_credential_key, redact_credentials};
use serde_json::{Map, Value};

use crate::declaration::{Namespace, Sections};
use crate::host::host_field;

const REDACTED: &str = "[redacted]";

/// What a view shows of field `name`'s value: `[redacted]` for a secret or
/// for a name shaped like a credential's, and otherwise the value with each
/// credential-named value inside it redacted.
pub(crate) fn conceal(name: &str, secret: bool, value: &Value) -> Value {
    if secret || is_credential_key(name) {
        return Value::from(REDACTED);
    }

    let mut shown = value.clone();

    redact_credentials(&mut shown);
    shown
}

/// A document as a fingerprint takes it: every field's value concealed as
/// a view conceals it, so a secret's presence counts and its value never
/// does, and every other key as written.
pub(crate) fn conceal_document(document: &Map<String, Value>, sections: &Sections) -> Value {
    Value::Object(
        document
            .iter()
            .map(|(key, value)| {
                let shown = match (key.as_str(), value) {
                    ("version", _) => value.clone(),
                    ("project02", Value::Object(fields)) => Value::Object(
                        fields
                            .iter()
                            .map(|(name, value)| {
                                let secret = host_field(name)
                                    .is_some_and(|field| field.declaration.secret());

                                (name.clone(), conceal(name, secret, value))
                            })
                            .collect(),
                    ),
                    ("plugins", Value::Object(stanzas)) => {
                        conceal_stanzas(Namespace::Plugins, stanzas, sections)
                    }
                    ("connectors", Value::Object(stanzas)) => {
                        conceal_stanzas(Namespace::Connectors, stanzas, sections)
                    }
                    _ => conceal(key, false, value),
                };

                (key.clone(), shown)
            })
            .collect(),
    )
}

fn conceal_stanzas(
    namespace: Namespace,
    stanzas: &Map<String, Value>,
    sections: &Sections,
) -> Value {
    Value::Object(
        stanzas
            .iter()
            .map(|(id, stanza)| (id.clone(), conceal_stanza(namespace, id, stanza, sections)))
            .collect(),
    )
}

/// One section's stanza as a fingerprint takes it.
pub(crate) fn conceal_stanza(
    namespace: Namespace,
    id: &str,
    stanza: &Value,
    sections: &Sections,
) -> Value {
    let Value::Object(entries) = stanza else {
        return stanza.clone();
    };
    let declared = sections.find(namespace, id);

    Value::Object(
        entries
            .iter()
            .map(|(key, value)| {
                let shown = match (key.as_str(), value) {
                    ("enabled", _) => value.clone(),
                    ("config", Value::Object(fields)) => Value::Object(
                        fields
                            .iter()
                            .map(|(name, value)| {
                                let secret = declared
                                    .and_then(|declared| declared.config().field(name))
                                    .is_some_and(ConfigField::secret);

                                (name.clone(), conceal(name, secret, value))
                            })
                            .collect(),
                    ),
                    _ => conceal(key, false, value),
                };

                (key.clone(), shown)
            })
            .collect(),
    )
}
