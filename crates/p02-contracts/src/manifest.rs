use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Display;
use std::num::{NonZeroU32, NonZeroU64};
use std::time::Duration;

use p02_shared::{BoundJsonError, Credentials, Identifier, JsonLimits, bound_json};
use p02_wire::{ConfigValueType, LayoutCard, LayoutRow, LayoutWhen, Placement, PluginPage};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::access::{AccessMap, AccessMapError};
use crate::config::{ConfigField, ConfigSection};
use crate::label::RedactionLabel;
use crate::vocabulary::{
    BeforeRoleModelCallFailure, CONTRACT_VERSION, ConfigScope, Declaration, HandleToolCallFailure,
    PluginKind,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    page: Option<PluginPage>,
    contract_version: ContractVersion,
    declared_plugins: Vec<Declaration>,
    config: ConfigSection,
    runtime_policy: RuntimePolicy,
    activation: Activation,
    requested_access: AccessMap,
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
        "secret plugin config field \"{0}\" must be of a valueType that holds a string: a \
         credential is one"
    )]
    SecretNotText(Identifier),
    #[error(
        "plugin config field \"{0}\" is secret and cannot declare a defaultValue: a credential \
         never ships in a manifest"
    )]
    SecretDefault(Identifier),
    #[error(
        "plugin config field \"{0}\" allowedValues must name one value at least, each a value of \
         its valueType"
    )]
    AllowedValuesMismatch(Identifier),
    #[error(
        "plugin config field \"{0}\" choices must give words to each of its allowedValues, and \
         to nothing else"
    )]
    ChoicesMismatch(Identifier),
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
                "page",
                "contractVersion",
                "declaredPlugins",
                "config",
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
        let config = config_section(&root.object("config", SECTION_KEYS)?)?;
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
            page: page(&root)?,
            contract_version: ContractVersion,
            declared_plugins,
            config,
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

    /// How a settings page draws the plugin's row, when the manifest says.
    #[must_use]
    pub fn page(&self) -> Option<&PluginPage> {
        self.page.as_ref()
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

impl ConfigSection {
    /// Validates a config section declared outside a manifest, as the
    /// host's own settings and the connectors' are, by the rules a
    /// manifest's `config` meets.
    ///
    /// # Errors
    ///
    /// [`ManifestError`] for the first rule `value` breaks.
    pub fn from_value(value: &Value) -> Result<Self, ManifestError> {
        config_section(&Fields::of(value, "config".to_owned(), SECTION_KEYS)?)
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

/// How a settings page draws the plugin's row, if the manifest says. The
/// icon and the tint are names of the page's own, which falls back for one
/// it does not know, so here they are only text.
fn page(root: &Fields<'_>) -> Result<Option<PluginPage>, ManifestError> {
    let Some(fields) = root.optional_object(
        "page",
        &[
            "summary",
            "icon",
            "tint",
            "placement",
            "order",
            "connection",
        ],
    )?
    else {
        return Ok(None);
    };

    Ok(Some(PluginPage {
        summary: fields.text("summary")?,
        icon: fields.text("icon")?,
        tint: fields.text("tint")?,
        placement: fields.vocabulary("placement", Placement::ALL)?,
        order: fields
            .get("order")
            .and_then(Value::as_u64)
            .and_then(|order| u32::try_from(order).ok())
            .and_then(NonZeroU32::new)
            .ok_or_else(|| fields.invalid("order", "a positive integer"))?,
        connection: fields.optional_text("connection")?,
    }))
}

/// The keys of a config section, a manifest's or one declared in code.
const SECTION_KEYS: &[&str] = &["scope", "fields", "layout"];

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
                "label",
                "description",
                "placeholder",
                "secret",
                "scope",
                "valueType",
                "defaultValue",
                "allowedValues",
                "choices",
                "agentMutable",
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

        check_values(&field)?;
        declared.push(field);
    }

    Ok(ConfigSection {
        scope,
        layout: layout(fields, &declared)?,
        fields: declared,
    })
}

/// The section's cards as authored, and then one card more, untitled, of
/// every field no row places, in the order declared: a section that lays
/// nothing out is one card of all its fields, so no reader needs a
/// fallback.
fn layout(
    section: &Fields<'_>,
    declared: &[ConfigField],
) -> Result<Vec<LayoutCard>, ManifestError> {
    let mut cards: Vec<LayoutCard> = match section.get("layout") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                card(
                    &Fields::of(
                        item,
                        section.path(&format!("layout[{index}]")),
                        &["title", "footer", "advanced", "when", "rows"],
                    )?,
                    declared,
                )
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err(section.invalid("layout", "an array of cards")),
    };
    let unplaced: Vec<LayoutRow> = declared
        .iter()
        .filter(|field| {
            !cards
                .iter()
                .flat_map(|card| &card.rows)
                .any(|row| row.field == field.name)
        })
        .map(|field| LayoutRow {
            field: field.name.clone(),
            when: None,
        })
        .collect();

    if !unplaced.is_empty() {
        cards.push(LayoutCard {
            title: None,
            footer: None,
            advanced: false,
            when: None,
            rows: unplaced,
        });
    }

    Ok(cards)
}

fn card(fields: &Fields<'_>, declared: &[ConfigField]) -> Result<LayoutCard, ManifestError> {
    let title = fields.optional_text("title")?;
    let footer = fields.optional_text("footer")?;
    let advanced = fields.optional_boolean("advanced")?.unwrap_or(false);
    let when = condition(fields, declared)?;
    let rows = match fields.get("rows") {
        Some(Value::Array(items)) if !items.is_empty() => items
            .iter()
            .enumerate()
            .map(|(index, item)| row(fields.path(&format!("rows[{index}]")), item, declared))
            .collect::<Result<_, _>>()?,
        _ => return Err(fields.invalid("rows", "a non-empty array of rows")),
    };

    Ok(LayoutCard {
        title,
        footer,
        advanced,
        when,
        rows,
    })
}

/// A row at `path`: the name of a declared field, or an object naming one
/// and when it has an effect.
fn row(path: String, item: &Value, declared: &[ConfigField]) -> Result<LayoutRow, ManifestError> {
    let expected = "the name of a declared field";
    let (field, when) = if item.is_object() {
        let fields = Fields::of(item, path, &["field", "when"])?;

        (
            named(fields.get("field"), declared)
                .ok_or_else(|| fields.invalid("field", expected))?,
            condition(&fields, declared)?,
        )
    } else {
        let field = named(Some(item), declared).ok_or_else(|| ManifestError::Invalid {
            path,
            expected: expected.to_owned(),
        })?;

        (field, None)
    };

    Ok(LayoutRow {
        field: field.name.clone(),
        when,
    })
}

/// The `when` of a card or a row, if it has one: a declared field that
/// lists its allowed values, and one or more of them.
fn condition(
    fields: &Fields<'_>,
    declared: &[ConfigField],
) -> Result<Option<LayoutWhen>, ManifestError> {
    let Some(when) = fields.optional_object("when", &["field", "is"])? else {
        return Ok(None);
    };
    let (field, allowed) = named(when.get("field"), declared)
        .and_then(|field| Some((field, field.allowed_values.as_ref()?)))
        .ok_or_else(|| {
            when.invalid(
                "field",
                "the name of a declared field that lists allowedValues",
            )
        })?;
    let is = match when.get("is") {
        Some(Value::Array(items)) if !items.is_empty() => items
            .iter()
            .map(|item| {
                item.as_str()
                    .filter(|value| allowed.iter().any(|allowed| allowed == value))
                    .map(str::to_owned)
            })
            .collect::<Option<Vec<String>>>(),
        _ => None,
    }
    .ok_or_else(|| when.invalid("is", "an array of one or more of its field's allowedValues"))?;

    Ok(Some(LayoutWhen {
        field: field.name.clone(),
        is,
    }))
}

/// The declared field `value` names.
fn named<'d>(value: Option<&Value>, declared: &'d [ConfigField]) -> Option<&'d ConfigField> {
    let name = value?.as_str()?;

    declared.iter().find(|field| field.name.as_str() == name)
}

fn config_field(fields: &Fields<'_>) -> Result<ConfigField, ManifestError> {
    let name = fields.identifier("name")?;
    let label = fields.optional_text("label")?;
    let description = fields.text("description")?;
    let placeholder = fields.optional_text("placeholder")?;
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
    let choices = fields
        .get("choices")
        .map(|_| fields.words("choices"))
        .transpose()?;
    let agent_mutable = fields.optional_boolean("agentMutable")?.unwrap_or(false);
    let redaction_labels = fields.labels("redactionLabels")?;

    if secret && agent_mutable {
        return Err(ManifestError::SecretAgentMutable(name));
    }

    Ok(ConfigField {
        name,
        label,
        description,
        placeholder,
        secret,
        scope,
        value_type,
        default_value,
        allowed_values,
        choices,
        agent_mutable,
        redaction_labels,
    })
}

/// Every value a manifest names for a field is one the field accepts: each
/// allowed value, of which there is one at least, and the default, which is
/// what the field takes wherever nothing sets it. Words for the allowed
/// values are for each of them and nothing else. A credential is never a
/// default a manifest decides, and a secret's type is one that holds a
/// string, since a credential is one.
fn check_values(field: &ConfigField) -> Result<(), ManifestError> {
    if field.secret && !field.of_its_type(&Value::from("")) {
        return Err(ManifestError::SecretNotText(field.name.clone()));
    }

    if let Some(allowed) = &field.allowed_values
        && (allowed.is_empty()
            || !allowed
                .iter()
                .all(|value| field.accepts(&Value::from(value.as_str()))))
    {
        return Err(ManifestError::AllowedValuesMismatch(field.name.clone()));
    }

    if let Some(choices) = &field.choices
        && !field.allowed_values.as_ref().is_some_and(|allowed| {
            allowed.iter().all(|value| choices.contains_key(value))
                && choices.keys().all(|value| allowed.contains(value))
        })
    {
        return Err(ManifestError::ChoicesMismatch(field.name.clone()));
    }

    let Some(default_value) = &field.default_value else {
        return Ok(());
    };

    if field.secret {
        Err(ManifestError::SecretDefault(field.name.clone()))
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
        &["beforeRoleModelCall", "handleToolCall"],
    )?;

    Ok(RuntimePolicy {
        timeout_ms,
        redaction_labels,
        failure_behavior: FailureBehavior {
            before_role_model_call: behavior
                .vocabulary("beforeRoleModelCall", BeforeRoleModelCallFailure::ALL)?,
            handle_tool_call: behavior.vocabulary("handleToolCall", HandleToolCallFailure::ALL)?,
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

    fn optional_object(
        &self,
        key: &str,
        keys: &[&str],
    ) -> Result<Option<Fields<'a>>, ManifestError> {
        self.get(key)
            .map(|value| Fields::of(value, self.path(key), keys))
            .transpose()
    }

    fn text(&self, key: &str) -> Result<String, ManifestError> {
        self.optional_text(key)?
            .ok_or_else(|| self.invalid(key, "a non-empty string"))
    }

    fn optional_text(&self, key: &str) -> Result<Option<String>, ManifestError> {
        self.get(key)
            .map(|value| {
                value
                    .as_str()
                    .filter(|text| !text.trim().is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| self.invalid(key, "a non-empty string"))
            })
            .transpose()
    }

    /// An object of words, each a non-empty string, by what it is for.
    fn words(&self, key: &str) -> Result<BTreeMap<String, String>, ManifestError> {
        let expected = "an object of non-empty strings";
        let Some(Value::Object(entries)) = self.get(key) else {
            return Err(self.invalid(key, expected));
        };

        entries
            .iter()
            .map(|(name, words)| {
                words
                    .as_str()
                    .filter(|text| !text.trim().is_empty())
                    .map(|text| (name.clone(), text.to_owned()))
                    .ok_or_else(|| self.invalid(key, expected))
            })
            .collect()
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

    use p02_wire::{AccessLevel, AccessName};

    use super::*;
    use crate::access::AccessMapError;

    fn fixture() -> Value {
        json!({
            "id": "notes.fixture",
            "displayName": "Notes",
            "version": "1.0.0",
            "kind": "tool_provider",
            "description": "A test plugin.",
            "page": {
                "summary": "Keeps notes",
                "icon": "notebook",
                "tint": "orange",
                "placement": "mind_body",
                "order": 2,
            },
            "contractVersion": CONTRACT_VERSION,
            "declaredPlugins": ["tool_provider", "handle_tool_call"],
            "config": {
                "scope": "global_with_character_overrides",
                "fields": [
                    {
                        "name": "tone",
                        "description": "Reply tone.",
                        "secret": false,
                        "valueType": "string",
                        "allowedValues": ["warm", "formal"],
                        "redactionLabels": [],
                    },
                    {
                        "name": "apiKey",
                        "description": "A credential.",
                        "secret": true,
                        "valueType": "string",
                        "redactionLabels": ["secret"],
                    },
                ],
            },
            "runtimePolicy": {
                "timeoutMs": 1000,
                "redactionLabels": [],
                "failureBehavior": {
                    "beforeRoleModelCall": "degrade",
                    "handleToolCall": "reject_tool_call",
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
    fn a_manifest_is_refused_by_the_first_rule_it_breaks() {
        type Mutation = fn(&mut Value);

        let scopes =
            r#"one of "global_with_character_overrides", "character_only" or "global_only""#;
        let cases: Vec<(Mutation, ManifestError)> = vec![
            (
                |m| m["contractVersion"] = json!("mvp-008.runtime_plugin.v1"),
                ManifestError::UnsupportedContractVersion,
            ),
            (
                |m| m["kind"] = json!("marketplace"),
                ManifestError::UnsupportedKind,
            ),
            (
                |m| m["declaredPlugins"] = json!([]),
                invalid("declaredPlugins", "a non-empty array of declarations"),
            ),
            (
                |m| m["declaredPlugins"] = json!(["plugin_discovery"]),
                invalid(
                    "declaredPlugins[0]",
                    &format!("one of {}", spellings(Declaration::ALL)),
                ),
            ),
            (
                |m| m["declaredPlugins"] = json!(["on_shutdown", "on_shutdown"]),
                ManifestError::DuplicateDeclaration(Declaration::OnShutdown),
            ),
            (
                |m| {
                    m["config"].as_object_mut().unwrap().remove("scope");
                },
                invalid("config.scope", scopes),
            ),
            (
                |m| m["config"]["scope"] = json!("sometimes_global"),
                invalid("config.scope", scopes),
            ),
            (
                |m| m["config"]["fingerprint"] = json!("sha256:retired"),
                ManifestError::UnknownKey {
                    path: "config".to_owned(),
                    key: "fingerprint".to_owned(),
                },
            ),
            (
                |m| m["config"]["fields"][0]["defaultValueSummary"] = json!("warm"),
                ManifestError::UnknownKey {
                    path: "config.fields[0]".to_owned(),
                    key: "defaultValueSummary".to_owned(),
                },
            ),
            (
                |m| m["config"]["fields"][0]["valueType"] = json!("secret"),
                invalid(
                    "config.fields[0].valueType",
                    &format!("one of {}", spellings(ConfigValueType::ALL)),
                ),
            ),
            (
                |m| m["config"]["fields"][1]["name"] = json!("tone"),
                ManifestError::DuplicateConfigField(name("tone")),
            ),
            (
                |m| m["config"]["fields"][1]["agentMutable"] = json!(true),
                ManifestError::SecretAgentMutable(name("apiKey")),
            ),
            (
                |m| m["config"]["fields"][1]["defaultValue"] = json!("key"),
                ManifestError::SecretDefault(name("apiKey")),
            ),
            (
                |m| m["config"]["fields"][1]["valueType"] = json!("number"),
                ManifestError::SecretNotText(name("apiKey")),
            ),
            (
                |m| m["config"]["fields"][0]["valueType"] = json!("number"),
                ManifestError::AllowedValuesMismatch(name("tone")),
            ),
            (
                |m| m["config"]["fields"][0]["allowedValues"] = json!([]),
                ManifestError::AllowedValuesMismatch(name("tone")),
            ),
            (
                |m| m["config"]["fields"][0]["choices"] = json!({"warm": "Warm"}),
                ManifestError::ChoicesMismatch(name("tone")),
            ),
            (
                |m| m["config"]["fields"][1]["choices"] = json!({"key": "Key"}),
                ManifestError::ChoicesMismatch(name("apiKey")),
            ),
            (
                |m| m["config"]["fields"][0]["defaultValue"] = json!("sarcastic"),
                ManifestError::DefaultMismatch(name("tone")),
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
            ),
            (
                |m| m["config"]["layout"] = json!([{"rows": []}]),
                invalid("config.layout[0].rows", "a non-empty array of rows"),
            ),
            (
                |m| m["config"]["layout"] = json!([{"rows": ["tone", "volume"]}]),
                invalid("config.layout[0].rows[1]", "the name of a declared field"),
            ),
            (
                |m| {
                    m["config"]["layout"] =
                        json!([{"when": {"field": "apiKey", "is": ["set"]}, "rows": ["tone"]}]);
                },
                invalid(
                    "config.layout[0].when.field",
                    "the name of a declared field that lists allowedValues",
                ),
            ),
            (
                |m| {
                    m["config"]["layout"] = json!([{"rows": [
                        {"field": "apiKey", "when": {"field": "tone", "is": ["warm", "shouty"]}},
                    ]}]);
                },
                invalid(
                    "config.layout[0].rows[0].when.is",
                    "an array of one or more of its field's allowedValues",
                ),
            ),
            (
                |m| m["config"]["layout"] = json!([{"rows": ["tone"], "collapsed": true}]),
                ManifestError::UnknownKey {
                    path: "config.layout[0]".to_owned(),
                    key: "collapsed".to_owned(),
                },
            ),
            (
                |m| {
                    m["config"]["scope"] = json!("character_only");
                    m["activation"]["defaultEnabled"] = json!(true);
                },
                ManifestError::CharacterOnlyDefaultEnabled,
            ),
            (
                |m| m["runtimePolicy"]["timeoutMs"] = json!(0),
                invalid("runtimePolicy.timeoutMs", "a positive integer"),
            ),
            (
                |m| m["runtimePolicy"]["failureBehavior"]["handleToolCall"] = json!("reject_turn"),
                invalid(
                    "runtimePolicy.failureBehavior.handleToolCall",
                    r#"one of "reject_tool_call" or "degrade""#,
                ),
            ),
            (
                |m| m["requestedAccess"] = json!({"file_store": "read"}),
                ManifestError::RequestedAccess(AccessMapError::UnknownAccess {
                    name: "file_store".to_owned(),
                }),
            ),
            (
                |m| m["id"] = json!("9-lives"),
                invalid(
                    "id",
                    "an identifier: a letter, then letters, numbers, dots, underscores or hyphens",
                ),
            ),
            (
                |m| m["displayName"] = json!("  "),
                invalid("displayName", "a non-empty string"),
            ),
            (
                |m| m["page"]["placement"] = json!("sidebar"),
                invalid("page.placement", r#"one of "mind_body" or "permission""#),
            ),
            (
                |m| m["page"]["order"] = json!(0),
                invalid("page.order", "a positive integer"),
            ),
            (
                |m| m["activation"]["defaultEnabled"] = json!("yes"),
                invalid("activation.defaultEnabled", "a boolean"),
            ),
            (
                |m| m["entry"] = json!("./index.ts"),
                ManifestError::UnknownKey {
                    path: String::new(),
                    key: "entry".to_owned(),
                },
            ),
        ];

        for (mutate, expected) in cases {
            let mut manifest = fixture();

            mutate(&mut manifest);

            assert_eq!(Manifest::from_value(&manifest).unwrap_err(), expected);
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
        manifest["config"]["fields"][1]["scope"] = json!("global_only");
        manifest["requestedAccess"] = json!({"model_input": "write", "trusted_context": "write"});

        let accepted = Manifest::from_value(&manifest).unwrap();
        let tone = accepted.config().field("tone").unwrap();
        let key = accepted.config().field("apiKey").unwrap();

        assert_eq!(tone.scope(), Some(ConfigScope::CharacterOnly));
        assert_eq!(tone.default_value(), Some(&json!("warm")));
        assert!(tone.agent_mutable() && !key.agent_mutable());
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

    #[test]
    fn a_manifest_says_how_a_page_draws_it_and_every_field_lands_in_a_card() {
        let mut manifest = fixture();

        manifest["page"]["connection"] = json!("Notes");
        manifest["config"]["fields"][0]["label"] = json!("Tone");
        manifest["config"]["fields"][0]["choices"] = json!({"warm": "Warm", "formal": "Formal"});
        manifest["config"]["fields"][1]["placeholder"] = json!("Paste key");
        manifest["config"]["fields"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "name": "signoff",
                "description": "A signoff.",
                "secret": false,
                "redactionLabels": [],
            }));
        manifest["config"]["layout"] = json!([{
            "title": "Voice",
            "footer": "How it sounds.",
            "advanced": true,
            "when": {"field": "tone", "is": ["warm"]},
            "rows": ["tone", {"field": "signoff", "when": {"field": "tone", "is": ["formal"]}}],
        }]);

        let accepted = Manifest::from_value(&manifest).unwrap();
        let tone = accepted.config().field("tone").unwrap();
        let when = |value: &str| LayoutWhen {
            field: name("tone"),
            is: vec![value.to_owned()],
        };

        assert_eq!(
            serde_json::to_value(accepted.page()).unwrap(),
            json!({
                "summary": "Keeps notes",
                "icon": "notebook",
                "tint": "orange",
                "placement": "mind_body",
                "order": 2,
                "connection": "Notes",
            })
        );
        assert_eq!(tone.label(), Some("Tone"));
        assert_eq!(
            tone.choices().map(|choices| choices["formal"].as_str()),
            Some("Formal")
        );
        assert_eq!(
            accepted.config().field("apiKey").unwrap().placeholder(),
            Some("Paste key")
        );
        assert_eq!(
            accepted.config().layout(),
            [
                LayoutCard {
                    title: Some("Voice".to_owned()),
                    footer: Some("How it sounds.".to_owned()),
                    advanced: true,
                    when: Some(when("warm")),
                    rows: vec![
                        LayoutRow {
                            field: name("tone"),
                            when: None,
                        },
                        LayoutRow {
                            field: name("signoff"),
                            when: Some(when("formal")),
                        },
                    ],
                },
                LayoutCard {
                    title: None,
                    footer: None,
                    advanced: false,
                    when: None,
                    rows: vec![LayoutRow {
                        field: name("apiKey"),
                        when: None,
                    }],
                },
            ]
        );
        assert_eq!(
            Manifest::from_value(&serde_json::to_value(&accepted).unwrap()).unwrap(),
            accepted,
            "a manifest reads back as it is written"
        );

        let mut plain = fixture();

        plain.as_object_mut().unwrap().remove("page");
        plain["config"]["fields"] = json!([]);

        let plain = Manifest::from_value(&plain).unwrap();

        assert_eq!(plain.page(), None);
        assert_eq!(plain.config().layout(), []);
    }
}
