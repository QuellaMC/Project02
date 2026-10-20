//! What the plugin's settings make of it: whose memories, and the backend
//! that keeps them; or the sentence naming what to set, which never
//! repeats a value.

use p02_contracts::ResolvedConfig;
use p02_memory::{DEFAULT_EMBEDDER_MODEL, DEFAULT_MODEL, Endpoint, OPENAI_BASE_URL, Settings};
use p02_shared::{BASE_URL_RULE, BaseUrl};
use serde_json::Value;

use super::backend::Backend;
use super::embedded::Embedded;
use super::rest::{Dialect, Rest};

/// The hosted platform, which an unset `baseUrl` means for it.
const PLATFORM_BASE_URL: &str = "https://api.mem0.ai";

/// Whose memories the plugin keeps, and where.
#[derive(Debug)]
pub(super) struct Setup {
    pub(super) user: String,
    pub(super) backend: Backend,
}

/// The settings the config resolved to, each text trimmed and a blank one
/// unset.
struct Fields<'a>(&'a ResolvedConfig);

impl Fields<'_> {
    fn text(&self, field: &str) -> Option<&str> {
        self.0
            .value(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    }

    fn base_url(&self, field: &str) -> Result<Option<BaseUrl>, String> {
        self.text(field)
            .map(|text| {
                BaseUrl::parse(text).map_err(|_| format!("Mem0 {field} must be {BASE_URL_RULE}."))
            })
            .transpose()
    }
}

/// The plugin's setup, or why the settings leave it without one.
pub(super) fn configured(config: &ResolvedConfig) -> Result<Setup, String> {
    let fields = Fields(config);
    let user = fields
        .text("userId")
        .ok_or_else(|| "Mem0 userId must not be blank.".to_owned())?
        .to_owned();
    let backend = match fields.text("backend") {
        Some("server") => server(&fields)?,
        Some("oss") => embedded(&fields)?,
        _ => platform(&fields)?,
    };

    Ok(Setup { user, backend })
}

fn platform(fields: &Fields<'_>) -> Result<Backend, String> {
    let key = fields
        .text("apiKey")
        .ok_or("Mem0 platform backend needs the apiKey config field (MEM0_API_KEY).")?;
    let base = match fields.base_url("baseUrl")? {
        Some(base) => base,
        None => BaseUrl::parse(PLATFORM_BASE_URL).expect("the platform's address is a base URL"),
    };

    Rest::new(Dialect::Platform, base, Some(key))
        .map(Backend::Rest)
        .map_err(|error| error.to_string())
}

fn server(fields: &Fields<'_>) -> Result<Backend, String> {
    let base = fields
        .base_url("baseUrl")?
        .ok_or("Mem0 server backend needs the baseUrl config field.")?;

    Rest::new(Dialect::Server, base, fields.text("apiKey"))
        .map(Backend::Rest)
        .map_err(|error| error.to_string())
}

/// Both endpoints speak the OpenAI wire. Every rule runs on the effective
/// endpoints, an unset one resolved to the OpenAI cloud, so spelling out a
/// default behaves as leaving it unset: the embedder takes the extraction
/// endpoint unless given its own, and the extraction key only while the
/// two are one endpoint, since a key travels with its endpoint. The cloud
/// is the one endpoint that requires a key.
fn embedded(fields: &Fields<'_>) -> Result<Backend, String> {
    let cloud = BaseUrl::parse(OPENAI_BASE_URL).expect("the OpenAI address is a base URL");
    let model_base = fields.base_url("ossLlmBaseUrl")?;
    let embedder_base = fields.base_url("ossEmbedderBaseUrl")?;
    let model_base = model_base.unwrap_or_else(|| cloud.clone());
    let embedder_base = embedder_base.unwrap_or_else(|| model_base.clone());
    let model_key = fields.text("ossLlmApiKey");
    let embedder_key = fields
        .text("ossEmbedderApiKey")
        .or(model_key.filter(|_| embedder_base == model_base));

    if model_base == cloud && model_key.is_none() {
        return Err(
            "Mem0 OSS extraction needs the ossLlmApiKey config field (MEM0_OSS_LLM_API_KEY), or \
             an ossLlmBaseUrl pointing at an OpenAI-compatible server such as LM Studio or \
             Ollama."
                .to_owned(),
        );
    }

    if embedder_base == cloud && embedder_key.is_none() {
        return Err(
            "Mem0 OSS embedding at the OpenAI endpoint needs the ossEmbedderApiKey config field \
             (MEM0_OSS_EMBEDDER_API_KEY)."
                .to_owned(),
        );
    }

    let unusable =
        |field: &str| format!("Mem0 {field} holds characters a request header cannot carry.");
    let model = Endpoint::new(
        model_base,
        model_key,
        fields.text("ossLlmModel").unwrap_or(DEFAULT_MODEL),
    )
    .map_err(|_| unusable("ossLlmApiKey"))?;
    let embedder = Endpoint::new(
        embedder_base,
        embedder_key,
        fields
            .text("ossEmbedderModel")
            .unwrap_or(DEFAULT_EMBEDDER_MODEL),
    )
    .map_err(|_| unusable("ossEmbedderApiKey"))?;

    Ok(Backend::Embedded(Box::new(Embedded::new(Settings {
        model,
        embedder,
    }))))
}
