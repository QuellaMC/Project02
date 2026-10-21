//! `runtime.plugin.list`: the plugins the host runs, each as the model is
//! offered it, and on asking every other plugin this build has, as the
//! character's settings decide it.

use std::collections::BTreeMap;
use std::sync::Arc;

use p02_contracts::{
    AccessMap, Declaration, EvidenceKind, EvidenceNote, EvidenceStatus, Hook, Manifest,
    PluginError, ProvidedTool, ToolCall, ToolCallOutcome,
};
use p02_shared::Identifier;
use serde_json::{Value, json};

use crate::boundary::described;
use crate::config_control::{ActivationStatus, ConfigControl};
use crate::host::Core;
use crate::package::blocking;
use crate::text::excerpt;

/// How many plugins one answer lists, and tools of each, and how much of
/// each of their texts: so a full answer stays inside the JSON limits.
const PLUGINS: usize = 16;
const TOOLS: usize = 8;
const TEXT_CHARS: usize = 160;

pub(super) async fn answer(
    core: &Core,
    control: Option<Arc<dyn ConfigControl>>,
    call: &ToolCall,
) -> Result<ToolCallOutcome, PluginError> {
    let input = call.input();
    let everything = input.get("scope") == Some(&json!("all"))
        || input.get("includeDisabled") == Some(&json!(true));
    let mut listed: Vec<Value> = core
        .slots
        .iter()
        .map(|slot| {
            let tools: Vec<&ProvidedTool> = core.offered_by(slot.manifest.id()).collect();

            summary(&slot.manifest, ActivationStatus::Active, Some(&tools))
        })
        .collect();

    if everything {
        let statuses = match control {
            Some(control) => statuses(control).await?,
            None => BTreeMap::new(),
        };
        let installed =
            crate::list::plugins().map_err(|error| PluginError::new(described(error)))?;

        listed.extend(
            installed
                .iter()
                .map(|(manifest, _)| manifest)
                .filter(|manifest| {
                    !core
                        .slots
                        .iter()
                        .any(|slot| slot.manifest.id() == manifest.id())
                })
                .map(|manifest| {
                    // A plugin its settings run and this host does not is
                    // off here all the same.
                    let status = match statuses.get(manifest.id()) {
                        Some(ActivationStatus::Blocked) => ActivationStatus::Blocked,
                        _ => ActivationStatus::Disabled,
                    };

                    summary(manifest, status, None)
                }),
        );
    }

    let truncated = listed.len() > PLUGINS;

    listed.truncate(PLUGINS);

    let summary = format!("Returned {} plugin summaries.", listed.len());

    Ok(ToolCallOutcome::Accepted {
        output: json!({"plugins": listed, "truncated": truncated}),
        evidence: vec![EvidenceNote::new(
            EvidenceKind::ToolInvocation,
            EvidenceStatus::Accepted,
            summary,
        )],
    })
}

/// How the character's settings decide each plugin.
async fn statuses(
    control: Arc<dyn ConfigControl>,
) -> Result<BTreeMap<Identifier, ActivationStatus>, PluginError> {
    Ok(blocking(move || control.activations())
        .await??
        .into_iter()
        .collect())
}

/// One plugin as the list shows it; `running`, the tools the model is
/// offered of a plugin the host runs.
fn summary(
    manifest: &Manifest,
    status: ActivationStatus,
    running: Option<&[&ProvidedTool]>,
) -> Value {
    let tools = running.unwrap_or_default();
    let (granted, hooks) = match running {
        Some(_) => (manifest.requested_access().clone(), hooks(manifest)),
        None => (AccessMap::default(), Vec::new()),
    };

    json!({
        "id": cut(manifest.id().as_str()),
        "displayName": cut(manifest.display_name()),
        "version": cut(manifest.version()),
        "kind": manifest.kind(),
        "description": cut(manifest.description()),
        "enabled": running.is_some(),
        "activationStatus": status,
        "requestedAccess": manifest.requested_access(),
        "grantedAccess": granted,
        "registeredLifecycleHooks": hooks,
        "providedTools": tools
            .iter()
            .take(TOOLS)
            .map(|tool| {
                json!({
                    "name": cut(tool.name().as_str()),
                    "description": cut(tool.description()),
                    "concurrency": tool.concurrency(),
                    "requiresConfirmation": tool.is_approval_gated(),
                })
            })
            .collect::<Vec<_>>(),
        "toolsTruncated": tools.len() > TOOLS,
    })
}

/// The hooks the host calls of the plugin.
fn hooks(manifest: &Manifest) -> Vec<&'static str> {
    manifest
        .declared_plugins()
        .iter()
        .filter_map(|declaration| match declaration {
            Declaration::ToolProvider => None,
            Declaration::BeforeRoleModelCall => Some(Hook::BeforeRoleModelCall),
            Declaration::HandleToolCall => Some(Hook::HandleToolCall),
            Declaration::AfterTurnCommitted => Some(Hook::AfterTurnCommitted),
            Declaration::OnSessionEnd => Some(Hook::OnSessionEnd),
            Declaration::OnShutdown => Some(Hook::OnShutdown),
            Declaration::Health => Some(Hook::Health),
        })
        .map(Hook::name)
        .collect()
}

fn cut(text: &str) -> String {
    excerpt(text, TEXT_CHARS).into_owned()
}
