//! The names of everything a home holds, each spelled once.

use std::fmt;

pub(crate) const SCHEMA_FILE: &str = "schema.json";
pub(crate) const CONFIG_FILE: &str = "config.json";
pub(crate) const LOCKS_DIRECTORY: &str = ".locks";
pub(crate) const CHARACTER_DATA_DIRECTORY: &str = "character-data";
pub(crate) const CONVERSATIONS_DIRECTORY: &str = "conversations";
pub(crate) const CONVERSATION_FILE: &str = "conversation.json";
pub(crate) const SESSION_CATALOG_FILE: &str = "sessions.jsonl";
pub(crate) const SESSIONS_DIRECTORY: &str = "sessions";
pub(crate) const RAW_EVENTS_FILE: &str = "raw-events.jsonl";
pub(crate) const TAKEN_LINES_DIRECTORY: &str = "taken-lines";
pub(crate) const PLUGIN_DATA_DIRECTORY: &str = "plugin-data";
pub(crate) const DATABASE_SUFFIX: &str = ".sqlite";
/// What SQLite keeps beside a database in write-ahead-log mode, each named
/// by the database's name and this.
pub(crate) const DATABASE_COMPANIONS: [&str; 2] = ["-wal", "-shm"];

/// What Finder leaves in every folder it shows: never evidence, and never
/// in the way.
pub(crate) const FINDER_METADATA: &str = ".DS_Store";

/// What a control entry of a home must really be: a link there would carry
/// the state it holds outside the directory its marker vouches for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Directory,
}

impl fmt::Display for EntryKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::File => "file",
            Self::Directory => "directory",
        })
    }
}
