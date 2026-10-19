use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::vocabulary::{AccessLevel, AccessName};

/// The level of each host service a plugin asks for or holds; a service
/// the map leaves out is `none`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Value")]
pub struct AccessMap(BTreeMap<AccessName, AccessLevel>);

/// Why a value is not an [`AccessMap`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AccessMapError {
    #[error("an access map must be an object")]
    NotAnObject,
    #[error("an access map names unknown access \"{name}\"")]
    UnknownAccess { name: String },
    #[error("access \"{name}\" must be \"none\", \"read\" or \"write\"")]
    InvalidLevel { name: AccessName },
}

impl AccessMap {
    /// Reads an authored access map: absent is empty, and every key must
    /// name a service and every value a level.
    ///
    /// # Errors
    ///
    /// [`AccessMapError`] for a value that is not an object, a key that
    /// names no service, or a value that is not a level.
    pub fn from_json(value: Option<&Value>) -> Result<Self, AccessMapError> {
        let Some(value) = value else {
            return Ok(Self::default());
        };
        let Value::Object(entries) = value else {
            return Err(AccessMapError::NotAnObject);
        };

        entries
            .iter()
            .map(|(key, level)| {
                let name = AccessName::parse(key)
                    .ok_or_else(|| AccessMapError::UnknownAccess { name: key.clone() })?;
                let level = level
                    .as_str()
                    .and_then(AccessLevel::parse)
                    .ok_or(AccessMapError::InvalidLevel { name })?;

                Ok((name, level))
            })
            .collect()
    }

    #[must_use]
    pub fn level(&self, name: AccessName) -> AccessLevel {
        self.0.get(&name).copied().unwrap_or(AccessLevel::None)
    }

    #[must_use]
    pub fn grants(&self, name: AccessName, level: AccessLevel) -> bool {
        self.level(name) >= level
    }
}

impl FromIterator<(AccessName, AccessLevel)> for AccessMap {
    fn from_iter<T: IntoIterator<Item = (AccessName, AccessLevel)>>(entries: T) -> Self {
        Self(entries.into_iter().collect())
    }
}

impl TryFrom<Value> for AccessMap {
    type Error = AccessMapError;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        Self::from_json(Some(&value))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn an_access_map_grants_what_it_names_and_nothing_else() {
        let map = AccessMap::from_json(Some(&json!({
            "character_file_store": "write",
            "turn_context": "read",
            "model_input": "none",
        })))
        .unwrap();

        assert!(map.grants(AccessName::CharacterFileStore, AccessLevel::Read));
        assert!(map.grants(AccessName::TurnContext, AccessLevel::Read));
        assert!(!map.grants(AccessName::TurnContext, AccessLevel::Write));
        assert!(!map.grants(AccessName::ModelInput, AccessLevel::Read));
        assert_eq!(map.level(AccessName::PluginDatabase), AccessLevel::None);
        assert_eq!(AccessMap::from_json(None), Ok(AccessMap::default()));
    }

    #[test]
    fn an_access_map_refuses_what_is_not_a_service_and_a_level() {
        for (value, refusal) in [
            (json!(["model_input"]), AccessMapError::NotAnObject),
            (json!(null), AccessMapError::NotAnObject),
            (
                json!({"file_store": "read"}),
                AccessMapError::UnknownAccess {
                    name: "file_store".to_owned(),
                },
            ),
            (
                json!({"model_input": "admin"}),
                AccessMapError::InvalidLevel {
                    name: AccessName::ModelInput,
                },
            ),
        ] {
            assert_eq!(AccessMap::from_json(Some(&value)), Err(refusal), "{value}");
        }
    }
}
