//! What the packages compiled into the daemon share.

use std::error::Error;

use p02_contracts::{PluginError, ProvidedTool, ToolInputContract};
use p02_shared::Identifier;
use serde_json::Value;

/// A tool of a package, which acts without approval and runs alone until
/// its package says otherwise. No build of the daemon ships a refused one,
/// so a refusal is the package's failure to start.
pub(crate) fn tool(
    name: &str,
    description: &str,
    contract: Value,
) -> Result<ProvidedTool, PluginError> {
    ProvidedTool::new(
        Identifier::new(name).map_err(refused(name))?,
        description,
        ToolInputContract::new(contract).map_err(refused(name))?,
    )
    .map_err(refused(name))
}

fn refused<E: Error + Send + Sync + 'static>(name: &str) -> impl Fn(E) -> PluginError + '_ {
    move |error| PluginError::with_source(format!("tool \"{name}\" was refused"), error)
}
