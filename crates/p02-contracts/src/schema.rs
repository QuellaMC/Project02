use std::borrow::Cow;
use std::fmt;
use std::sync::Arc;

use jsonschema::ValidationError;
use jsonschema::error::{TypeKind, ValidationErrorKind};
use jsonschema::paths::{Location, LocationSegment};
use p02_shared::{
    BoundJsonError, Credentials, Identifier, JsonLimits, bound_json, bound_json_object,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::vocabulary::ValidationFailureReason;

/// What a tool takes, as one self-contained JSON Schema document (draft 7)
/// whose root is an object: the one declaration a provider is shown, a
/// proposed call is judged by, and the turn records.
///
/// A contract is admitted only when every keyword in it is enforced as
/// written. A keyword the gate does not know, a `format` no registry
/// checks, a keyword that applies to a type the schema never says the
/// value has, a tuple of unstated length, a keyword ignored for want of
/// its partner, a constraint beside a `$ref` and a `$ref` outside the
/// document are refused. In a `pattern`, `.` keeps its JavaScript meaning:
/// any character but a line terminator.
#[derive(Clone, Serialize, Deserialize)]
#[serde(try_from = "Value", into = "Value")]
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
    #[error("unknown keyword \"{keyword}\" at \"{at}\"")]
    UnknownKeyword { keyword: String, at: String },
    #[error("unknown format \"{format}\" at \"{at}\": no format is enforced, so write a pattern")]
    UnknownFormat { format: String, at: String },
    #[error("\"$schema\" at \"{at}\" must name JSON Schema draft 7")]
    UnsupportedDialect { at: String },
    #[error(
        "can't resolve reference \"{reference}\" at \"{at}\": a contract is one document, so \
         every $ref starts with '#'"
    )]
    NonLocalReference { reference: String, at: String },
    #[error(
        "\"{keyword}\" beside \"$ref\" at \"{at}\" would be ignored: move it into the schema \
         the reference names"
    )]
    BesideReference { keyword: String, at: String },
    #[error("missing type \"{data_type}\" for keyword \"{keyword}\" at \"{at}\"")]
    MissingType {
        data_type: &'static str,
        keyword: String,
        at: String,
    },
    #[error("type \"{data_type}\" not allowed by context \"{context}\" at \"{at}\"")]
    TypeOutsideContext {
        data_type: &'static str,
        context: String,
        at: String,
    },
    #[error(
        "\"items\" at \"{at}\" is a {length}-tuple without minItems {length} and either maxItems \
         {length} or additionalItems false"
    )]
    OpenTuple { length: usize, at: String },
    #[error("{rule} at \"{at}\"")]
    Ignored { rule: &'static str, at: String },
}

impl InputContractError {
    #[must_use]
    pub fn reason(&self) -> ValidationFailureReason {
        ValidationFailureReason::MalformedToolDefinition
    }
}

const DRAFT_7: [&str; 2] = [
    "http://json-schema.org/draft-07/schema#",
    "http://json-schema.org/draft-07/schema",
];

const ANNOTATIONS: [&str; 8] = [
    "$comment",
    "title",
    "description",
    "default",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
];

const KEYWORDS: [&str; 37] = [
    "$id",
    "$schema",
    "$ref",
    "definitions",
    "$defs",
    "type",
    "enum",
    "const",
    "multipleOf",
    "maximum",
    "exclusiveMaximum",
    "minimum",
    "exclusiveMinimum",
    "maxLength",
    "minLength",
    "pattern",
    "items",
    "additionalItems",
    "maxItems",
    "minItems",
    "uniqueItems",
    "contains",
    "maxProperties",
    "minProperties",
    "required",
    "properties",
    "patternProperties",
    "additionalProperties",
    "dependencies",
    "propertyNames",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
];

/// What a keyword applies to: the value must be declared of that type,
/// here or in the schema it refines, or the keyword could silently not
/// apply.
const TYPED_KEYWORDS: [(&str, DataType); 22] = [
    ("multipleOf", DataType::Number),
    ("maximum", DataType::Number),
    ("exclusiveMaximum", DataType::Number),
    ("minimum", DataType::Number),
    ("exclusiveMinimum", DataType::Number),
    ("maxLength", DataType::String),
    ("minLength", DataType::String),
    ("pattern", DataType::String),
    ("items", DataType::Array),
    ("additionalItems", DataType::Array),
    ("maxItems", DataType::Array),
    ("minItems", DataType::Array),
    ("uniqueItems", DataType::Array),
    ("contains", DataType::Array),
    ("maxProperties", DataType::Object),
    ("minProperties", DataType::Object),
    ("required", DataType::Object),
    ("properties", DataType::Object),
    ("patternProperties", DataType::Object),
    ("additionalProperties", DataType::Object),
    ("dependencies", DataType::Object),
    ("propertyNames", DataType::Object),
];

/// A JavaScript `.` matches every character but the four line terminators.
const ANY_BUT_LINE_TERMINATOR: &str = "[^\\n\\r\u{2028}\u{2029}]";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DataType {
    Null,
    Boolean,
    Object,
    Array,
    Number,
    Integer,
    String,
}

impl DataType {
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "null" => Self::Null,
            "boolean" => Self::Boolean,
            "object" => Self::Object,
            "array" => Self::Array,
            "number" => Self::Number,
            "integer" => Self::Integer,
            "string" => Self::String,
            _ => return None,
        })
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Null => "null",
            Self::Boolean => "boolean",
            Self::Object => "object",
            Self::Array => "array",
            Self::Number => "number",
            Self::Integer => "integer",
            Self::String => "string",
        }
    }

    /// Whether a value known to be one of `types` may be of this type: an
    /// integer is a number.
    fn within(self, types: &[Self]) -> bool {
        types.contains(&self) || (self == Self::Integer && types.contains(&Self::Number))
    }

    /// Whether a keyword for this type applies to a value of one of `types`.
    fn applies_to(self, types: &[Self]) -> bool {
        types.contains(&self) || (self == Self::Number && types.contains(&Self::Integer))
    }
}

impl ToolInputContract {
    /// Admits a contract and compiles it once.
    ///
    /// # Errors
    ///
    /// [`InputContractError`] naming the first reason the schema is not one
    /// the gate enforces as written.
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

        let mut compiled = Value::Object(schema.clone());

        jsonschema::draft7::meta::validate(&compiled)
            .map_err(|error| InputContractError::Invalid(error.to_string()))?;
        admit(&mut compiled, "#", &[])?;

        let validator = jsonschema::draft7::new(&compiled)
            .map_err(|error| InputContractError::Invalid(error.to_string()))?;

        Ok(Self {
            schema,
            validator: Arc::new(validator),
        })
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

        match self.first_problem(&instance) {
            Some(problem) => Err(rejection(problem)),
            None => Ok(()),
        }
    }

    /// The problem the model is told of: a failed combinator speaks alone,
    /// since its branches describe the alternatives rather than the input;
    /// then a missing field; then every field the contract does not allow;
    /// then the first other failure.
    fn first_problem(&self, instance: &Value) -> Option<InputProblem> {
        let errors: Vec<ValidationError<'_>> = self.validator.iter_errors(instance).collect();

        if let Some(combinator) = errors.iter().find(|error| {
            matches!(
                error.kind(),
                ValidationErrorKind::OneOfNotValid { .. }
                    | ValidationErrorKind::OneOfMultipleValid { .. }
                    | ValidationErrorKind::AnyOf { .. }
            )
        }) {
            return Some(InputProblem::Field {
                path: field_path(combinator.instance_path(), None),
                rule: self.rule(combinator),
            });
        }

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

        Some(match first.kind() {
            // Its instance path points at the object; its error is the key's.
            ValidationErrorKind::PropertyNames { error } => InputProblem::PropertyName {
                name: value_text(error.instance()),
                rule: self.rule(error),
            },
            _ => InputProblem::Field {
                path: field_path(first.instance_path(), None),
                rule: self.rule(first),
            },
        })
    }

    fn rule(&self, error: &ValidationError<'_>) -> String {
        match error.kind() {
            ValidationErrorKind::Type { kind } => {
                format!("must be {}", self.type_names(error, kind).join(" or "))
            }
            ValidationErrorKind::Enum { options } => match options.as_array() {
                Some(values) if !values.is_empty() => format!(
                    "must be one of: {}",
                    values.iter().map(value_text).collect::<Vec<_>>().join(", ")
                ),
                _ => "must be an allowed value".to_owned(),
            },
            ValidationErrorKind::Constant { expected_value } => {
                format!("must be {}", value_text(expected_value))
            }
            ValidationErrorKind::OneOfNotValid { .. }
            | ValidationErrorKind::OneOfMultipleValid { .. } => {
                "must match exactly one schema in oneOf".to_owned()
            }
            ValidationErrorKind::AnyOf { .. } => "must match a schema in anyOf".to_owned(),
            ValidationErrorKind::Pattern { pattern } => {
                let authored = self
                    .authored(error.schema_path())
                    .and_then(Value::as_str)
                    .unwrap_or(pattern);

                format!("must match pattern \"{authored}\"")
            }
            ValidationErrorKind::MinLength { limit } => {
                format!("must NOT have fewer than {limit} characters")
            }
            ValidationErrorKind::MaxLength { limit } => {
                format!("must NOT have more than {limit} characters")
            }
            ValidationErrorKind::Minimum { limit } => format!("must be >= {limit}"),
            ValidationErrorKind::Maximum { limit } => format!("must be <= {limit}"),
            ValidationErrorKind::ExclusiveMinimum { limit } => format!("must be > {limit}"),
            ValidationErrorKind::ExclusiveMaximum { limit } => format!("must be < {limit}"),
            ValidationErrorKind::MultipleOf { multiple_of } => {
                format!("must be multiple of {multiple_of}")
            }
            ValidationErrorKind::MinItems { limit } => {
                format!("must NOT have fewer than {limit} items")
            }
            ValidationErrorKind::MaxItems { limit } => {
                format!("must NOT have more than {limit} items")
            }
            ValidationErrorKind::AdditionalItems { limit } => {
                format!("must NOT have more than {limit} items")
            }
            ValidationErrorKind::UniqueItems => "must NOT have duplicate items".to_owned(),
            ValidationErrorKind::MinProperties { limit } => {
                format!("must NOT have fewer than {limit} properties")
            }
            ValidationErrorKind::MaxProperties { limit } => {
                format!("must NOT have more than {limit} properties")
            }
            ValidationErrorKind::Contains => "must contain at least 1 valid item(s)".to_owned(),
            ValidationErrorKind::Not { .. } => "must NOT be valid".to_owned(),
            ValidationErrorKind::FalseSchema => "boolean schema is false".to_owned(),
            ValidationErrorKind::BacktrackLimitExceeded { .. }
            | ValidationErrorKind::RegexEngineFailure { .. } => {
                "could not be checked against its pattern".to_owned()
            }
            _ => "is not valid".to_owned(),
        }
    }

    /// The types in the order the contract lists them, which is the order
    /// its author meant them read.
    fn type_names(&self, error: &ValidationError<'_>, kind: &TypeKind) -> Vec<String> {
        match self.authored(error.schema_path()) {
            Some(Value::String(name)) => vec![name.clone()],
            Some(Value::Array(names)) => names.iter().map(value_text).collect(),
            _ => match kind {
                TypeKind::Single(name) => vec![name.to_string()],
                TypeKind::Multiple(names) => names.iter().map(|name| name.to_string()).collect(),
            },
        }
    }

    /// The keyword's value as authored, which a compiled pattern is not.
    fn authored(&self, schema_path: &Location) -> Option<&Value> {
        let mut segments = schema_path.segments();
        let first = match segments.next()? {
            LocationSegment::Property(key) => self.schema.get(key.as_ref())?,
            LocationSegment::Index(_) => return None,
        };

        segments.try_fold(first, |value, segment| match segment {
            LocationSegment::Property(key) => value.get(key.as_ref()),
            LocationSegment::Index(index) => match value {
                Value::Object(entries) => entries.get(&index.to_string()),
                _ => value.get(index),
            },
        })
    }
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

/// `operations[0].text`, from a JSON pointer and an optional last key; a
/// segment of digits reads as an index, and the input itself is `$`.
fn field_path(at: &Location, last: Option<&str>) -> String {
    let mut path = String::new();
    let last = last.map(|key| {
        key.parse::<usize>().map_or_else(
            |_| LocationSegment::Property(Cow::Borrowed(key)),
            LocationSegment::Index,
        )
    });

    for segment in at.segments().chain(last) {
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

/// A string as itself, anything else as its JSON text.
fn value_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Checks one schema object of a contract against the gate's rules, in
/// place on the copy that is compiled, where patterns are translated.
/// `context` is what the value is already known to be: a schema that
/// refines its parent in place inherits the parent's types, a schema for
/// another value starts knowing nothing.
fn admit(schema: &mut Value, at: &str, context: &[DataType]) -> Result<(), InputContractError> {
    let Value::Object(keywords) = schema else {
        return Ok(());
    };

    for (keyword, value) in keywords.iter() {
        if keyword == "format" {
            return Err(InputContractError::UnknownFormat {
                format: value_text(value),
                at: at.to_owned(),
            });
        }

        if !KEYWORDS.contains(&keyword.as_str()) && !ANNOTATIONS.contains(&keyword.as_str()) {
            return Err(InputContractError::UnknownKeyword {
                keyword: keyword.clone(),
                at: at.to_owned(),
            });
        }
    }

    if keywords
        .get("$schema")
        .is_some_and(|dialect| !dialect.as_str().is_some_and(|text| DRAFT_7.contains(&text)))
    {
        return Err(InputContractError::UnsupportedDialect { at: at.to_owned() });
    }

    if let Some(reference) = keywords.get("$ref") {
        check_reference(keywords, reference, at)?;
    }

    let types = known_types(keywords, at, context)?;

    for (keyword, data_type) in TYPED_KEYWORDS {
        if keywords.contains_key(keyword) && !data_type.applies_to(&types) {
            return Err(InputContractError::MissingType {
                data_type: data_type.as_str(),
                keyword: keyword.to_owned(),
                at: at.to_owned(),
            });
        }
    }

    check_partners(keywords, at)?;

    if let Some(Value::String(pattern)) = keywords.get_mut("pattern") {
        *pattern = ecma_dots(pattern).into_owned();
    }

    admit_subschemas(keywords, at, &types)
}

fn check_reference(
    keywords: &Map<String, Value>,
    reference: &Value,
    at: &str,
) -> Result<(), InputContractError> {
    if !reference.as_str().is_some_and(|text| text.starts_with('#')) {
        return Err(InputContractError::NonLocalReference {
            reference: value_text(reference),
            at: at.to_owned(),
        });
    }

    let besides = ["$ref", "$id", "$schema", "definitions", "$defs"];

    match keywords.keys().find(|keyword| {
        !besides.contains(&keyword.as_str()) && !ANNOTATIONS.contains(&keyword.as_str())
    }) {
        Some(keyword) => Err(InputContractError::BesideReference {
            keyword: keyword.clone(),
            at: at.to_owned(),
        }),
        None => Ok(()),
    }
}

/// The types the value is known to have here: the context's, narrowed by
/// this schema's own `type`, which may not step outside the context.
fn known_types(
    keywords: &Map<String, Value>,
    at: &str,
    context: &[DataType],
) -> Result<Vec<DataType>, InputContractError> {
    let declared: Vec<DataType> = match keywords.get("type") {
        Some(Value::String(name)) => DataType::parse(name).into_iter().collect(),
        Some(Value::Array(names)) => names
            .iter()
            .filter_map(|name| name.as_str().and_then(DataType::parse))
            .collect(),
        _ => Vec::new(),
    };

    if declared.is_empty() {
        return Ok(context.to_vec());
    }

    if context.is_empty() {
        return Ok(declared);
    }

    if let Some(outside) = declared.iter().find(|data_type| !data_type.within(context)) {
        return Err(InputContractError::TypeOutsideContext {
            data_type: outside.as_str(),
            context: context
                .iter()
                .map(|data_type| data_type.as_str())
                .collect::<Vec<_>>()
                .join(","),
            at: at.to_owned(),
        });
    }

    Ok(context
        .iter()
        .filter_map(|&known| {
            if known.within(&declared) {
                Some(known)
            } else if known == DataType::Number && declared.contains(&DataType::Integer) {
                Some(DataType::Integer)
            } else {
                None
            }
        })
        .collect())
}

/// Keywords that mean nothing without another, and a tuple that must say
/// how long it is.
fn check_partners(keywords: &Map<String, Value>, at: &str) -> Result<(), InputContractError> {
    let ignored = |rule| {
        Err(InputContractError::Ignored {
            rule,
            at: at.to_owned(),
        })
    };
    let has = |keyword| keywords.contains_key(keyword);

    if has("if") && !has("then") && !has("else") {
        return ignored("\"if\" without \"then\" or \"else\" is ignored");
    }

    if !has("if") && has("then") {
        return ignored("\"then\" without \"if\" is ignored");
    }

    if !has("if") && has("else") {
        return ignored("\"else\" without \"if\" is ignored");
    }

    match keywords.get("items") {
        Some(Value::Array(tuple)) => {
            let length = tuple.len();
            let states = |keyword| {
                keywords
                    .get(keyword)
                    .and_then(Value::as_u64)
                    .is_some_and(|limit| usize::try_from(limit) == Ok(length))
            };
            let closed =
                states("maxItems") || keywords.get("additionalItems") == Some(&Value::Bool(false));

            if states("minItems") && closed {
                Ok(())
            } else {
                Err(InputContractError::OpenTuple {
                    length,
                    at: at.to_owned(),
                })
            }
        }
        _ if has("additionalItems") => {
            ignored("\"additionalItems\" is ignored when \"items\" is not an array of schemas")
        }
        _ => Ok(()),
    }
}

fn admit_subschemas(
    keywords: &mut Map<String, Value>,
    at: &str,
    types: &[DataType],
) -> Result<(), InputContractError> {
    for (keyword, value) in keywords.iter_mut() {
        let here = format!("{at}/{}", escape(keyword));

        match keyword.as_str() {
            "allOf" | "anyOf" | "oneOf" => each_item(value, &here, types)?,
            "not" | "if" | "then" | "else" => admit(value, &here, types)?,
            "dependencies" => {
                for (key, dependency) in object_entries(value) {
                    if dependency.is_object() || dependency.is_boolean() {
                        admit(dependency, &format!("{here}/{}", escape(&key)), types)?;
                    }
                }
            }
            "properties" | "definitions" | "$defs" => {
                for (key, schema) in object_entries(value) {
                    admit(schema, &format!("{here}/{}", escape(&key)), &[])?;
                }
            }
            "patternProperties" => admit_pattern_properties(value, &here)?,
            "items" if value.is_array() => each_item(value, &here, &[])?,
            "items" | "additionalItems" | "additionalProperties" | "contains" => {
                admit(value, &here, &[])?;
            }
            "propertyNames" => admit(value, &here, &[DataType::String])?,
            _ => {}
        }
    }

    Ok(())
}

fn each_item(value: &mut Value, at: &str, types: &[DataType]) -> Result<(), InputContractError> {
    if let Value::Array(items) = value {
        for (index, item) in items.iter_mut().enumerate() {
            admit(item, &format!("{at}/{index}"), types)?;
        }
    }

    Ok(())
}

fn object_entries(value: &mut Value) -> Vec<(String, &mut Value)> {
    match value {
        Value::Object(entries) => entries
            .iter_mut()
            .map(|(key, value)| (key.clone(), value))
            .collect(),
        _ => Vec::new(),
    }
}

/// Each schema is admitted, and each key, a pattern, translated.
fn admit_pattern_properties(value: &mut Value, at: &str) -> Result<(), InputContractError> {
    let Value::Object(entries) = value else {
        return Ok(());
    };
    let mut translated = Map::new();

    for (pattern, mut schema) in std::mem::take(entries) {
        admit(&mut schema, &format!("{at}/{}", escape(&pattern)), &[])?;
        translated.insert(ecma_dots(&pattern).into_owned(), schema);
    }

    *entries = translated;
    Ok(())
}

fn escape(segment: &str) -> Cow<'_, str> {
    if segment.contains(['~', '/']) {
        Cow::Owned(segment.replace('~', "~0").replace('/', "~1"))
    } else {
        Cow::Borrowed(segment)
    }
}

/// `pattern` with each `.` outside a character class and not escaped made
/// the class of what a JavaScript `.` matches.
fn ecma_dots(pattern: &str) -> Cow<'_, str> {
    if !pattern.contains('.') {
        return Cow::Borrowed(pattern);
    }

    let mut translated = String::with_capacity(pattern.len());
    let mut characters = pattern.chars();
    let mut in_class = false;

    while let Some(character) = characters.next() {
        match character {
            '\\' => {
                translated.push(character);
                translated.extend(characters.next());
            }
            '[' if !in_class => {
                in_class = true;
                translated.push(character);
            }
            ']' if in_class => {
                in_class = false;
                translated.push(character);
            }
            '.' if !in_class => translated.push_str(ANY_BUT_LINE_TERMINATOR),
            _ => translated.push(character),
        }
    }

    Cow::Owned(translated)
}

impl TryFrom<Value> for ToolInputContract {
    type Error = InputContractError;

    fn try_from(schema: Value) -> Result<Self, Self::Error> {
        Self::new(schema)
    }
}

impl From<ToolInputContract> for Value {
    fn from(contract: ToolInputContract) -> Self {
        Value::Object(contract.schema)
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
    PropertyName { name: String, rule: String },
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
            Self::PropertyName { name, rule } => {
                write!(formatter, "property name \"{name}\" {rule}")
            }
            Self::Field { path, rule } => write!(formatter, "field \"{path}\" {rule}"),
        }
    }
}

impl ToolInputRejection {
    /// What the model reads: `memory.update input field "operations[0]"
    /// must match exactly one schema in oneOf.`
    #[must_use]
    pub fn sentence(&self) -> String {
        format!("{self}.")
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn contract(schema: Value) -> ToolInputContract {
        ToolInputContract::new(schema).unwrap()
    }

    fn closed(properties: Value, required: &[&str]) -> Value {
        let mut schema = json!({
            "type": "object",
            "required": required,
            "additionalProperties": false,
        });

        schema["properties"] = properties;
        schema
    }

    #[test]
    fn a_contract_is_admitted_with_the_json_schema_it_enforces() {
        let schemas = [
            json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string", "minLength": 1, "pattern": "^[a-z]+$"},
                    "count": {"type": "integer", "minimum": 0},
                    "pick": {"oneOf": [{"type": "string"}, {"type": "number"}]},
                    "tree": {"$ref": "#/$defs/node", "description": "A tree."},
                },
                "allOf": [{"type": "object", "required": ["name"]}],
                "additionalProperties": false,
                "$defs": {
                    "node": {
                        "type": "object",
                        "properties": {
                            "value": {"type": "string"},
                            "children": {"type": "array", "items": {"$ref": "#/$defs/node"}},
                        },
                        "required": ["value"],
                        "additionalProperties": false,
                    },
                },
            }),
            json!({
                "$schema": "http://json-schema.org/draft-07/schema#",
                "$id": "https://project02.test/schemas/memory-search.json",
                "type": "object",
                "properties": {
                    "note": {"type": ["string", "null"], "enum": ["remember", "forget", null]},
                    "pair": {
                        "type": "array",
                        "items": [{"type": "string"}, {"type": "number"}],
                        "minItems": 2,
                        "additionalItems": false,
                    },
                    "keyed": {"type": "object", "propertyNames": {"pattern": "^[a-z]+$"}},
                },
                "if": {"required": ["note"]},
                "then": {"required": ["pair"]},
            }),
        ];

        for schema in schemas {
            assert_eq!(
                contract(schema.clone()).schema(),
                schema.as_object().unwrap()
            );
            assert_eq!(
                Value::from(serde_json::from_value::<ToolInputContract>(schema.clone()).unwrap()),
                schema
            );
        }
    }

    #[test]
    #[expect(
        clippy::too_many_lines,
        reason = "one table of every refusal, read top to bottom"
    )]
    fn a_contract_with_a_keyword_it_would_not_enforce_as_written_is_refused() {
        let at = |path: &str| path.to_owned();
        let cases = [
            (json!([]), InputContractError::NotAnObject),
            (
                json!({"type": ["object"]}),
                InputContractError::RootNotObject,
            ),
            (
                json!({"type": "object", "requred": ["note"]}),
                InputContractError::UnknownKeyword {
                    keyword: "requred".to_owned(),
                    at: at("#"),
                },
            ),
            (
                json!({"$async": true, "type": "object"}),
                InputContractError::UnknownKeyword {
                    keyword: "$async".to_owned(),
                    at: at("#"),
                },
            ),
            (
                closed(
                    json!({"email": {"type": "string", "format": "email"}}),
                    &["email"],
                ),
                InputContractError::UnknownFormat {
                    format: "email".to_owned(),
                    at: at("#/properties/email"),
                },
            ),
            (
                closed(
                    json!({"note": {"type": "string", "properties": {}}}),
                    &["note"],
                ),
                InputContractError::MissingType {
                    data_type: "object",
                    keyword: "properties".to_owned(),
                    at: at("#/properties/note"),
                },
            ),
            (
                closed(json!({"note": {"minLength": 1}}), &[]),
                InputContractError::MissingType {
                    data_type: "string",
                    keyword: "minLength".to_owned(),
                    at: at("#/properties/note"),
                },
            ),
            (
                json!({"type": "object", "allOf": [{"type": "string"}]}),
                InputContractError::TypeOutsideContext {
                    data_type: "string",
                    context: "object".to_owned(),
                    at: at("#/allOf/0"),
                },
            ),
            (
                json!({
                    "$id": "https://example.test/tree",
                    "type": "object",
                    "properties": {"next": {"$ref": "https://example.test/tree"}},
                }),
                InputContractError::NonLocalReference {
                    reference: "https://example.test/tree".to_owned(),
                    at: at("#/properties/next"),
                },
            ),
            (
                json!({
                    "type": "object",
                    "properties": {"note": {"$ref": "#/$defs/text", "maxLength": 2}},
                    "$defs": {"text": {"type": "string"}},
                }),
                InputContractError::BesideReference {
                    keyword: "maxLength".to_owned(),
                    at: at("#/properties/note"),
                },
            ),
            (
                closed(
                    json!({"pair": {"type": "array", "items": [{"type": "string"}]}}),
                    &[],
                ),
                InputContractError::OpenTuple {
                    length: 1,
                    at: at("#/properties/pair"),
                },
            ),
            (
                json!({"type": "object", "then": {"required": ["a"]}}),
                InputContractError::Ignored {
                    rule: "\"then\" without \"if\" is ignored",
                    at: at("#"),
                },
            ),
            (
                json!({
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "type": "object",
                }),
                InputContractError::UnsupportedDialect { at: at("#") },
            ),
        ];

        for (schema, expected) in cases {
            assert_eq!(
                ToolInputContract::new(schema.clone()).unwrap_err(),
                expected,
                "{schema}"
            );
        }

        for schema in [
            closed(json!({"note": {"type": "string"}}), &["note", "note"]),
            closed(json!({"note": {"type": ["string", "string"]}}), &["note"]),
            closed(
                json!({"note": {"type": "string", "pattern": "("}}),
                &["note"],
            ),
        ] {
            assert!(matches!(
                ToolInputContract::new(schema),
                Err(InputContractError::Invalid(_))
            ));
        }
    }

    #[test]
    fn a_refused_input_names_the_field_and_the_rule() {
        let branch = |name: &str| closed(json!({name: {"type": "string"}}), &[name]);
        let cases = [
            (
                closed(json!({"toString": {"type": "string"}}), &["toString"]),
                json!({}),
                r#"memory.capture input missing required field "toString"."#,
            ),
            (
                closed(
                    json!({"note": {"type": "string", "minLength": 1}}),
                    &["note"],
                ),
                json!({"note": ""}),
                r#"memory.capture input field "note" must NOT have fewer than 1 characters."#,
            ),
            (
                closed(
                    json!({"pick": {"oneOf": [branch("a"), branch("b")]}}),
                    &["pick"],
                ),
                json!({"pick": {"a": "x", "b": "y"}}),
                r#"memory.capture input field "pick" must match exactly one schema in oneOf."#,
            ),
            (
                json!({
                    "type": "object",
                    "properties": {
                        "pick": {"oneOf": [{"$ref": "#/$defs/a"}, {"$ref": "#/$defs/b"}]},
                    },
                    "required": ["pick"],
                    "additionalProperties": false,
                    "$defs": {"a": branch("a"), "b": branch("b")},
                }),
                json!({"pick": {"a": "x", "b": "y"}}),
                r#"memory.capture input field "pick" must match exactly one schema in oneOf."#,
            ),
            (
                json!({"type": "object", "propertyNames": {"pattern": "^[a-z]+$"}}),
                json!({"Bad": 1}),
                r#"memory.capture input property name "Bad" must match pattern "^[a-z]+$"."#,
            ),
            (
                closed(json!({"mode": {"const": "safe"}}), &["mode"]),
                json!({"mode": "fast"}),
                r#"memory.capture input field "mode" must be safe."#,
            ),
            (
                closed(json!({"a/b": {"type": "number"}}), &["a/b"]),
                json!({"a/b": "high"}),
                r#"memory.capture input field "a/b" must be number."#,
            ),
            (
                closed(
                    json!({"mode": {"enum": [{"kind": "a"}, {"kind": "b"}]}}),
                    &["mode"],
                ),
                json!({"mode": {"kind": "c"}}),
                r#"memory.capture input field "mode" must be one of: {"kind":"a"}, {"kind":"b"}."#,
            ),
            (
                closed(json!({"score": {"type": ["number", "null"]}}), &["score"]),
                json!({"score": "high"}),
                r#"memory.capture input field "score" must be number or null."#,
            ),
            (
                closed(
                    json!({
                        "ops": {"type": "array", "items": {"type": "integer", "maximum": 9}},
                    }),
                    &["ops"],
                ),
                json!({"ops": [1, 10]}),
                r#"memory.capture input field "ops[1]" must be <= 9."#,
            ),
            (
                closed(
                    json!({"a": {"type": "object", "additionalProperties": false}}),
                    &[],
                ),
                json!({"a": {"x": 1, "y": 2}, "z": 3}),
                "memory.capture input includes unsupported fields: a.x, a.y, z.",
            ),
            (
                json!({"type": "object"}),
                Value::Object(
                    (0..257)
                        .map(|index| (format!("field{index}"), json!(index)))
                        .collect(),
                ),
                r#"Model tool "memory.capture" input exceeds the JSON container entry limit."#,
            ),
        ];
        let tool = Identifier::new("memory.capture").unwrap();

        for (schema, input, sentence) in cases {
            let rejection = contract(schema)
                .validate(&tool, input.as_object().unwrap())
                .unwrap_err();

            assert_eq!(rejection.sentence(), sentence);
        }
    }

    #[test]
    fn a_pattern_dot_never_matches_a_line_terminator() {
        let lines = contract(closed(
            json!({"line": {"type": "string", "pattern": "^.+$"}}),
            &["line"],
        ));
        let tool = Identifier::new("notes.add").unwrap();
        let input = |line: &str| json!({"line": line}).as_object().cloned().unwrap();

        assert_eq!(lines.validate(&tool, &input("one line")), Ok(()));

        for line in ["a\rb", "a\nb", "a\u{2028}b", "a\u{2029}b"] {
            assert_eq!(
                lines.validate(&tool, &input(line)).unwrap_err().sentence(),
                r#"notes.add input field "line" must match pattern "^.+$"."#,
                "{line:?}"
            );
        }

        let literal = contract(closed(
            json!({"version": {"type": "string", "pattern": "^v[0-9]\\.[.]$"}}),
            &["version"],
        ));

        assert_eq!(
            literal.validate(
                &tool,
                &json!({"version": "v1.."}).as_object().cloned().unwrap()
            ),
            Ok(())
        );
    }
}
