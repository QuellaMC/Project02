use p02_contracts::PluginToolDefinitions;

/// The tools the model is offered: every tool of every enabled plugin,
/// except that one which asks the person first is offered only where
/// someone can be asked.
pub(crate) fn offered(tools: &PluginToolDefinitions, can_ask: bool) -> PluginToolDefinitions {
    if can_ask {
        return tools.clone();
    }

    PluginToolDefinitions::new(
        tools
            .definitions()
            .iter()
            .filter(|definition| !definition.tool.is_approval_gated())
            .cloned()
            .collect(),
    )
    .expect("tools offered once each stay so when some are left out")
}
