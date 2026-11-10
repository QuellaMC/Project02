//! A character's package as a person adds her from a file and removes her:
//! who a file holds and what adding her would do, and what came of adding
//! or removing her. The file is the body itself, as the person's file holds
//! it, so no type of the wire reads it.

use p02_core::SpeakerName;
use p02_shared::Identifier;
use schemars::JsonSchema;
use serde::Serialize;
use ts_rs::TS;

use crate::conversation::StorageFailure;

/// Who a character file holds and what adding her would do, judged as an
/// add judges it, or why she cannot be added from it.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(optional_fields)]
pub enum CharacterPreviewOutcome {
    Ok {
        id: Identifier,
        display_name: SpeakerName,
        version: String,
        /// One line about her, when her file has one.
        #[serde(skip_serializing_if = "Option::is_none")]
        about: Option<String>,
        /// The features she would start with: each plugin on by default or
        /// asked for by her file, in the plugin list's order, then each one
        /// her file asks for that this build does not have.
        comes_with: Vec<CharacterFeature>,
        installed: CharacterInstalled,
        /// Whether a data folder of hers is in the home: she was here
        /// before, and her chats come back with her.
        has_data: bool,
    },
    Refused {
        reason: CharacterPreviewRefusal,
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum CharacterPreviewRefusal {
    /// The file holds no character this home can publish.
    Invalid,
}

/// Whether the character a file holds is in the home already.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum CharacterInstalled {
    /// She is new here.
    None,
    /// This very version of her is installed.
    Same,
    /// Another version of her is installed: adding her updates her.
    OtherVersion,
    /// She comes with the app: she cannot be added.
    BuiltIn,
}

/// A feature a character would start with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CharacterFeature {
    /// A plugin of this build, by the name a page shows.
    Plugin {
        id: Identifier,
        display_name: String,
    },
    /// A plugin her file asks for that this build does not have.
    Unknown { id: Identifier },
}

/// What came of adding the character a file holds. `added`: she is new
/// here; `updated`: her package replaced the one installed. Either way her
/// package is on disk, and she starts as any enabled character does.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AddCharacterOutcome {
    Added {
        character_id: Identifier,
    },
    Updated {
        character_id: Identifier,
    },
    /// Nothing was written.
    Refused {
        reason: AddCharacterRefusal,
        message: String,
    },
    /// Her package could not be written, and is as it was.
    Failed(StorageFailure),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum AddCharacterRefusal {
    /// The file holds no character this home can publish.
    Invalid,
    /// She comes with the app.
    BuiltIn,
}

/// What came of removing a character. `removed`: her package is gone and
/// she stops; her data stays, for her to come back to.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RemoveCharacterOutcome {
    Removed,
    /// Nothing was removed.
    Refused {
        reason: RemoveCharacterRefusal,
        message: String,
    },
    /// Her package could not be removed, and is as it was.
    Failed(StorageFailure),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum RemoveCharacterRefusal {
    /// She comes with the app: she can be switched off, never removed.
    BuiltIn,
    /// No package of the home holds her.
    UnknownCharacter,
}
