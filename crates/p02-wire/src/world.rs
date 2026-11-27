//! Her world as the person sees it: its places, the things in each, who is
//! where and what happened there, read whether she runs or not; and what
//! came of the person's hand in it, a thing left in a place with a note and
//! a thing removed. Each is the person's own act, which asks nobody, and
//! nothing tells her of it: she finds what was left when she is next told
//! what is around her there. Its names and notes are in her language, and
//! each carries the person's form beside it when they read another, as a
//! message does.

use p02_core::{SpeakerName, Timestamp};
use p02_shared::Identifier;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The world a character lives in as it stands; or why it was not read.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorldOutcome {
    Ok(WorldView),
    Refused {
        reason: WorldRefusal,
        message: String,
    },
    /// Her world could not be read.
    Failed {
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorldRefusal {
    UnknownCharacter,
    /// Her package brings no world, or her settings do not run it.
    NoWorld,
}

/// Everything a person sees of a world: its id and name; its places in
/// their order, each with its things in the order they came; who is where
/// and since when, each character the home has by her display name; the
/// newest 200 lines of its journal, newest first; and the kinds a thing
/// can be left as.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorldView {
    pub id: Identifier,
    pub name: WorldWords,
    pub places: Vec<WorldPlace>,
    pub characters: Vec<WorldCharacter>,
    pub journal: Vec<WorldEntry>,
    pub kinds: Vec<WorldKind>,
}

/// A name or a note of her world: `text`, as her world has it, which she
/// reads; and, as a message carries it, the person's form beside it while
/// they read another language than hers: what they wrote, `written`, of a
/// thing they left that her world has in her words, or her world's words
/// put into theirs, `translation`. Words that are the same in both have
/// `text` alone.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[ts(optional_fields)]
pub struct WorldWords {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub written: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
}

/// A place of a world: its id, its name, its icon and tint, names of the
/// page's own set, which falls back for one it does not know, and the
/// things in it in the order they came.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
pub struct WorldPlace {
    pub id: Identifier,
    pub name: WorldWords,
    pub icon: String,
    pub tint: String,
    pub things: Vec<WorldThing>,
}

/// A thing in a place: the id the world gave it, its name, icon and tint,
/// whom it is from, when it came, the note the person left with it when
/// they wrote one, and, for a thing the person left, the characters who
/// have been told of it where it is. Until a character has, it is new to
/// her; what the world itself brought and what she made never are.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct WorldThing {
    pub id: String,
    pub name: WorldWords,
    pub icon: String,
    pub tint: String,
    pub from: WorldHand,
    pub came: Timestamp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<WorldWords>,
    pub seen: Vec<Identifier>,
}

/// A hand that changes a world: the world itself, the person, or a
/// character, by her id. A thing is from one, and a line of the journal
/// says whose deed it was.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorldHand {
    World,
    Person,
    Character { id: Identifier },
}

/// A character living in a world: her id and display name, the place she
/// is in, by its id, and since when.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorldCharacter {
    pub id: Identifier,
    pub display_name: SpeakerName,
    pub place: Identifier,
    pub since: Timestamp,
}

/// A line of a world's journal: when, whose deed it was, what happened,
/// and the place and the thing it was about.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct WorldEntry {
    pub when: Timestamp,
    pub who: WorldHand,
    pub what: WorldDeed,
    pub place: WorldNamed,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thing: Option<WorldNamed>,
}

/// What a line of the journal says happened: she went somewhere, made a
/// thing or used one, or the person left a thing or removed one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorldDeed {
    Went,
    Made,
    Used,
    Left,
    Removed,
}

/// A place or a thing as a line of the journal names it: by its id, and by
/// the name it had then, with the person's form that name had then beside
/// it; or, for a line that kept none, that of the place or the thing of
/// that id while the world holds it by that name.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
pub struct WorldNamed {
    pub id: String,
    pub name: WorldWords,
}

/// A kind a thing can be left as: its id, the name a person reads, and the
/// icon and the tint a thing of it is drawn with.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
pub struct WorldKind {
    pub id: Identifier,
    pub name: String,
    pub icon: String,
    pub tint: String,
}

/// A thing the person leaves her in a place of her world: its name, one
/// line of 128 characters at most; its kind, by the id of one of the
/// world's kinds; the place, by its id; and their note, when they write
/// one, not blank and 280 characters at most, which may have several lines.
#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct LeaveThingBody {
    pub name: String,
    pub kind: String,
    pub place: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// What came of leaving her a thing: the thing as her world now holds it,
/// in her language; or why it was not left.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LeaveThingOutcome {
    Ok {
        // Boxed, since a thing is many times the size of a refusal.
        thing: Box<WorldThing>,
    },
    /// Nothing was left.
    Refused {
        reason: LeaveThingRefusal,
        message: String,
    },
    /// Her world could not be read or written: it is as it was.
    Failed { message: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum LeaveThingRefusal {
    UnknownCharacter,
    /// Her package brings no world, or her settings do not run it.
    NoWorld,
    /// The world holds no place of that id.
    UnknownPlace,
    /// The kind is none of the world's.
    UnknownKind,
    /// The name is not one line of 1 to 128 characters.
    InvalidName,
    /// The note is blank or longer than 280 characters.
    InvalidNote,
    /// The place holds the most things it can.
    NoRoom,
    /// Its name or its note could not be put into her language.
    NotTranslated,
}

/// What came of removing a thing from her world: it is gone, whoever it
/// was from; or why it was not removed.
#[derive(Clone, Debug, Serialize, JsonSchema, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RemoveThingOutcome {
    Ok,
    /// Nothing was removed.
    Refused {
        reason: RemoveThingRefusal,
        message: String,
    },
    /// Her world could not be read or written: it is as it was.
    Failed {
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum RemoveThingRefusal {
    UnknownCharacter,
    /// Her package brings no world, or her settings do not run it.
    NoWorld,
    /// No place of the world holds a thing of that id.
    UnknownThing,
}
