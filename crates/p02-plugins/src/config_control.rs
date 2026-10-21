use std::fmt;

use p02_shared::{Fingerprint, Identifier};
use serde::Serialize;
use serde_json::{Map, Value};

/// The settings of the character a plugin host serves, as the host's own
/// plugin reads and changes them. The host's caller supplies it; without
/// one, the host's config tools are not offered. Every call does disk
/// work, so a hook makes it on the blocking pool.
pub trait ConfigControl: Send + Sync + fmt::Debug {
    /// Plugin `plugin`'s section of her settings, and the fingerprint a
    /// change to her settings presents.
    ///
    /// # Errors
    ///
    /// [`ReadConfigError`] when her settings cannot be read.
    fn inspect(&self, plugin: &Identifier) -> Result<PluginSettings, ReadConfigError>;

    /// Sets or unsets one field of a plugin's section in her own settings,
    /// never the home's, while her settings still have the fingerprint
    /// the change presents.
    fn change(&self, change: &FieldChange) -> FieldChangeOutcome;

    /// How her settings decide each plugin this build has.
    ///
    /// # Errors
    ///
    /// [`ReadConfigError`] when her settings cannot be read.
    fn activations(&self) -> Result<Vec<(Identifier, ActivationStatus)>, ReadConfigError>;
}

/// One plugin's section of a character's settings.
#[derive(Clone, Debug, PartialEq)]
pub struct PluginSettings {
    /// The fingerprint of her settings, which a change to them presents.
    pub fingerprint: Fingerprint,
    /// The section as her settings screen shows it: its activation, each
    /// field's declaration with what her own settings hold and what is in
    /// effect, a secret's value as `[redacted]`, and the findings about
    /// it.
    pub section: Map<String, Value>,
}

/// A change of one field: set to `value`, or unset when there is none,
/// bound to the fingerprint of the settings it was read from.
#[derive(Clone, Debug, PartialEq)]
pub struct FieldChange {
    pub plugin: Identifier,
    pub field: Identifier,
    pub value: Option<Value>,
    pub expected_fingerprint: String,
}

/// What came of a change. Every outcome but `Applied` left her settings
/// as they were.
#[derive(Clone, PartialEq)]
pub enum FieldChangeOutcome {
    Applied {
        /// The fingerprint her settings have now.
        fingerprint: Fingerprint,
        /// The values her settings now give the plugin, secrets in the
        /// clear, for the host to build it with; none when they do not
        /// run it.
        running: Option<Map<String, Value>>,
    },
    /// Her settings changed after the change was read from them.
    Conflict,
    /// The change is not one her settings take, in a sentence.
    Refused { message: String },
    /// The write could not be made, in a sentence.
    Failed { message: String },
}

/// Names what the values are for, never a value: they include secrets.
impl fmt::Debug for FieldChangeOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Applied {
                fingerprint,
                running,
            } => formatter
                .debug_struct("Applied")
                .field("fingerprint", fingerprint)
                .field(
                    "running",
                    &running
                        .as_ref()
                        .map(|values| values.keys().collect::<Vec<_>>()),
                )
                .finish(),
            Self::Conflict => formatter.write_str("Conflict"),
            Self::Refused { message } => formatter
                .debug_struct("Refused")
                .field("message", message)
                .finish(),
            Self::Failed { message } => formatter
                .debug_struct("Failed")
                .field("message", message)
                .finish(),
        }
    }
}

/// Whether a plugin runs by a character's settings: on, switched off, or
/// held back by an error in them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivationStatus {
    Active,
    Disabled,
    Blocked,
}

/// Why a character's settings cannot be read, in the sentence that says
/// what keeps them from loading.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{sentence}")]
pub struct ReadConfigError {
    pub sentence: String,
}
