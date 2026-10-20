use std::collections::BTreeMap;
use std::fmt;

use p02_shared::Identifier;
use serde::Serialize;
use serde_json::Value;

use crate::label::RedactionLabel;
use crate::vocabulary::{ConfigScope, ConfigValueType};

/// A plugin's section of the config document, `plugins.<id>`: where it may
/// be set, and the fields it declares in the order they are shown.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSection {
    pub(crate) scope: ConfigScope,
    pub(crate) fields: Vec<ConfigField>,
}

/// One declared config field. The same declaration drives resolution, the
/// settings page and the model's config tools.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[expect(
    clippy::struct_excessive_bools,
    reason = "each flag is one authored key of the declaration"
)]
pub struct ConfigField {
    pub(crate) name: Identifier,
    pub(crate) description: String,
    pub(crate) required: bool,
    pub(crate) secret: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) scope: Option<ConfigScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) value_type: Option<ConfigValueType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) default_value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) allowed_values: Option<Vec<String>>,
    pub(crate) agent_mutable: bool,
    pub(crate) reload_required: bool,
    pub(crate) redaction_labels: Vec<RedactionLabel>,
}

impl ConfigSection {
    #[must_use]
    pub fn scope(&self) -> ConfigScope {
        self.scope
    }

    #[must_use]
    pub fn fields(&self) -> &[ConfigField] {
        &self.fields
    }

    #[must_use]
    pub fn field(&self, name: &str) -> Option<&ConfigField> {
        self.fields.iter().find(|field| field.name.as_str() == name)
    }
}

impl ConfigField {
    #[must_use]
    pub fn name(&self) -> &Identifier {
        &self.name
    }

    #[must_use]
    pub fn description(&self) -> &str {
        &self.description
    }

    /// Whether the operator must set it before the plugin can run.
    #[must_use]
    pub fn required(&self) -> bool {
        self.required
    }

    /// Whether it holds a credential: read redacted everywhere but by its
    /// own plugin, and never the model's to change.
    #[must_use]
    pub fn secret(&self) -> bool {
        self.secret
    }

    /// The field's own scope, which may only narrow its section's; absent,
    /// it takes the section's.
    #[must_use]
    pub fn scope(&self) -> Option<ConfigScope> {
        self.scope
    }

    #[must_use]
    pub fn value_type(&self) -> Option<ConfigValueType> {
        self.value_type
    }

    /// What the field takes wherever no settings set it.
    #[must_use]
    pub fn default_value(&self) -> Option<&Value> {
        self.default_value.as_ref()
    }

    #[must_use]
    pub fn allowed_values(&self) -> Option<&[String]> {
        self.allowed_values.as_deref()
    }

    /// Whether the model may propose a change, which the person approves.
    #[must_use]
    pub fn agent_mutable(&self) -> bool {
        self.agent_mutable
    }

    /// Whether an approved change waits for the next launch rather than
    /// rebuilding the plugin at once; only an authored `false` applies live.
    #[must_use]
    pub fn reload_required(&self) -> bool {
        self.reload_required
    }

    #[must_use]
    pub fn redaction_labels(&self) -> &[RedactionLabel] {
        &self.redaction_labels
    }

    /// Whether `value` is one this field holds: of its value type, and one
    /// of its allowed values when it lists them. A manifest's default and
    /// every authored value meet this one judge.
    #[must_use]
    pub fn accepts(&self, value: &Value) -> bool {
        if let Some(allowed) = &self.allowed_values
            && !value
                .as_str()
                .is_some_and(|text| allowed.iter().any(|item| item == text))
        {
            return false;
        }

        match self.value_type {
            None => true,
            Some(ConfigValueType::String | ConfigValueType::Path | ConfigValueType::Enum) => {
                value.is_string()
            }
            Some(ConfigValueType::Number) => value.is_number(),
            Some(ConfigValueType::Boolean) => value.is_boolean(),
            Some(ConfigValueType::Object) => value.is_object(),
            Some(ConfigValueType::Array) => value.is_array(),
        }
    }
}

/// The values a plugin's config resolved to, by field name: an authored
/// value its field accepts, or the field's default. A field with neither is
/// absent.
#[derive(Clone, Default, PartialEq)]
pub struct ResolvedConfig(BTreeMap<String, Value>);

impl ResolvedConfig {
    #[must_use]
    pub fn value(&self, field: &str) -> Option<&Value> {
        self.0.get(field)
    }
}

impl FromIterator<(Identifier, Value)> for ResolvedConfig {
    fn from_iter<T: IntoIterator<Item = (Identifier, Value)>>(values: T) -> Self {
        Self(
            values
                .into_iter()
                .map(|(name, value)| (name.as_str().to_owned(), value))
                .collect(),
        )
    }
}

/// Names the fields only: the values include the plugin's secrets.
impl fmt::Debug for ResolvedConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ResolvedConfig")
            .field(&self.0.keys().collect::<Vec<_>>())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn field(value_type: Option<ConfigValueType>, allowed: Option<&[&str]>) -> ConfigField {
        ConfigField {
            name: Identifier::new("tone").unwrap(),
            description: "Reply tone.".to_owned(),
            required: false,
            secret: false,
            scope: None,
            value_type,
            default_value: None,
            allowed_values: allowed.map(|values| values.iter().map(|&v| v.to_owned()).collect()),
            agent_mutable: false,
            reload_required: true,
            redaction_labels: Vec::new(),
        }
    }

    #[test]
    fn a_field_accepts_values_of_its_type_and_among_its_allowed_values() {
        let cases = [
            (field(None, None), json!({"any": "thing"}), true),
            (
                field(Some(ConfigValueType::String), None),
                json!("warm"),
                true,
            ),
            (field(Some(ConfigValueType::String), None), json!(1), false),
            (field(Some(ConfigValueType::Number), None), json!(1.5), true),
            (
                field(Some(ConfigValueType::Boolean), None),
                json!("true"),
                false,
            ),
            (field(Some(ConfigValueType::Object), None), json!([]), false),
            (field(Some(ConfigValueType::Array), None), json!([]), true),
            (
                field(Some(ConfigValueType::String), Some(&["warm", "formal"])),
                json!("formal"),
                true,
            ),
            (
                field(Some(ConfigValueType::String), Some(&["warm", "formal"])),
                json!("sarcastic"),
                false,
            ),
        ];

        for (field, value, accepted) in cases {
            assert_eq!(
                field.accepts(&value),
                accepted,
                "{:?} {value}",
                field.value_type
            );
        }
    }

    #[test]
    fn a_resolved_config_hands_out_values_and_never_debugs_them() {
        let config: ResolvedConfig = [(Identifier::new("apiKey").unwrap(), json!("m0sk_secret"))]
            .into_iter()
            .collect();

        assert_eq!(config.value("apiKey"), Some(&json!("m0sk_secret")));
        assert_eq!(config.value("baseUrl"), None);
        assert_eq!(format!("{config:?}"), r#"ResolvedConfig(["apiKey"])"#);
    }
}
