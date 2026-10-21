//! The host's own plugin, `runtime.plugin`: what the model asks the host
//! about itself. It lists the plugins the host runs, and on asking every
//! plugin this build has; and where the host holds the settings of the
//! character it serves, it shows one plugin's settings and changes one
//! field of them on the person's yes, rebuilding that plugin live where the
//! field allows.

mod config;
mod inventory;
mod tools;

use std::sync::Arc;

use async_trait::async_trait;
use p02_contracts::{
    FactoryInput, HookContext, PLUGIN_LIST_TOOL, PluginError, ProvidedTool, RuntimePlugin,
    ToolCall, ToolCallOutcome, ToolPreparation,
};

use crate::config_control::ConfigControl;
use crate::host::{Factory, HostLink};

pub(crate) const PLUGIN_ID: &str = "runtime.plugin";

/// The list's factory of the host's own plugin, which a host builds
/// itself, linked to it: built anywhere else, it is refused.
pub(crate) fn create(_input: &FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    Err(PluginError::new(format!(
        "{PLUGIN_ID} is built by the plugin host it manages"
    )))
}

/// How a host builds its own plugin: linked to `host`, and offering the
/// config tools only where `control` hands it the character's settings.
pub(crate) fn factory(host: &HostLink, control: Option<Arc<dyn ConfigControl>>) -> Box<Factory> {
    let host = host.clone();

    Box::new(move |_input: &FactoryInput<'_>| {
        let mut provided = vec![tools::list()?];

        if control.is_some() {
            provided.extend(tools::config()?);
        }

        Ok(Arc::new(ManagementPlugin {
            tools: provided,
            host: host.clone(),
            control: control.clone(),
        }) as Arc<dyn RuntimePlugin>)
    })
}

#[derive(Debug)]
struct ManagementPlugin {
    tools: Vec<ProvidedTool>,
    host: HostLink,
    control: Option<Arc<dyn ConfigControl>>,
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

                inventory::answer(&core, self.control.clone(), call).await
            }
            tools::CONFIG => config::inspect(self.control()?, call).await,
            other => Err(PluginError::new(format!(
                "{PLUGIN_ID} answers no tool \"{other}\" at once"
            ))),
        }
    }

    async fn prepare_tool_call(
        &self,
        call: &ToolCall,
        _context: &HookContext,
    ) -> Result<ToolPreparation, PluginError> {
        match call.tool_name().as_str() {
            tools::UPDATE => config::prepare(self.control()?, self.host.clone(), call).await,
            other => Err(PluginError::new(format!(
                "{PLUGIN_ID} prepares no tool \"{other}\""
            ))),
        }
    }
}

impl ManagementPlugin {
    /// The character's settings, which its config tools exist only with.
    fn control(&self) -> Result<Arc<dyn ConfigControl>, PluginError> {
        self.control
            .clone()
            .ok_or_else(|| PluginError::new("the host holds no settings of its character"))
    }
}
