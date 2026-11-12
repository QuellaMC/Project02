#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod activation;
mod change;
mod conceal;
mod declaration;
mod document;
mod host;
mod materialize;
mod resolve;
mod transaction;
mod view;

pub use change::{apply_change, check_change, create_home_document};
pub use declaration::{Connector, Sections, UnknownConnector, connector, connectors};
pub use host::{HostSettings, connection};
pub use materialize::{MaterializeError, materialize};
pub use resolve::{CharacterSettings, ReadSettingsError, Resolution};
pub use view::{
    ConfigReport, ConnectorReport, HostReport, PluginReport, RuntimeConfigReport, config_view,
    connector_config_view,
};
