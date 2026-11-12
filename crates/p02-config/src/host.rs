//! The host's own settings, each declared once: its field as the settings
//! page shows it, declared as a plugin's field is, and how the value a
//! character runs on is read from a value of it, which is the rule its
//! values meet beyond their type.

use std::fmt;
use std::num::{NonZeroU32, NonZeroU64};
use std::sync::LazyLock;

use p02_contracts::{ConfigField, ConfigScope, ConfigSection};
use p02_core::{Participant, SpeakerName};
use p02_shared::{BASE_URL_RULE, BaseUrl};
use p02_wire::{
    AppConnection, AppModel, FieldView, ModelService, PlanAccount, RoleModelProvider, ValueSource,
};
use serde_json::{Map, Value, json};

use crate::declaration::{Layer, expectation, outside_scope};
use crate::resolve::Field;

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
            "description": "Who answers as the character: chatgpt is a model of the ChatGPT \
                plan this home is signed in to; openai is a model of the OpenAI API, on your key; \
                anthropic is a model of the Claude API, on your key; nvidia is a model on \
                NVIDIA's cloud, or on the server nvidiaBaseUrl names. No character starts until \
                one is chosen.",
            "secret": false,
            "valueType": "enum",
            "allowedValues": RoleModelProvider::ALL
                .iter()
                .map(|provider| provider.as_str())
                .collect::<Vec<_>>(),
            "choices": RoleModelProvider::ALL
                .iter()
                .map(|&provider| (provider.as_str().to_owned(), Value::from(service(provider).name)))
                .collect::<Map<String, Value>>(),
            "redactionLabels": [],
        })
    },
    read: |value| value.as_str().and_then(RoleModelProvider::parse),
    must_be: None,
};

/// The models a ChatGPT plan thinks with, best first, each id with the name
/// a person reads and whether only a paid plan has it: every plan has the
/// rest. OpenAI offers no way to list them.
const CHATGPT_MODELS: [(&str, &str, bool); 7] = [
    ("gpt-6.1-sol", "GPT-6.1 Sol", true),
    ("gpt-6-sol", "GPT-6 Sol", true),
    ("gpt-6.1-terra", "GPT-6.1 Terra", false),
    ("gpt-6-luna", "GPT-6 Luna", false),
    ("gpt-5.6-sol", "GPT-5.6 Sol", true),
    ("gpt-5.6-terra", "GPT-5.6 Terra", false),
    ("gpt-5.6-luna", "GPT-5.6 Luna", false),
];

/// Suggests every model a plan may offer. Which of them the home's plan
/// offers, and so the one it thinks with until one is set, is the sign-in's
/// to say, which no document holds: see [`plan_shaped`].
const CHATGPT_MODEL: HostSetting<String> = HostSetting {
    name: "chatgptModel",
    field: || {
        json!({
            "label": "Model",
            "description": "The model of your ChatGPT plan to talk to: one your plan offers, or \
                the id of another. The best your plan offers when left unset.",
            "secret": false,
            "valueType": "string",
            "suggestedValues": CHATGPT_MODELS.iter().map(|(id, ..)| *id).collect::<Vec<_>>(),
            "choices": CHATGPT_MODELS
                .iter()
                .map(|(id, name, _)| ((*id).to_owned(), Value::from(*name)))
                .collect::<Map<String, Value>>(),
            "redactionLabels": [],
        })
    },
    read: text,
    must_be: Some("a non-empty string"),
};

const OPENAI_API_KEY: HostSetting<String> = HostSetting {
    name: "openaiApiKey",
    field: || {
        json!({
            "label": "API Key",
            "description": "Your OpenAI API key. Needed when the provider is openai; never shown \
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

/// OpenAI's current models, most capable first, each id with the name a
/// person reads.
const OPENAI_MODELS: [(&str, &str); 4] = [
    ("gpt-6-astra", "GPT-6 Astra"),
    ("gpt-6.1-sol", "GPT-6.1 Sol"),
    ("gpt-6.1-terra", "GPT-6.1 Terra"),
    ("gpt-6-luna", "GPT-6 Luna"),
];

/// The least costly of them: a person chooses a stronger one.
const OPENAI_DEFAULT_MODEL: &str = "gpt-6-luna";

const OPENAI_MODEL: HostSetting<String> = HostSetting {
    name: "openaiModel",
    field: || {
        json!({
            "label": "Model",
            "description": "The OpenAI model to talk to: one of these, or the id of another.",
            "secret": false,
            "valueType": "string",
            "defaultValue": OPENAI_DEFAULT_MODEL,
            "suggestedValues": OPENAI_MODELS.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            "choices": OPENAI_MODELS
                .iter()
                .map(|(id, name)| ((*id).to_owned(), Value::from(*name)))
                .collect::<Map<String, Value>>(),
            "redactionLabels": [],
        })
    },
    read: text,
    must_be: Some("a non-empty string"),
};

const ANTHROPIC_API_KEY: HostSetting<String> = HostSetting {
    name: "anthropicApiKey",
    field: || {
        json!({
            "label": "API Key",
            "description": "Your Claude API key. Needed when the provider is anthropic; never \
                shown back once saved.",
            "placeholder": "Paste key",
            "secret": true,
            "valueType": "string",
            "redactionLabels": ["secret"],
        })
    },
    read: text,
    must_be: Some("a non-empty string"),
};

/// Anthropic's current models, most capable first, each id with the name a
/// person reads. Each takes Anthropic's own fallback for a decline, so a
/// request for one asks for it; an id typed in their place may not.
const ANTHROPIC_MODELS: [(&str, &str); 3] = [
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("claude-haiku-5-5", "Claude Haiku 5.5"),
];

/// The most capable, as Anthropic's own guidance defaults to: a person
/// chooses a lighter one.
const ANTHROPIC_DEFAULT_MODEL: &str = "claude-opus-5-5";

const ANTHROPIC_MODEL: HostSetting<String> = HostSetting {
    name: "anthropicModel",
    field: || {
        json!({
            "label": "Model",
            "description": "The Claude model to talk to: one of these, or the id of another.",
            "secret": false,
            "valueType": "string",
            "defaultValue": ANTHROPIC_DEFAULT_MODEL,
            "suggestedValues": ANTHROPIC_MODELS.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            "choices": ANTHROPIC_MODELS
                .iter()
                .map(|(id, name)| ((*id).to_owned(), Value::from(*name)))
                .collect::<Map<String, Value>>(),
            "redactionLabels": [],
        })
    },
    read: text,
    must_be: Some("a non-empty string"),
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

/// The rhythms of her heartbeat: each choice, its words, and how many
/// minutes apart her moments come, none when it is off.
const RHYTHMS: [(&str, &str, Option<NonZeroU32>); 6] = [
    ("off", "Off", None),
    ("15m", "15 min", NonZeroU32::new(15)),
    ("30m", "30 min", NonZeroU32::new(30)),
    ("1h", "1 hour", NonZeroU32::new(60)),
    ("2h", "2 hours", NonZeroU32::new(120)),
    ("4h", "4 hours", NonZeroU32::new(240)),
];

const HEARTBEAT: HostSetting<Option<NonZeroU32>> = HostSetting {
    name: "heartbeat",
    field: || {
        json!({
            "label": "A Moment to Herself",
            "description": "How often she gets a moment of her own while you are quiet, to \
                think, use what she has, or write to you. Each moment uses your AI model.",
            "scope": "character_only",
            "secret": false,
            "valueType": "enum",
            "allowedValues": RHYTHMS.iter().map(|(choice, ..)| *choice).collect::<Vec<_>>(),
            "choices": RHYTHMS
                .iter()
                .map(|(choice, words, _)| ((*choice).to_owned(), Value::from(*words)))
                .collect::<Map<String, Value>>(),
            "defaultValue": "30m",
            "redactionLabels": [],
        })
    },
    read: |value| {
        let value = value.as_str()?;

        RHYTHMS
            .iter()
            .find(|(choice, ..)| *choice == value)
            .map(|(.., minutes)| *minutes)
    },
    must_be: None,
};

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .map(str::to_owned)
}

/// The host's settings in the order the settings page shows them: what a
/// person decides first, the service and each service's own fields in the
/// order the services are listed, then the knobs, then what is each
/// character's own: her switch and her heartbeat.
static SETTINGS: [&dyn Setting; 13] = [
    &USER_DISPLAY_NAME,
    &ROLE_MODEL_PROVIDER,
    &CHATGPT_MODEL,
    &OPENAI_API_KEY,
    &OPENAI_MODEL,
    &ANTHROPIC_API_KEY,
    &ANTHROPIC_MODEL,
    &NVIDIA_API_KEY,
    &NVIDIA_MODEL,
    &NVIDIA_BASE_URL,
    &CONTEXT_WINDOW_TOKENS,
    &ENABLED,
    &HEARTBEAT,
];

/// A service as the settings say it: what a page calls it, what it is and
/// where a key for it comes from, its own fields in the order a page shows
/// them, the one of them that names its model, and what connects it.
struct Service {
    name: &'static str,
    summary: &'static str,
    key_from: Option<&'static str>,
    fields: &'static [&'static str],
    model: &'static str,
    connected_by: ConnectedBy,
}

/// What connects a service.
enum ConnectedBy {
    /// Any of these of its fields holding a value in effect.
    Credentials(&'static [&'static str]),
    /// The home's sign-in to a ChatGPT plan, which is no setting.
    SignIn,
}

fn service(provider: RoleModelProvider) -> Service {
    match provider {
        RoleModelProvider::Chatgpt => Service {
            name: "ChatGPT Plan",
            summary: "Sign in with the plan you already pay for",
            key_from: None,
            fields: &[CHATGPT_MODEL.name],
            model: CHATGPT_MODEL.name,
            connected_by: ConnectedBy::SignIn,
        },
        RoleModelProvider::Openai => Service {
            name: "OpenAI API",
            summary: "Pay as you go, with an API key",
            key_from: Some("Get one at platform.openai.com."),
            fields: &[OPENAI_API_KEY.name, OPENAI_MODEL.name],
            model: OPENAI_MODEL.name,
            connected_by: ConnectedBy::Credentials(&[OPENAI_API_KEY.name]),
        },
        RoleModelProvider::Anthropic => Service {
            name: "Claude API",
            summary: "Pay as you go, with an API key",
            key_from: Some("Get one in the Claude Console."),
            fields: &[ANTHROPIC_API_KEY.name, ANTHROPIC_MODEL.name],
            model: ANTHROPIC_MODEL.name,
            connected_by: ConnectedBy::Credentials(&[ANTHROPIC_API_KEY.name]),
        },
        RoleModelProvider::Nvidia => Service {
            name: "NVIDIA",
            summary: "An API key, or a server of your own",
            key_from: Some("Get one at build.nvidia.com."),
            fields: &[NVIDIA_API_KEY.name, NVIDIA_MODEL.name, NVIDIA_BASE_URL.name],
            model: NVIDIA_MODEL.name,
            // A server of the person's own may ask for no key.
            connected_by: ConnectedBy::Credentials(&[NVIDIA_API_KEY.name, NVIDIA_BASE_URL.name]),
        },
    }
}

/// Every service, in the order a page lists them, each connected while a
/// credential of it has a value in effect among the host's resolved
/// `fields`, or, for the ChatGPT plan, while the home is signed in, as
/// `account`.
pub(crate) fn services(fields: &[Field<'_>], account: Option<&PlanAccount>) -> Vec<ModelService> {
    let resolved = |name: &str| {
        fields
            .iter()
            .find(|field| field.declaration.name().as_str() == name)
            .expect("a service's fields are the host's")
    };

    RoleModelProvider::ALL
        .iter()
        .map(|&provider| {
            let service = service(provider);
            let (connected, account) = match service.connected_by {
                ConnectedBy::Credentials(credentials) => (
                    credentials
                        .iter()
                        .any(|name| resolved(name).effective.value().is_some()),
                    None,
                ),
                ConnectedBy::SignIn => (account.is_some(), account.cloned()),
            };

            ModelService {
                id: provider,
                name: service.name.to_owned(),
                summary: service.summary.to_owned(),
                key_from: service.key_from.map(str::to_owned),
                connected,
                account,
                model: resolved(service.model).declaration.name().clone(),
                fields: service
                    .fields
                    .iter()
                    .map(|name| resolved(name).declaration.name().clone())
                    .collect(),
            }
        })
        .collect()
}

/// The models a ChatGPT plan of `plan` offers, best first, each id with the
/// name a person reads: those every plan has, for a free plan or one OpenAI
/// does not name, and all of them otherwise.
fn plan_models(plan: Option<&str>) -> impl Iterator<Item = (&'static str, &'static str)> {
    let free = plan.is_none_or(|plan| plan == "free");

    CHATGPT_MODELS
        .iter()
        .filter(move |(.., paid_only)| !(free && *paid_only))
        .map(|&(id, name, _)| (id, name))
}

/// The model a plan of `plan` thinks with until one is chosen: the first it
/// offers.
fn plan_default(plan: Option<&str>) -> &'static str {
    plan_models(plan)
        .next()
        .map(|(id, _)| id)
        .expect("every plan offers models")
}

/// `provider`'s service as a connection an app on her phone signs in with:
/// what a page calls it, the models it offers in their words, as a
/// character's settings offer them, and the one it asks until another is
/// chosen, as a character's own thinking starts with: of a ChatGPT plan of
/// `plan`, those its plan offers and the best of them; of the OpenAI API,
/// its models and the least costly. The Claude API, which no app signs in
/// with, and NVIDIA, whose models no list holds, are none.
#[must_use]
pub fn connection(provider: RoleModelProvider, plan: Option<&str>) -> Option<AppConnection> {
    let (models, default_model): (Vec<(&str, &str)>, &str) = match provider {
        RoleModelProvider::Chatgpt => (plan_models(plan).collect(), plan_default(plan)),
        RoleModelProvider::Openai => (OPENAI_MODELS.to_vec(), OPENAI_DEFAULT_MODEL),
        RoleModelProvider::Anthropic | RoleModelProvider::Nvidia => return None,
    };

    Some(AppConnection {
        id: provider,
        name: service(provider).name.to_owned(),
        models: models
            .into_iter()
            .map(|(id, name)| AppModel {
                id: id.to_owned(),
                name: name.to_owned(),
            })
            .collect(),
        default_model: default_model.to_owned(),
    })
}

/// A host field's view as the home's sign-in, as `account`, shapes it: the
/// ChatGPT plan's model offers the models its plan offers, in their words,
/// and the first of them is in effect while none is set; any other field's
/// view is its declaration's.
pub(crate) fn plan_shaped(mut view: FieldView, account: Option<&PlanAccount>) -> FieldView {
    if view.name.as_str() != CHATGPT_MODEL.name {
        return view;
    }

    let plan = account.and_then(|account| account.plan.as_deref());

    view.suggested_values = Some(plan_models(plan).map(|(id, _)| id.to_owned()).collect());
    view.choices = Some(
        plan_models(plan)
            .map(|(id, name)| (id.to_owned(), name.to_owned()))
            .collect(),
    );

    if view.effective.source == ValueSource::Missing {
        view.effective.source = ValueSource::Default;
        view.effective.value = Some(Value::from(plan_default(plan)));
    }

    view
}

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
    /// The ChatGPT plan's model, when one is set; see
    /// [`HostSettings::chatgpt_model_on`].
    pub chatgpt_model: Option<String>,
    pub openai_api_key: Option<String>,
    /// The OpenAI model to ask, the field's default unless one is set.
    pub openai_model: String,
    pub anthropic_api_key: Option<String>,
    /// The Claude model to ask, the field's default unless one is set.
    pub anthropic_model: String,
    pub nvidia_api_key: Option<String>,
    pub nvidia_model: Option<String>,
    pub nvidia_base_url: Option<BaseUrl>,
    pub context_window_tokens: NonZeroU64,
    /// Whether the character is switched on.
    pub enabled: bool,
    /// How many minutes apart her moments of her own come while the person
    /// is quiet; none when her heartbeat is off.
    pub heartbeat: Option<NonZeroU32>,
}

impl HostSettings {
    /// The values the host's resolved `fields` hold in effect.
    pub(crate) fn of(fields: &[Field<'_>]) -> Self {
        Self {
            user_display_name: USER_DISPLAY_NAME.value_or_default(fields),
            role_model_provider: ROLE_MODEL_PROVIDER.value(fields),
            chatgpt_model: CHATGPT_MODEL.value(fields),
            openai_api_key: OPENAI_API_KEY.value(fields),
            openai_model: OPENAI_MODEL.value_or_default(fields),
            anthropic_api_key: ANTHROPIC_API_KEY.value(fields),
            anthropic_model: ANTHROPIC_MODEL.value_or_default(fields),
            nvidia_api_key: NVIDIA_API_KEY.value(fields),
            nvidia_model: NVIDIA_MODEL.value(fields),
            nvidia_base_url: NVIDIA_BASE_URL.value(fields),
            context_window_tokens: CONTEXT_WINDOW_TOKENS.value_or_default(fields),
            enabled: ENABLED.value(fields) == Some(true),
            heartbeat: HEARTBEAT.value_or_default(fields),
        }
    }

    /// The model she asks a ChatGPT plan of `plan` for, such as `plus`: the
    /// one her settings set, else the first the plan offers.
    #[must_use]
    pub fn chatgpt_model_on(&self, plan: Option<&str>) -> String {
        self.chatgpt_model
            .clone()
            .unwrap_or_else(|| plan_default(plan).to_owned())
    }

    /// Whether the Claude model she asks for is one the setting offers, and
    /// so takes Anthropic's own fallback for a decline.
    #[must_use]
    pub fn anthropic_fallback(&self) -> bool {
        ANTHROPIC_MODELS
            .iter()
            .any(|(id, _)| *id == self.anthropic_model)
    }
}

impl fmt::Debug for HostSettings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HostSettings")
            .field("user_display_name", &self.user_display_name)
            .field("role_model_provider", &self.role_model_provider)
            .field("chatgpt_model", &self.chatgpt_model)
            .field(
                "openai_api_key",
                &self.openai_api_key.as_ref().map(|_| "[redacted]"),
            )
            .field("openai_model", &self.openai_model)
            .field(
                "anthropic_api_key",
                &self.anthropic_api_key.as_ref().map(|_| "[redacted]"),
            )
            .field("anthropic_model", &self.anthropic_model)
            .field(
                "nvidia_api_key",
                &self.nvidia_api_key.as_ref().map(|_| "[redacted]"),
            )
            .field("nvidia_model", &self.nvidia_model)
            .field("nvidia_base_url", &self.nvidia_base_url)
            .field("context_window_tokens", &self.context_window_tokens)
            .field("enabled", &self.enabled)
            .field("heartbeat", &self.heartbeat)
            .finish()
    }
}
