#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod activation;
mod change;
mod conceal;
mod declaration;
mod diagnostic;
mod document;
mod materialize;
mod resolve;
mod transaction;
mod view;

pub use change::{
    ChangeOutcome, ChangeRefusal, ConfigChange, ConfigTarget, Operation, apply_change,
    create_home_document,
};
pub use declaration::{Connector, Namespace, RoleModelProvider, Sections, Source, connectors};
pub use diagnostic::{Code, Diagnostic, Severity};
pub use materialize::{MaterializeError, materialize};
pub use resolve::{CharacterSettings, HostSettings, ReadSettingsError, Resolution};
pub use view::{
    ActivationStatus, Authored, CharacterConnectorEntry, ConfigReport, ConfigView,
    ConnectorConfigView, ConnectorEntry, ConnectorRefusal, ConnectorReport, EffectiveView,
    FieldView, HostReport, PluginReport, RuntimeConfigReport, SectionActivation, SectionView,
    ValueSource, ViewRefusal,
};
