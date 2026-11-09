use std::borrow::Cow;
use std::fmt;
use std::sync::Arc;

use jsonschema::ValidationError;
use jsonschema::error::ValidationErrorKind;
use jsonschema::paths::{Location, LocationSegment};
use p02_shared::{
    BoundJsonError, Credentials, Identifier, JsonLimits, bound_json, bound_json_object,
};
use serde_json::{Map, Value};

/// What a tool takes, as one self-contained JSON Schema document (draft 7)
/// whose root is an object: the one declaration a provider is shown and a
/// proposed call is judged by, compiled when it is made.
#[derive(Clone)]
pub struct ToolInputContract {
    schema: Map<String, Value>,
    validator: Arc<jsonschema::Validator>,
}

/// Why a tool input contract was refused.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum InputContractError {
    #[error("a tool inputContract must be a JSON Schema object")]
    NotAnObject,
    #[error("a tool inputContract must declare root type \"object\"")]
    RootNotObject,
    #[error("a tool inputContract is past the JSON limits")]
    TooLarge(#[source] BoundJsonError),
    #[error("invalid JSON Schema: {0}")]
    Invalid(String),
}

impl ToolInputContract {
    /// Admits a contract and compiles it.
    ///
    /// # Errors
    ///
    /// [`InputContractError`] when the schema is not an object of root type
    /// `object` within the JSON limits, or is no draft 7 schema.
    pub fn new(schema: Value) -> Result<Self, InputContractError> {
        let schema = bound_json_object(
            schema,
            "tool inputContract",
            JsonLimits::default(),
            Credentials::Keep,
        )
        .map_err(|error| match error {
            BoundJsonError::NotAnObject { .. } => InputContractError::NotAnObject,
            other => InputContractError::TooLarge(other),
        })?;

        if schema.get("type").and_then(Value::as_str) != Some("object") {
            return Err(InputContractError::RootNotObject);
        }

        let validator = Arc::new(compile(&schema)?);

        Ok(Self { schema, validator })
    }

    #[must_use]
    pub fn schema(&self) -> &Map<String, Value> {
        &self.schema
    }

    /// Judges a proposed input against the contract.
    ///
    /// # Errors
    ///
    /// [`ToolInputRejection`] naming the field and the rule it breaks,
    /// which the model is told.
    pub fn validate(
        &self,
        tool: &Identifier,
        input: &Map<String, Value>,
    ) -> Result<(), ToolInputRejection> {
        let rejection = |problem| ToolInputRejection {
            tool: tool.clone(),
            problem,
        };
        let instance = bound_json(
            Value::Object(input.clone()),
            &format!("Model tool \"{tool}\" input"),
            JsonLimits::default(),
            Credentials::Keep,
        )
        .map_err(|error| rejection(InputProblem::Bounds(error)))?;

        match first_problem(&self.validator, &instance) {
            Some(problem) => Err(rejection(problem)),
            None => Ok(()),
        }
    }
}

fn compile(schema: &Map<String, Value>) -> Result<jsonschema::Validator, InputContractError> {
    let schema = Value::Object(schema.clone());

    jsonschema::draft7::meta::validate(&schema)
        .map_err(|error| InputContractError::Invalid(error.to_string()))?;
    jsonschema::draft7::new(&schema).map_err(|error| InputContractError::Invalid(error.to_string()))
}

/// The problem the model is told of: a missing field first, then every
/// field the contract does not allow, then the first other failure.
fn first_problem(validator: &jsonschema::Validator, instance: &Value) -> Option<InputProblem> {
    let errors: Vec<ValidationError<'_>> = validator.iter_errors(instance).collect();

    if let Some((error, property)) = errors.iter().find_map(|error| match error.kind() {
        ValidationErrorKind::Required { property } => Some((error, property)),
        _ => None,
    }) {
        return Some(InputProblem::Missing {
            path: field_path(error.instance_path(), property.as_str()),
        });
    }

    let unsupported: Vec<String> = errors
        .iter()
        .flat_map(|error| unsupported_fields(error, instance))
        .collect();

    if !unsupported.is_empty() {
        return Some(InputProblem::Unsupported { paths: unsupported });
    }

    let first = errors.first()?;

    Some(InputProblem::Field {
        path: field_path(first.instance_path(), None),
        rule: first.masked_with("its value").to_string(),
    })
}

/// The fields an `additionalProperties` failure names: every key of an
/// object whose schema allows none, or the keys the failure lists.
fn unsupported_fields(error: &ValidationError<'_>, instance: &Value) -> Vec<String> {
    let at = error.instance_path();

    match error.kind() {
        ValidationErrorKind::AdditionalProperties { unexpected } => unexpected
            .iter()
            .map(|key| field_path(at, Some(key)))
            .collect(),
        ValidationErrorKind::FalseSchema
            if error
                .schema_path()
                .as_str()
                .ends_with("/additionalProperties") =>
        {
            instance
                .pointer(at.as_str())
                .and_then(Value::as_object)
                .map(|object| object.keys().map(|key| field_path(at, Some(key))).collect())
                .unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

/// `operations[0].text`, from where in the input a failure is and the key
/// it names in the object there, if any; the input itself is `$`.
fn field_path(at: &Location, key: Option<&str>) -> String {
    let mut path = String::new();
    let key = key.map(|key| LocationSegment::Property(Cow::Borrowed(key)));

    for segment in at.segments().chain(key) {
        match segment {
            LocationSegment::Index(index) => {
                path.push('[');
                path.push_str(&index.to_string());
                path.push(']');
            }
            LocationSegment::Property(key) if path.is_empty() => path.push_str(&key),
            LocationSegment::Property(key) => {
                path.push('.');
                path.push_str(&key);
            }
        }
    }

    if path.is_empty() {
        "$".to_owned()
    } else {
        path
    }
}

impl PartialEq for ToolInputContract {
    fn eq(&self, other: &Self) -> bool {
        self.schema == other.schema
    }
}

impl fmt::Debug for ToolInputContract {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ToolInputContract")
            .field(&self.schema)
            .finish()
    }
}

/// Why a proposed tool input was refused, naming the field and the rule.
/// The model is told [`ToolInputRejection::sentence`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolInputRejection {
    tool: Identifier,
    problem: InputProblem,
}

impl std::error::Error for ToolInputRejection {}

impl fmt::Display for ToolInputRejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.problem {
            InputProblem::Bounds(error) => write!(formatter, "{error}"),
            problem => write!(formatter, "{} input {problem}", self.tool),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum InputProblem {
    Bounds(BoundJsonError),
    Missing { path: String },
    Unsupported { paths: Vec<String> },
    Field { path: String, rule: String },
}

impl fmt::Display for InputProblem {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Bounds(error) => write!(formatter, "{error}"),
            Self::Missing { path } => write!(formatter, "missing required field \"{path}\""),
            Self::Unsupported { paths } => {
                write!(
                    formatter,
                    "includes unsupported fields: {}",
                    paths.join(", ")
                )
            }
            Self::Field { path, rule } => write!(formatter, "field \"{path}\" is refused: {rule}"),
        }
    }
}

impl ToolInputRejection {
    /// What the model reads: `memory.update input missing required field
    /// "operations".`
    #[must_use]
    pub fn sentence(&self) -> String {
        format!("{self}.")
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn input(value: &Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn a_contract_judges_an_input_by_the_field_and_the_rule_it_breaks() {
        let schema = json!({
            "type": "object",
            "properties": {
                "mood": {"type": "string", "enum": ["calm", "warm"]},
                "note": {"type": "string", "minLength": 1},
            },
            "required": ["mood"],
            "additionalProperties": false,
        });
        let contract = ToolInputContract::new(schema).unwrap();
        let tool = Identifier::new("state.patch").unwrap();
        let refused = |value: Value| {
            contract
                .validate(&tool, &input(&value))
                .unwrap_err()
                .sentence()
        };

        assert_eq!(
            contract.validate(&tool, &input(&json!({"mood": "calm"}))),
            Ok(())
        );
        assert_eq!(
            refused(json!({})),
            r#"state.patch input missing required field "mood"."#
        );
        assert_eq!(
            refused(json!({"mood": "calm", "pitch": 1})),
            "state.patch input includes unsupported fields: pitch."
        );
        assert!(
            refused(json!({"mood": "angry"}))
                .starts_with(r#"state.patch input field "mood" is refused: "#)
        );
    }

    #[test]
    fn a_contract_is_an_object_schema_draft_7_compiles() {
        assert_eq!(
            ToolInputContract::new(json!([])).unwrap_err(),
            InputContractError::NotAnObject
        );
        assert_eq!(
            ToolInputContract::new(json!({"type": ["object"]})).unwrap_err(),
            InputContractError::RootNotObject
        );
        assert!(matches!(
            ToolInputContract::new(json!({
                "type": "object",
                "properties": {"note": {"type": "string", "pattern": "("}},
            })),
            Err(InputContractError::Invalid(_))
        ));
        assert!(matches!(
            ToolInputContract::new(json!({
                "type": "object",
                "properties": {"next": {"$ref": "https://example.test/tree"}},
            })),
            Err(InputContractError::Invalid(_))
        ));
    }
}
