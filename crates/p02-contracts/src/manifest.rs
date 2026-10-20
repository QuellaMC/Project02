use std::collections::BTreeSet;
use std::fmt::Display;
use std::num::NonZeroU64;
use std::time::Duration;

use p02_shared::{BoundJsonError, Credentials, Identifier, JsonLimits, bound_json};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::access::{AccessMap, AccessMapError};
use crate::config::{ConfigField, ConfigSection};
use crate::label::RedactionLabel;
use crate::vocabulary::{
    BeforeRoleModelCallFailure, CONTRACT_VERSION, ConfigScope, ConfigValueType, Declaration,
    HandleToolCallFailure, HealthFailure, PluginKind, ValidationFailureReason,
};

/// A plugin's manifest, validated: it exists only once every rule holds.
/// Every object in it is closed, so a misspelled key is refused rather than
/// silently dropping what its author meant.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "Value")]
pub struct Manifest {
    id: Identifier,
    display_name: String,
    version: String,
    kind: PluginKind,
    description: String,
    contract_version: ContractVersion,
    compatibility: Compatibility,
    declared_plugins: Vec<Declaration>,
    config: ConfigSection,
    first_party: bool,
    runtime_policy: RuntimePolicy,
    activation: Activation,
    requested_access: AccessMap,
}

/// The host contract versions a plugin was written against; this host's
/// is always among them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Compatibility {
    host_contract_versions: Vec<String>,
}

/// The one budget every hook of the plugin runs under, and what a failure
/// of each policed hook does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePolicy {
    timeout_ms: NonZeroU64,
    redaction_labels: Vec<RedactionLabel>,
    failure_behavior: FailureBehavior,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureBehavior {
    before_role_model_call: BeforeRoleModelCallFailure,
    handle_tool_call: HandleToolCallFailure,
    health: HealthFailure,
}

/// Whether the plugin runs where no settings switch it, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activation {
    default_enabled: bool,
    reasons: Vec<String>,
}

/// The first rule a manifest breaks, in the order they are checked.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum ManifestError {
    #[error("{} must be {expected}", subject(.path))]
    Invalid { path: String, expected: String },
    #[error("{} has unknown key \"{key}\"", subject(.path))]
    UnknownKey { path: String, key: String },
    #[error("plugin manifest contractVersion must be \"{CONTRACT_VERSION}\"")]
    UnsupportedContractVersion,
    #[error("plugin manifest kind must be one of {}", spellings(PluginKind::ALL))]
    UnsupportedKind,
    #[error("plugin manifest declaredPlugins declares \"{0}\" more than once")]
    DuplicateDeclaration(Declaration),
    #[error("plugin manifest compatibility must include \"{CONTRACT_VERSION}\"")]
    IncompatibleHost,
    #[error("plugin config field \"{0}\" is declared more than once")]
    DuplicateConfigField(Identifier),
    #[error(
        "plugin config field \"{field}\" cannot be \"{field_scope}\" in a \"{section_scope}\" \
         config: a field's scope must equal its config's, or narrow \
         \"global_with_character_overrides\""
    )]
    FieldScopeWidens {
        field: Identifier,
        field_scope: ConfigScope,
        section_scope: ConfigScope,
    },
    #[error("secret plugin config field \"{0}\" cannot allow agent mutation")]
    SecretAgentMutable(Identifier),
    #[error(
        "plugin config field \"{0}\" is secret and cannot declare a defaultValue: a credential \
         never ships in a manifest"
    )]
    SecretDefault(Identifier),
    #[error(
        "plugin config field \"{0}\" is required and cannot declare a defaultValue: a required \
         field is one its operator must set"
    )]
    RequiredDefault(Identifier),
    #[error(
        "plugin config field \"{0}\" defaultValue must be a value of its valueType, and one of \
         its allowedValues when it has them"
    )]
    DefaultMismatch(Identifier),
    #[error("plugin config field \"{field}\" defaultValue is past the JSON limits")]
    DefaultTooLarge {
        field: Identifier,
        #[source]
        source: BoundJsonError,
    },
    #[error(
        "character-only plugins cannot be enabled by the manifest default; enable them in a \
         character package or character config"
    )]
    CharacterOnlyDefaultEnabled,
    #[error("plugin manifest requestedAccess is not an access map")]
    RequestedAccess(#[source] AccessMapError),
}

fn subject(path: &str) -> String {
    if path.is_empty() {
        "plugin manifest".to_owned()
    } else {
        format!("plugin manifest field \"{path}\"")
    }
}

/// `"a", "b" or "c"`.
fn spellings<T: Display>(values: &[T]) -> String {
    let quoted: Vec<String> = values.iter().map(|value| format!("\"{value}\"")).collect();

    match quoted.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} or {last}", rest.join(", ")),
        _ => quoted.concat(),
    }
}

impl ManifestError {
    #[must_use]
    pub fn reason(&self) -> ValidationFailureReason {
        match self {
            Self::UnsupportedContractVersion | Self::IncompatibleHost => {
                ValidationFailureReason::UnsupportedContractVersion
            }
            Self::UnsupportedKind => ValidationFailureReason::UnsupportedPluginKind,
            Self::DuplicateDeclaration(_) | Self::DuplicateConfigField(_) => {
                ValidationFailureReason::DuplicateDeclaration
            }
            Self::Invalid { .. }
            | Self::UnknownKey { .. }
            | Self::FieldScopeWidens { .. }
            | Self::SecretAgentMutable(_)
            | Self::SecretDefault(_)
            | Self::RequiredDefault(_)
            | Self::DefaultMismatch(_)
            | Self::DefaultTooLarge { .. }
            | Self::CharacterOnlyDefaultEnabled
            | Self::RequestedAccess(_) => ValidationFailureReason::MalformedManifest,
        }
    }
}

impl Manifest {
    /// Validates an authored manifest.
    ///
    /// # Errors
    ///
    /// [`ManifestError`] for the first rule `value` breaks.
    pub fn from_value(value: &Value) -> Result<Self, ManifestError> {
        let root = Fields::of(
            value,
            String::new(),
            &[
                "id",
                "displayName",
                "version",
                "kind",
                "description",
                "contractVersion",
                "compatibility",
                "declaredPlugins",
                "config",
                "firstParty",
                "runtimePolicy",
                "activation",
                "requestedAccess",
            ],
        )?;

        if root.get("contractVersion").and_then(Value::as_str) != Some(CONTRACT_VERSION) {
            return Err(ManifestError::UnsupportedContractVersion);
        }

        let kind = root
            .get("kind")
            .and_then(Value::as_str)
            .and_then(PluginKind::parse)
            .ok_or(ManifestError::UnsupportedKind)?;
        let declared_plugins = declarations(&root)?;
        let compatibility =
            compatibility(&root.object("compatibility", &["hostContractVersions"])?)?;
        let config = config_section(&root.object("config", &["scope", "fields"])?)?;
        let first_party = root.boolean("firstParty")?;
        let runtime_policy = runtime_policy(&root.object(
            "runtimePolicy",
            &["timeoutMs", "redactionLabels", "failureBehavior"],
        )?)?;
        let activation = activation(&root.object("activation", &["defaultEnabled", "reasons"])?)?;

        if config.scope == ConfigScope::CharacterOnly && activation.default_enabled {
            return Err(ManifestError::CharacterOnlyDefaultEnabled);
        }

        let requested_access = AccessMap::from_json(root.get("requestedAccess"))
            .map_err(ManifestError::RequestedAccess)?;

        Ok(Self {
            id: root.identifier("id")?,
            display_name: root.text("displayName")?,
            version: root.text("version")?,
            kind,
            description: root.text("description")?,
            contract_version: ContractVersion,
            compatibility,
            declared_plugins,
            config,
            first_party,
            runtime_policy,
            activation,
            requested_access,
        })
    }

    /// The plugin's id, which also names its config section and its data.
    #[must_use]
    pub fn id(&self) -> &Identifier {
        &self.id
    }

    #[must_use]
    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }

    #[must_use]
    pub fn kind(&self) -> PluginKind {
        self.kind
    }

    #[must_use]
    pub fn description(&self) -> &str {
        &self.description
    }

    #[must_use]
    pub fn compatibility(&self) -> &Compatibility {
        &self.compatibility
    }

    /// The declarations, in authored order.
    #[must_use]
    pub fn declared_plugins(&self) -> &[Declaration] {
        &self.declared_plugins
    }

    #[must_use]
    pub fn declares(&self, declaration: Declaration) -> bool {
        self.declared_plugins.contains(&declaration)
    }

    #[must_use]
    pub fn config(&self) -> &ConfigSection {
        &self.config
    }

    /// Shown to the person; it grants nothing.
    #[must_use]
    pub fn first_party(&self) -> bool {
        self.first_party
    }

    #[must_use]
    pub fn runtime_policy(&self) -> &RuntimePolicy {
        &self.runtime_policy
    }

    #[must_use]
    pub fn activation(&self) -> &Activation {
        &self.activation
    }

    #[must_use]
    pub fn requested_access(&self) -> &AccessMap {
        &self.requested_access
    }
}

impl TryFrom<Value> for Manifest {
    type Error = ManifestError;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        Self::from_value(&value)
    }
}

/// The version a validated manifest names, which can only be this one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ContractVersion;

impl Serialize for ContractVersion {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(CONTRACT_VERSION)
    }
}

impl Compatibility {
    #[must_use]
    pub fn host_contract_versions(&self) -> &[String] {
        &self.host_contract_versions
    }
}

impl RuntimePolicy {
    /// What every hook of the plugin may take, the work the host does on
    /// its behalf included.
    #[must_use]
    pub fn timeout(&self) -> Duration {
        Duration::from_millis(self.timeout_ms.get())
    }

    #[must_use]
    pub fn timeout_ms(&self) -> NonZeroU64 {
        self.timeout_ms
    }

    /// The labels the host adds to every record of this plugin.
    #[must_use]
    pub fn redaction_labels(&self) -> &[RedactionLabel] {
        &self.redaction_labels
    }

    #[must_use]
    pub fn failure_behavior(&self) -> FailureBehavior {
        self.failure_behavior
    }
}

impl FailureBehavior {
    #[must_use]
    pub fn before_role_model_call(self) -> BeforeRoleModelCallFailure {
        self.before_role_model_call
    }

    #[must_use]
    pub fn handle_tool_call(self) -> HandleToolCallFailure {
        self.handle_tool_call
    }

    #[must_use]
    pub fn health(self) -> HealthFailure {
        self.health
    }
}

impl Activation {
    #[must_use]
    pub fn default_enabled(&self) -> bool {
        self.default_enabled
    }

    #[must_use]
    pub fn reasons(&self) -> &[String] {
        &self.reasons
    }
}

fn declarations(root: &Fields<'_>) -> Result<Vec<Declaration>, ManifestError> {
    let items = match root.get("declaredPlugins") {
        Some(Value::Array(items)) if !items.is_empty() => items,
        _ => return Err(root.invalid("declaredPlugins", "a non-empty array of declarations")),
    };
    let mut seen = BTreeSet::new();

    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let declaration = item.as_str().and_then(Declaration::parse).ok_or_else(|| {
                root.invalid(
                    &format!("declaredPlugins[{index}]"),
                    &format!("one of {}", spellings(Declaration::ALL)),
                )
            })?;

            if seen.insert(declaration) {
                Ok(declaration)
            } else {
                Err(ManifestError::DuplicateDeclaration(declaration))
            }
        })
        .collect()
}

fn compatibility(fields: &Fields<'_>) -> Result<Compatibility, ManifestError> {
    let host_contract_versions = fields.strings("hostContractVersions")?;

    if host_contract_versions
        .iter()
        .any(|version| version == CONTRACT_VERSION)
    {
        Ok(Compatibility {
            host_contract_versions,
        })
    } else {
        Err(ManifestError::IncompatibleHost)
    }
}

fn config_section(fields: &Fields<'_>) -> Result<ConfigSection, ManifestError> {
    let scope = fields.vocabulary("scope", ConfigScope::ALL)?;
    let Some(Value::Array(items)) = fields.get("fields") else {
        return Err(fields.invalid("fields", "an array"));
    };
    let mut declared: Vec<ConfigField> = Vec::with_capacity(items.len());

    for (index, item) in items.iter().enumerate() {
        let field = config_field(&Fields::of(
            item,
            fields.path(&format!("fields[{index}]")),
            &[
                "name",
                "description",
                "required",
                "secret",
                "scope",
                "valueType",
                "defaultValue",
                "allowedValues",
                "agentMutable",
                "reloadRequired",
                "redactionLabels",
            ],
        )?)?;

        if declared.iter().any(|other| other.name == field.name) {
            return Err(ManifestError::DuplicateConfigField(field.name));
        }

        // A field shows only inside its section's block, so it may narrow
        // the section's scope but never reach a screen the section is left off.
        if let Some(field_scope) = field.scope
            && field_scope != scope
            && scope != ConfigScope::GlobalWithCharacterOverrides
        {
            return Err(ManifestError::FieldScopeWidens {
                field: field.name,
                field_scope,
                section_scope: scope,
            });
        }

        check_default(&field)?;
        declared.push(field);
    }

    Ok(ConfigSection {
        scope,
        fields: declared,
    })
}

fn config_field(fields: &Fields<'_>) -> Result<ConfigField, ManifestError> {
    let name = fields.identifier("name")?;
    let description = fields.text("description")?;
    let required = fields.boolean("required")?;
    let secret = fields.boolean("secret")?;
    let scope = fields.optional_vocabulary("scope", ConfigScope::ALL)?;
    let value_type = fields.optional_vocabulary("valueType", ConfigValueType::ALL)?;
    let default_value = fields
        .get("defaultValue")
        .map(|value| {
            bound_json(
                value.clone(),
                &fields.path("defaultValue"),
                JsonLimits::default(),
                Credentials::Keep,
            )
            .map_err(|source| ManifestError::DefaultTooLarge {
                field: name.clone(),
                source,
            })
        })
        .transpose()?;
    let allowed_values = fields
        .get("allowedValues")
        .map(|_| fields.strings("allowedValues"))
        .transpose()?;
    let agent_mutable = fields.optional_boolean("agentMutable")?.unwrap_or(false);
    let reload_required = fields.optional_boolean("reloadRequired")? != Some(false);
    let redaction_labels = fields.labels("redactionLabels")?;

    if secret && agent_mutable {
        return Err(ManifestError::SecretAgentMutable(name));
    }

    Ok(ConfigField {
        name,
        description,
        required,
        secret,
        scope,
        value_type,
        default_value,
        allowed_values,
        agent_mutable,
        reload_required,
        redaction_labels,
    })
}

/// A default is what a field takes wherever nothing sets it, so it is a
/// value the field accepts; a credential, or a value its operator must
/// choose, is never one a manifest decides.
fn check_default(field: &ConfigField) -> Result<(), ManifestError> {
    let Some(default_value) = &field.default_value else {
        return Ok(());
    };

    if field.secret {
        Err(ManifestError::SecretDefault(field.name.clone()))
    } else if field.required {
        Err(ManifestError::RequiredDefault(field.name.clone()))
    } else if field.accepts(default_value) {
        Ok(())
    } else {
        Err(ManifestError::DefaultMismatch(field.name.clone()))
    }
}

fn runtime_policy(fields: &Fields<'_>) -> Result<RuntimePolicy, ManifestError> {
    let timeout_ms = fields
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .and_then(NonZeroU64::new)
        .ok_or_else(|| fields.invalid("timeoutMs", "a positive integer"))?;
    let redaction_labels = fields.labels("redactionLabels")?;
    let behavior = fields.object(
        "failureBehavior",
        &["beforeRoleModelCall", "handleToolCall", "health"],
    )?;

    Ok(RuntimePolicy {
        timeout_ms,
        redaction_labels,
        failure_behavior: FailureBehavior {
            before_role_model_call: behavior
                .vocabulary("beforeRoleModelCall", BeforeRoleModelCallFailure::ALL)?,
            handle_tool_call: behavior.vocabulary("handleToolCall", HandleToolCallFailure::ALL)?,
            health: behavior.vocabulary("health", HealthFailure::ALL)?,
        },
    })
}

fn activation(fields: &Fields<'_>) -> Result<Activation, ManifestError> {
    Ok(Activation {
        default_enabled: fields.boolean("defaultEnabled")?,
        reasons: fields.strings("reasons")?,
    })
}

/// One closed object of the manifest, read field by field.
struct Fields<'a> {
    path: String,
    entries: &'a Map<String, Value>,
}

impl<'a> Fields<'a> {
    fn of(value: &'a Value, path: String, keys: &[&str]) -> Result<Self, ManifestError> {
        let Value::Object(entries) = value else {
            return Err(ManifestError::Invalid {
                path,
                expected: "an object".to_owned(),
            });
        };

        if let Some(key) = entries
            .keys()
            .filter(|key| !keys.contains(&key.as_str()))
            .min()
        {
            return Err(ManifestError::UnknownKey {
                path,
                key: key.clone(),
            });
        }

        Ok(Self { path, entries })
    }

    fn path(&self, key: &str) -> String {
        if self.path.is_empty() {
            key.to_owned()
        } else {
            format!("{}.{key}", self.path)
        }
    }

    fn get(&self, key: &str) -> Option<&'a Value> {
        self.entries.get(key)
    }

    fn invalid(&self, key: &str, expected: &str) -> ManifestError {
        ManifestError::Invalid {
            path: self.path(key),
            expected: expected.to_owned(),
        }
    }

    fn object(&self, key: &str, keys: &[&str]) -> Result<Fields<'a>, ManifestError> {
        Fields::of(self.get(key).unwrap_or(&Value::Null), self.path(key), keys)
    }

    fn text(&self, key: &str) -> Result<String, ManifestError> {
        self.get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(str::to_owned)
            .ok_or_else(|| self.invalid(key, "a non-empty string"))
    }

    fn identifier(&self, key: &str) -> Result<Identifier, ManifestError> {
        self.get(key)
            .and_then(Value::as_str)
            .and_then(|text| Identifier::new(text).ok())
            .ok_or_else(|| {
                self.invalid(
                    key,
                    "an identifier: a letter, then letters, numbers, dots, underscores or hyphens",
                )
            })
    }

    fn boolean(&self, key: &str) -> Result<bool, ManifestError> {
        self.optional_boolean(key)?
            .ok_or_else(|| self.invalid(key, "a boolean"))
    }

    fn optional_boolean(&self, key: &str) -> Result<Option<bool>, ManifestError> {
        self.get(key)
            .map(|value| {
                value
                    .as_bool()
                    .ok_or_else(|| self.invalid(key, "a boolean"))
            })
            .transpose()
    }

    fn strings(&self, key: &str) -> Result<Vec<String>, ManifestError> {
        self.array_of_text(key, |text| {
            (!text.trim().is_empty()).then(|| text.to_owned())
        })
    }

    fn labels(&self, key: &str) -> Result<Vec<RedactionLabel>, ManifestError> {
        self.array_of_text(key, |text| RedactionLabel::new(text).ok())
    }

    fn array_of_text<T>(
        &self,
        key: &str,
        parse: impl Fn(&str) -> Option<T>,
    ) -> Result<Vec<T>, ManifestError> {
        let expected = "an array of non-empty strings";
        let Some(Value::Array(items)) = self.get(key) else {
            return Err(self.invalid(key, expected));
        };

        items
            .iter()
            .map(|item| {
                item.as_str()
                    .and_then(&parse)
                    .ok_or_else(|| self.invalid(key, expected))
            })
            .collect()
    }

    fn vocabulary<T: Copy + Display>(&self, key: &str, words: &[T]) -> Result<T, ManifestError> {
        self.optional_vocabulary(key, words)?
            .ok_or_else(|| self.invalid(key, &format!("one of {}", spellings(words))))
    }

    fn optional_vocabulary<T: Copy + Display>(
        &self,
        key: &str,
        words: &[T],
    ) -> Result<Option<T>, ManifestError> {
        self.get(key)
            .map(|value| {
                value
                    .as_str()
                    .and_then(|text| words.iter().copied().find(|word| word.to_string() == text))
                    .ok_or_else(|| self.invalid(key, &format!("one of {}", spellings(words))))
            })
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::access::AccessMapError;
    use crate::vocabulary::{AccessLevel, AccessName};

    fn fixture() -> Value {
        json!({
            "id": "notes.fixture",
            "displayName": "Notes",
            "version": "1.0.0",
            "kind": "tool_provider",
            "description": "A test plugin.",
            "contractVersion": CONTRACT_VERSION,
            "compatibility": {"hostContractVersions": [CONTRACT_VERSION]},
            "declaredPlugins": ["tool_provider", "handle_tool_call"],
            "config": {
                "scope": "global_with_character_overrides",
                "fields": [
                    {
                        "name": "tone",
                        "description": "Reply tone.",
                        "required": false,
                        "secret": false,
                        "valueType": "string",
                        "allowedValues": ["warm", "formal"],
                        "redactionLabels": [],
                    },
                    {
                        "name": "apiKey",
                        "description": "A credential.",
                        "required": false,
                        "secret": true,
                        "valueType": "string",
                        "redactionLabels": ["secret"],
                    },
                ],
            },
            "firstParty": true,
            "runtimePolicy": {
                "timeoutMs": 1000,
                "redactionLabels": [],
                "failureBehavior": {
                    "beforeRoleModelCall": "degrade",
                    "handleToolCall": "reject_tool_call",
                    "health": "degrade",
                },
            },
            "activation": {"defaultEnabled": false, "reasons": ["test"]},
            "requestedAccess": {"model_input": "write"},
        })
    }

    fn invalid(path: &str, expected: &str) -> ManifestError {
        ManifestError::Invalid {
            path: path.to_owned(),
            expected: expected.to_owned(),
        }
    }

    fn name(text: &str) -> Identifier {
        Identifier::new(text).unwrap()
    }

    #[test]
    #[expect(
        clippy::too_many_lines,
        reason = "one table of every refusal, read top to bottom"
    )]
    fn a_manifest_is_refused_by_the_first_rule_it_breaks_with_its_reason() {
        use ValidationFailureReason::{
            DuplicateDeclaration, MalformedManifest, UnsupportedContractVersion,
            UnsupportedPluginKind,
        };

        type Mutation = fn(&mut Value);

        let scopes =
            r#"one of "global_with_character_overrides", "character_only" or "global_only""#;
        let cases: Vec<(Mutation, ManifestError, ValidationFailureReason)> = vec![
            (
                |m| m["contractVersion"] = json!("mvp-008.runtime_plugin.v1"),
                ManifestError::UnsupportedContractVersion,
                UnsupportedContractVersion,
            ),
            (
                |m| m["kind"] = json!("marketplace"),
                ManifestError::UnsupportedKind,
                UnsupportedPluginKind,
            ),
            (
                |m| m["declaredPlugins"] = json!([]),
                invalid("declaredPlugins", "a non-empty array of declarations"),
                MalformedManifest,
            ),
            (
                |m| m["declaredPlugins"] = json!(["plugin_discovery"]),
                invalid(
                    "declaredPlugins[0]",
                    &format!("one of {}", spellings(Declaration::ALL)),
                ),
                MalformedManifest,
            ),
            (
                |m| m["declaredPlugins"] = json!(["health", "health"]),
                ManifestError::DuplicateDeclaration(Declaration::Health),
                DuplicateDeclaration,
            ),
            (
                |m| m["compatibility"]["hostContractVersions"] = json!(["mvp-007"]),
                ManifestError::IncompatibleHost,
                UnsupportedContractVersion,
            ),
            (
                |m| {
                    m["config"].as_object_mut().unwrap().remove("scope");
                },
                invalid("config.scope", scopes),
                MalformedManifest,
            ),
            (
                |m| m["config"]["scope"] = json!("sometimes_global"),
                invalid("config.scope", scopes),
                MalformedManifest,
            ),
            (
                |m| m["config"]["fingerprint"] = json!("sha256:retired"),
                ManifestError::UnknownKey {
                    path: "config".to_owned(),
                    key: "fingerprint".to_owned(),
                },
                MalformedManifest,
            ),
            (
                |m| m["config"]["fields"][0]["defaultValueSummary"] = json!("warm"),
                ManifestError::UnknownKey {
                    path: "config.fields[0]".to_owned(),
                    key: "defaultValueSummary".to_owned(),
                },
                MalformedManifest,
            ),
            (
                |m| m["config"]["fields"][0]["valueType"] = json!("secret"),
                invalid(
                    "config.fields[0].valueType",
                    &format!("one of {}", spellings(ConfigValueType::ALL)),
                ),
                MalformedManifest,
            ),
            (
                |m| m["config"]["fields"][1]["name"] = json!("tone"),
                ManifestError::DuplicateConfigField(name("tone")),
                DuplicateDeclaration,
            ),
            (
                |m| m["config"]["fields"][1]["agentMutable"] = json!(true),
                ManifestError::SecretAgentMutable(name("apiKey")),
                MalformedManifest,
            ),
            (
                |m| m["config"]["fields"][1]["defaultValue"] = json!("key"),
                ManifestError::SecretDefault(name("apiKey")),
                MalformedManifest,
            ),
            (
                |m| {
                    m["config"]["fields"][0]["required"] = json!(true);
                    m["config"]["fields"][0]["defaultValue"] = json!("warm");
                },
                ManifestError::RequiredDefault(name("tone")),
                MalformedManifest,
            ),
            (
                |m| m["config"]["fields"][0]["defaultValue"] = json!("sarcastic"),
                ManifestError::DefaultMismatch(name("tone")),
                MalformedManifest,
            ),
            (
                |m| {
                    m["config"]["scope"] = json!("global_only");
                    m["config"]["fields"][0]["scope"] = json!("character_only");
                },
                ManifestError::FieldScopeWidens {
                    field: name("tone"),
                    field_scope: ConfigScope::CharacterOnly,
                    section_scope: ConfigScope::GlobalOnly,
                },
                MalformedManifest,
            ),
            (
                |m| {
                    m["config"]["scope"] = json!("character_only");
                    m["activation"]["defaultEnabled"] = json!(true);
                },
                ManifestError::CharacterOnlyDefaultEnabled,
                MalformedManifest,
            ),
            (
                |m| m["runtimePolicy"]["timeoutMs"] = json!(0),
                invalid("runtimePolicy.timeoutMs", "a positive integer"),
                MalformedManifest,
            ),
            (
                |m| m["runtimePolicy"]["failureBehavior"]["health"] = json!("reject_tool_call"),
                invalid(
                    "runtimePolicy.failureBehavior.health",
                    r#"one of "degrade" or "reject_turn""#,
                ),
                MalformedManifest,
            ),
            (
                |m| m["requestedAccess"] = json!({"file_store": "read"}),
                ManifestError::RequestedAccess(AccessMapError::UnknownAccess {
                    name: "file_store".to_owned(),
                }),
                MalformedManifest,
            ),
            (
                |m| m["id"] = json!("9-lives"),
                invalid(
                    "id",
                    "an identifier: a letter, then letters, numbers, dots, underscores or hyphens",
                ),
                MalformedManifest,
            ),
            (
                |m| m["displayName"] = json!("  "),
                invalid("displayName", "a non-empty string"),
                MalformedManifest,
            ),
            (
                |m| m["firstParty"] = json!("yes"),
                invalid("firstParty", "a boolean"),
                MalformedManifest,
            ),
            (
                |m| m["entry"] = json!("./index.ts"),
                ManifestError::UnknownKey {
                    path: String::new(),
                    key: "entry".to_owned(),
                },
                MalformedManifest,
            ),
        ];

        for (mutate, expected, reason) in cases {
            let mut manifest = fixture();

            mutate(&mut manifest);

            let error = Manifest::from_value(&manifest).unwrap_err();

            assert_eq!(error, expected);
            assert_eq!(error.reason(), reason, "{error}");
        }
    }

    #[test]
    fn a_refusal_names_the_place_and_the_rule() {
        let mut manifest = fixture();

        manifest["runtimePolicy"]["timeoutMs"] = json!(-1);
        assert_eq!(
            Manifest::from_value(&manifest).unwrap_err().to_string(),
            r#"plugin manifest field "runtimePolicy.timeoutMs" must be a positive integer"#
        );
        assert_eq!(
            Manifest::from_value(&json!([])).unwrap_err().to_string(),
            "plugin manifest must be an object"
        );
        assert_eq!(
            ManifestError::FieldScopeWidens {
                field: name("homeSetting"),
                field_scope: ConfigScope::GlobalOnly,
                section_scope: ConfigScope::CharacterOnly,
            }
            .to_string(),
            "plugin config field \"homeSetting\" cannot be \"global_only\" in a \"character_only\" \
             config: a field's scope must equal its config's, or narrow \
             \"global_with_character_overrides\""
        );
    }

    #[test]
    fn a_manifest_accepts_narrowed_scopes_typed_defaults_and_absent_access() {
        let mut manifest = fixture();

        manifest["config"]["fields"][0]["scope"] = json!("character_only");
        manifest["config"]["fields"][0]["defaultValue"] = json!("warm");
        manifest["config"]["fields"][0]["agentMutable"] = json!(true);
        manifest["config"]["fields"][0]["reloadRequired"] = json!(false);
        manifest["config"]["fields"][1]["scope"] = json!("global_only");
        manifest["requestedAccess"] = json!({"model_input": "write", "trusted_context": "write"});

        let accepted = Manifest::from_value(&manifest).unwrap();
        let tone = accepted.config().field("tone").unwrap();
        let key = accepted.config().field("apiKey").unwrap();

        assert_eq!(tone.scope(), Some(ConfigScope::CharacterOnly));
        assert_eq!(tone.default_value(), Some(&json!("warm")));
        assert!(tone.agent_mutable() && !tone.reload_required());
        assert!(!key.agent_mutable() && key.reload_required());
        assert!(
            accepted
                .requested_access()
                .grants(AccessName::TrustedContext, AccessLevel::Write)
        );

        manifest.as_object_mut().unwrap().remove("requestedAccess");
        assert_eq!(
            Manifest::from_value(&manifest).unwrap().requested_access(),
            &AccessMap::default()
        );
    }
}
