//! The host's own plugin, `runtime.plugin`: what the model asks the host
//! about itself. It lists the plugins the host runs, and on asking every
//! plugin this build has; it shows one plugin's settings, as the settings
//! of the character the host serves hold them, and changes one field of
//! them on the person's yes, rebuilding that plugin live where the field
//! allows.

mod config;
mod inventory;
mod tools;

use std::sync::Arc;

use async_trait::async_trait;
use p02_contracts::{
    FactoryInput, HOST_PLUGIN, HookContext, PLUGIN_LIST_TOOL, PluginError, ProvidedTool,
    RuntimePlugin, ToolCall, ToolCallOutcome, ToolPreparation,
};

use crate::config_control::ConfigControl;
use crate::host::{Factory, HostLink};

/// The list's factory of the host's own plugin, which a host builds
/// itself, linked to it: built anywhere else, it is refused.
pub(crate) fn create(_input: &FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    Err(PluginError::new(format!(
        "{HOST_PLUGIN} is built by the plugin host it manages"
    )))
}

/// How a host builds its own plugin: linked to `host`, and reading and
/// changing the character's settings through `control`.
pub(crate) fn factory(host: &HostLink, control: Arc<dyn ConfigControl>) -> Box<Factory> {
    let host = host.clone();

    Box::new(move |_input: &FactoryInput<'_>| {
        let mut provided = vec![tools::list()?];

        provided.extend(tools::config()?);

        Ok(Arc::new(ManagementPlugin {
            tools: provided,
            host: host.clone(),
            control: Arc::clone(&control),
        }) as Arc<dyn RuntimePlugin>)
    })
}

#[derive(Debug)]
struct ManagementPlugin {
    tools: Vec<ProvidedTool>,
    host: HostLink,
    control: Arc<dyn ConfigControl>,
}

#[async_trait]
impl RuntimePlugin for ManagementPlugin {
    fn provided_tools(&self) -> &[ProvidedTool] {
        &self.tools
    }

    async fn handle_tool_call(
        &self,
        call: &ToolCall,
        _context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        match call.tool_name().as_str() {
            PLUGIN_LIST_TOOL => {
                let core = self.host.core()?;

                inventory::answer(&core, Arc::clone(&self.control), call).await
            }
            tools::CONFIG => config::inspect(Arc::clone(&self.control), call).await,
            other => Err(PluginError::new(format!(
                "{HOST_PLUGIN} answers no tool \"{other}\" at once"
            ))),
        }
    }

    async fn prepare_tool_call(
        &self,
        call: &ToolCall,
        _context: &HookContext,
    ) -> Result<ToolPreparation, PluginError> {
        match call.tool_name().as_str() {
            tools::UPDATE => {
                config::prepare(Arc::clone(&self.control), self.host.clone(), call).await
            }
            other => Err(PluginError::new(format!(
                "{HOST_PLUGIN} prepares no tool \"{other}\""
            ))),
        }
    }
}
