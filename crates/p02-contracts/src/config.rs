use std::collections::BTreeMap;
use std::fmt;

use p02_shared::Identifier;
use p02_wire::{ConfigValueType, LayoutCard};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::label::RedactionLabel;
use crate::vocabulary::ConfigScope;

/// A plugin's section of the config document, `plugins.<id>`: where it may
/// be set, the fields it declares, and the cards a page draws them in.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSection {
    pub(crate) scope: ConfigScope,
    pub(crate) fields: Vec<ConfigField>,
    pub(crate) layout: Vec<LayoutCard>,
}

/// One declared config field. The same declaration drives resolution, the
/// settings page and the model's config tools.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigField {
    pub(crate) name: Identifier,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) label: Option<String>,
    pub(crate) description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) placeholder: Option<String>,
    pub(crate) secret: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) scope: Option<ConfigScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) value_type: Option<ConfigValueType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) default_value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) allowed_values: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) suggested_values: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) choices: Option<BTreeMap<String, String>>,
    pub(crate) agent_mutable: bool,
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

    /// The cards a page draws the fields in, as declared and then one card
    /// more, untitled, of every field no row places: each field is in one
    /// card at least, and a section without fields has none.
    #[must_use]
    pub fn layout(&self) -> &[LayoutCard] {
        &self.layout
    }
}

impl ConfigField {
    #[must_use]
    pub fn name(&self) -> &Identifier {
        &self.name
    }

    /// What a page calls the field.
    #[must_use]
    pub fn label(&self) -> Option<&str> {
        self.label.as_deref()
    }

    #[must_use]
    pub fn description(&self) -> &str {
        &self.description
    }

    /// What an empty box shows.
    #[must_use]
    pub fn placeholder(&self) -> Option<&str> {
        self.placeholder.as_deref()
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

    /// The values a page offers first, on a field that takes any other of
    /// its type too.
    #[must_use]
    pub fn suggested_values(&self) -> Option<&[String]> {
        self.suggested_values.as_deref()
    }

    /// The words for each allowed or suggested value, when the field has
    /// them: every one of those values has its words, and nothing else
    /// does.
    #[must_use]
    pub fn choices(&self) -> Option<&BTreeMap<String, String>> {
        self.choices.as_ref()
    }

    /// Whether the model may propose a change, which the person approves.
    #[must_use]
    pub fn agent_mutable(&self) -> bool {
        self.agent_mutable
    }

    #[must_use]
    pub fn redaction_labels(&self) -> &[RedactionLabel] {
        &self.redaction_labels
    }

    /// Whether `value` is one this field holds: of its value type, one of
    /// its allowed values when it lists them, and, for a secret, a string
    /// that is not blank, since removing a credential is unsetting it. A
    /// manifest's default and every authored value meet this one judge.
    #[must_use]
    pub fn accepts(&self, value: &Value) -> bool {
        if self.secret && value.as_str().is_none_or(|text| text.trim().is_empty()) {
            return false;
        }

        if let Some(allowed) = &self.allowed_values
            && !value
                .as_str()
                .is_some_and(|text| allowed.iter().any(|item| item == text))
        {
            return false;
        }

        self.of_its_type(value)
    }

    /// Whether `value` is of this field's value type, whatever else it
    /// must be.
    pub(crate) fn of_its_type(&self, value: &Value) -> bool {
        match self.value_type {
            None => true,
            Some(
                ConfigValueType::String
                | ConfigValueType::Path
                | ConfigValueType::Url
                | ConfigValueType::Enum,
            ) => value.is_string(),
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
#[derive(Clone, PartialEq)]
pub struct ResolvedConfig(BTreeMap<String, Value>);

impl ResolvedConfig {
    /// What `section` resolves to from `authored`, the values the settings
    /// set by field name. A name the section does not declare reaches no
    /// plugin.
    #[must_use]
    pub fn resolve(section: &ConfigSection, authored: &Map<String, Value>) -> Self {
        Self(
            section
                .fields()
                .iter()
                .filter_map(|field| {
                    authored
                        .get(field.name().as_str())
                        .filter(|value| field.accepts(value))
                        .or_else(|| field.default_value())
                        .map(|value| (field.name().as_str().to_owned(), value.clone()))
                })
                .collect(),
        )
    }

    #[must_use]
    pub fn value(&self, field: &str) -> Option<&Value> {
        self.0.get(field)
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
    use crate::manifest::ManifestError;

    fn field(value_type: Option<ConfigValueType>, allowed: Option<&[&str]>) -> ConfigField {
        ConfigField {
            name: Identifier::new("tone").unwrap(),
            label: None,
            description: "Reply tone.".to_owned(),
            placeholder: None,
            secret: false,
            scope: None,
            value_type,
            default_value: None,
            allowed_values: allowed.map(|values| values.iter().map(|&v| v.to_owned()).collect()),
            suggested_values: None,
            choices: None,
            agent_mutable: false,
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
    fn a_secret_accepts_only_a_string_that_is_not_blank() {
        let mut key = field(None, None);

        key.secret = true;

        assert!(key.accepts(&json!("  sk-as typed  ")));

        for refused in [
            json!(""),
            json!("   "),
            json!(42),
            json!({"$env": "API_KEY"}),
        ] {
            assert!(!key.accepts(&refused), "{refused}");
        }
    }

    #[test]
    fn a_section_declared_in_code_meets_the_rules_of_a_manifest() {
        let declared = ConfigSection::from_value(&json!({
            "scope": "global_with_character_overrides",
            "fields": [{
                "name": "botToken",
                "description": "A bot.",
                "secret": true,
                "scope": "character_only",
                "valueType": "string",
                "redactionLabels": ["secret"],
            }],
        }))
        .unwrap();

        assert_eq!(
            declared.field("botToken").and_then(ConfigField::scope),
            Some(ConfigScope::CharacterOnly)
        );
        assert!(matches!(
            ConfigSection::from_value(&json!({
                "scope": "character_only",
                "fields": [{
                    "name": "botToken",
                    "description": "A bot.",
                    "secret": true,
                    "scope": "global_only",
                    "redactionLabels": [],
                }],
            })),
            Err(ManifestError::FieldScopeWidens { .. })
        ));
    }

    #[test]
    fn a_config_resolves_each_field_to_a_value_it_accepts_or_its_default() {
        let mut tone = field(Some(ConfigValueType::String), Some(&["warm", "formal"]));
        let mut key = field(Some(ConfigValueType::String), None);

        tone.default_value = Some(json!("warm"));
        key.name = Identifier::new("apiKey").unwrap();
        key.secret = true;

        let section = ConfigSection {
            scope: ConfigScope::GlobalWithCharacterOverrides,
            fields: vec![tone, key],
            layout: Vec::new(),
        };
        let authored = |values: Value| values.as_object().cloned().unwrap();
        let config = ResolvedConfig::resolve(
            &section,
            &authored(json!({"tone": "sarcastic", "apiKey": "m0sk_secret", "baseUrl": "x"})),
        );

        assert_eq!(config.value("tone"), Some(&json!("warm")));
        assert_eq!(config.value("apiKey"), Some(&json!("m0sk_secret")));
        assert_eq!(config.value("baseUrl"), None);
        assert_eq!(
            format!("{config:?}"),
            r#"ResolvedConfig(["apiKey", "tone"])"#
        );
    }
}
