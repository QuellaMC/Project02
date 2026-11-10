//! The host's own settings, each declared once: its field as the settings
//! page shows it, declared as a plugin's field is, and how the value a
//! character runs on is read from a value of it, which is the rule its
//! values meet beyond their type.

use std::fmt;
use std::num::NonZeroU64;
use std::sync::LazyLock;

use p02_contracts::{ConfigField, ConfigScope, ConfigSection};
use p02_core::{Participant, SpeakerName};
use p02_shared::{BASE_URL_RULE, BaseUrl, vocabulary};
use serde_json::{Value, json};

use crate::declaration::{Layer, expectation, outside_scope};
use crate::resolve::Field;

vocabulary! {
    /// Who answers as a character. Only real providers are here: the test
    /// provider is a test harness's switch, never a setting, and a home has
    /// no provider until its person chooses one.
    RoleModelProvider {
        /// A model on NVIDIA's cloud, or on a server of the person's own
        /// that speaks its wire.
        Nvidia = "nvidia",
    }
}

/// One of the host's own settings. A value it cannot read is one its
/// field refuses; a blank text is never one, since unsetting is its own
/// change.
#[derive(Debug)]
pub(crate) struct HostSetting<T> {
    name: &'static str,
    /// Its field but the name, declared as a plugin's field is.
    field: fn() -> Value,
    read: fn(&Value) -> Option<T>,
    /// What a value must be, after "must be", where its field does not say.
    must_be: Option<&'static str>,
}

const USER_DISPLAY_NAME: HostSetting<SpeakerName> = HostSetting {
    name: "userDisplayName",
    field: || {
        json!({
            "label": "Name",
            "description": "The name you go by in conversation. A new name reaches every \
                character from your next message; earlier messages keep the name they were \
                written under.",
            "placeholder": "Your name",
            "secret": false,
            "valueType": "string",
            "defaultValue": Participant::DEFAULT_LOCAL_USER_NAME,
            "redactionLabels": [],
        })
    },
    read: |value| {
        value
            .as_str()
            .and_then(|text| SpeakerName::new(text.trim()).ok())
    },
    must_be: Some("a non-empty single-line string of at most 128 characters"),
};

const ROLE_MODEL_PROVIDER: HostSetting<RoleModelProvider> = HostSetting {
    name: "roleModelProvider",
    field: || {
        json!({
            "label": "Service",
            "description": "Who answers as the character: nvidia is a model on NVIDIA's cloud, \
                or on the server nvidiaBaseUrl names. No character starts until one is chosen.",
            "secret": false,
            "valueType": "enum",
            "allowedValues": RoleModelProvider::ALL
                .iter()
                .map(|provider| provider.as_str())
                .collect::<Vec<_>>(),
            "choices": {"nvidia": "NVIDIA"},
            "redactionLabels": [],
        })
    },
    read: |value| value.as_str().and_then(RoleModelProvider::parse),
    must_be: None,
};

const NVIDIA_API_KEY: HostSetting<String> = HostSetting {
    name: "nvidiaApiKey",
    field: || {
        json!({
            "label": "API Key",
            "description": "Your NVIDIA API key. Needed when the provider is nvidia; never shown \
                back once saved.",
            "placeholder": "Paste key",
            "secret": true,
            "valueType": "string",
            "redactionLabels": ["secret"],
        })
    },
    read: text,
    must_be: Some("a non-empty string"),
};

const NVIDIA_MODEL: HostSetting<String> = HostSetting {
    name: "nvidiaModel",
    field: || {
        json!({
            "label": "Model",
            "description": "The NVIDIA model to talk to; the provider's default when left unset.",
            "placeholder": "NVIDIA's Default",
            "secret": false,
            "valueType": "string",
            "redactionLabels": [],
        })
    },
    read: text,
    must_be: Some("a non-empty string"),
};

const NVIDIA_BASE_URL: HostSetting<BaseUrl> = HostSetting {
    name: "nvidiaBaseUrl",
    field: || {
        json!({
            "label": "Server Address",
            "description": "Where the model runs: the base address of an NVIDIA NIM or any \
                OpenAI-compatible server, such as http://localhost:1234/v1. NVIDIA's cloud when \
                left unset. Use https:// for a server on another machine: http:// sends the key \
                and the conversation in the clear.",
            "placeholder": "NVIDIA Cloud",
            "secret": false,
            "valueType": "url",
            "redactionLabels": [],
        })
    },
    read: |value| value.as_str().and_then(|text| BaseUrl::parse(text).ok()),
    must_be: Some(BASE_URL_RULE),
};

const CONTEXT_WINDOW_TOKENS: HostSetting<NonZeroU64> = HostSetting {
    name: "contextWindowTokens",
    field: || {
        json!({
            "label": "Context Size",
            "description": "How much conversation the model can hold at once, in tokens; up to \
                half of it replays past messages. Lower it if the model runs out of room.",
            "secret": false,
            "valueType": "number",
            "defaultValue": 32768,
            "redactionLabels": [],
        })
    },
    read: |value| value.as_u64().and_then(NonZeroU64::new),
    must_be: Some("a positive whole number of tokens"),
};

const ENABLED: HostSetting<bool> = HostSetting {
    name: "enabled",
    field: || {
        json!({
            "label": "On",
            "description": "Whether the character is switched on. A character that is off is \
                not started and cannot be reached; turning it back on starts it.",
            "scope": "character_only",
            "secret": false,
            "valueType": "boolean",
            "defaultValue": true,
            "redactionLabels": [],
        })
    },
    read: Value::as_bool,
    must_be: None,
};

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .map(str::to_owned)
}

/// The host's settings in the order the settings page shows them: what a
/// person decides first, then the knobs, then each character's own switch.
static SETTINGS: [&dyn Setting; 7] = [
    &USER_DISPLAY_NAME,
    &ROLE_MODEL_PROVIDER,
    &NVIDIA_API_KEY,
    &NVIDIA_MODEL,
    &NVIDIA_BASE_URL,
    &CONTEXT_WINDOW_TOKENS,
    &ENABLED,
];

/// A host setting, whatever the type of its value.
trait Setting: fmt::Debug + Sync {
    fn declaration(&self) -> Value;

    fn takes(&self, value: &Value) -> bool;

    fn must_be(&self) -> Option<&'static str>;
}

impl<T: fmt::Debug> Setting for HostSetting<T> {
    fn declaration(&self) -> Value {
        let mut field = (self.field)();

        field["name"] = Value::from(self.name);
        field
    }

    fn takes(&self, value: &Value) -> bool {
        (self.read)(value).is_some()
    }

    fn must_be(&self) -> Option<&'static str> {
        self.must_be
    }
}

impl<T> HostSetting<T> {
    /// Its value in effect among the host's resolved `fields`, read, when
    /// it is one its field takes.
    fn value(&self, fields: &[Field<'_>]) -> Option<T> {
        self.resolved(fields).effective.value().and_then(self.read)
    }

    /// Its value in effect, or its default in place of one its field
    /// refuses: that stops her start, so the default stands in only here.
    fn value_or_default(&self, fields: &[Field<'_>]) -> T {
        let field = self.resolved(fields);

        field
            .effective
            .value()
            .or(field.declaration.default_value())
            .and_then(self.read)
            .expect("a host setting with a default reads it: each default meets its rule")
    }

    fn resolved<'f, 's>(&self, fields: &'f [Field<'s>]) -> &'f Field<'s> {
        fields
            .iter()
            .find(|field| field.declaration.name().as_str() == self.name)
            .expect("every host setting is resolved")
    }
}

/// Where a document holds the host's field `name`.
fn path(name: &str) -> String {
    format!("project02.{name}")
}

/// One of the host's fields as the settings take it: its declaration, held
/// to the rules of a manifest, and the sentence a value it refuses is
/// reported by.
#[derive(Debug)]
pub(crate) struct HostField {
    setting: &'static dyn Setting,
    pub(crate) declaration: ConfigField,
    pub(crate) sentence: String,
}

impl HostField {
    pub(crate) fn name(&self) -> &str {
        self.declaration.name().as_str()
    }

    pub(crate) fn path(&self) -> String {
        path(self.name())
    }

    /// Which settings may set the field: the home's with a character's on
    /// top, unless its declaration narrows that.
    pub(crate) fn scope(&self) -> ConfigScope {
        self.declaration.scope().unwrap_or(SCOPE)
    }

    /// The sentence for a value of this field that `layer` holds and its
    /// scope keeps from it, which also refuses a write of one.
    pub(crate) fn outside_scope(&self, layer: Layer) -> String {
        outside_scope("project02", Some(self.name()), layer)
    }

    /// The one judge of a value of this field, for the loader and every
    /// writer alike.
    pub(crate) fn accepts(&self, value: &Value) -> bool {
        self.declaration.accepts(value) && self.setting.takes(value)
    }
}

/// Where a host field is set unless it says otherwise.
const SCOPE: ConfigScope = ConfigScope::GlobalWithCharacterOverrides;

static HOST: LazyLock<Vec<HostField>> = LazyLock::new(|| {
    // The declarations are this build's own, so a refusal is a defect a
    // test of the registry shows before any build ships it.
    let section = ConfigSection::from_value(&json!({
        "scope": SCOPE,
        "fields": SETTINGS.iter().map(|setting| setting.declaration()).collect::<Vec<_>>(),
    }))
    .expect("the host's fields meet the rules of a manifest");

    SETTINGS
        .iter()
        .zip(section.fields())
        .map(|(setting, declaration)| HostField {
            setting: *setting,
            sentence: format!(
                "Project02 {} must be {}.",
                declaration.name(),
                setting
                    .must_be()
                    .map_or_else(|| expectation(declaration), str::to_owned)
            ),
            declaration: declaration.clone(),
        })
        .collect()
});

/// The host's fields, in page order.
pub(crate) fn host_fields() -> &'static [HostField] {
    &HOST
}

pub(crate) fn host_field(name: &str) -> Option<&'static HostField> {
    host_fields().iter().find(|field| field.name() == name)
}

/// The host's values a character runs on.
#[derive(Clone, PartialEq, Eq)]
pub struct HostSettings {
    /// The name the person goes by, trimmed.
    pub user_display_name: SpeakerName,
    /// None until the person chooses one, and no character starts before.
    pub role_model_provider: Option<RoleModelProvider>,
    pub nvidia_api_key: Option<String>,
    pub nvidia_model: Option<String>,
    pub nvidia_base_url: Option<BaseUrl>,
    pub context_window_tokens: NonZeroU64,
    /// Whether the character is switched on.
    pub enabled: bool,
}

impl HostSettings {
    /// The values the host's resolved `fields` hold in effect.
    pub(crate) fn of(fields: &[Field<'_>]) -> Self {
        Self {
            user_display_name: USER_DISPLAY_NAME.value_or_default(fields),
            role_model_provider: ROLE_MODEL_PROVIDER.value(fields),
            nvidia_api_key: NVIDIA_API_KEY.value(fields),
            nvidia_model: NVIDIA_MODEL.value(fields),
            nvidia_base_url: NVIDIA_BASE_URL.value(fields),
            context_window_tokens: CONTEXT_WINDOW_TOKENS.value_or_default(fields),
            enabled: ENABLED.value(fields) == Some(true),
        }
    }
}

impl fmt::Debug for HostSettings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HostSettings")
            .field("user_display_name", &self.user_display_name)
            .field("role_model_provider", &self.role_model_provider)
            .field(
                "nvidia_api_key",
                &self.nvidia_api_key.as_ref().map(|_| "[redacted]"),
            )
            .field("nvidia_model", &self.nvidia_model)
            .field("nvidia_base_url", &self.nvidia_base_url)
            .field("context_window_tokens", &self.context_window_tokens)
            .field("enabled", &self.enabled)
            .finish()
    }
}
