//! The demo-config package: a reply style its settings choose, there for
//! the host's config tools to have a plugin to change. Before each turn it
//! tells the character the tone to speak in and, when one is set, the
//! signoff to end with.

use std::sync::Arc;

use async_trait::async_trait;
use p02_contracts::{
    BeforeRoleModelCallOutput, ConfigField, ContextItem, ContextItemKind, EvidenceKind,
    EvidenceNote, EvidenceStatus, FactoryInput, HookContext, PluginError, RuntimePlugin,
};
use p02_shared::Identifier;
use serde_json::Value;

pub(crate) fn create(input: &FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    let text = |field: &str| {
        input
            .config()
            .value(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    // A tone unset, or one its field refuses, is the first the manifest
    // allows.
    let tone = text("tone")
        .or_else(|| {
            input
                .manifest()
                .config()
                .field("tone")
                .and_then(ConfigField::allowed_values)
                .and_then(<[String]>::first)
                .map(String::as_str)
        })
        .ok_or_else(|| PluginError::new("demo-config declares the tones it speaks in"))?;
    let signoff = text("signoff")
        .map(|signoff| format!(" End everything you say with the exact signoff \"{signoff}\"."))
        .unwrap_or_default();

    Ok(Arc::new(DemoConfigPlugin {
        style: format!(
            "Your speaking style right now (adjustable through the runtime.plugin.config tools): \
             speak in a {tone} tone.{signoff}"
        ),
    }))
}

#[derive(Debug)]
struct DemoConfigPlugin {
    style: String,
}

#[async_trait]
impl RuntimePlugin for DemoConfigPlugin {
    async fn before_role_model_call(
        &self,
        _context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        let style = Identifier::new("style")
            .map_err(|error| PluginError::with_source("the style note needs an id", error))?;

        Ok(BeforeRoleModelCallOutput {
            context_items: vec![ContextItem::new(
                style,
                ContextItemKind::RuntimeNote,
                self.style.clone(),
            )],
            curated_sections: Vec::new(),
            evidence: vec![EvidenceNote::new(
                EvidenceKind::BeforeRoleModelCall,
                EvidenceStatus::Accepted,
                "Provided demo config style directives.",
            )],
        })
    }
}
