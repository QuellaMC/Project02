use std::fmt;
use std::sync::Arc;

use p02_shared::Identifier;

use crate::capability::{DatabaseOpener, FileStoreBackend, SessionHistoryFeed};

/// One character's storage as its plugins reach it: the character's
/// session history, and each plugin's own store and databases. The store
/// crate implements it; the host asks it once for every capability a
/// plugin is granted, and every handle is lazy, so a capability nobody
/// uses touches no file.
pub trait CharacterStorage: Send + Sync + fmt::Debug {
    /// The character's committed conversations (`session_history`).
    fn session_history(&self) -> Arc<dyn SessionHistoryFeed>;

    /// The plugin's character-scoped store (`character_file_store`).
    fn file_store(&self, plugin_id: &Identifier) -> Arc<dyn FileStoreBackend>;

    /// The plugin's own databases (`plugin_database`).
    fn databases(&self, plugin_id: &Identifier) -> Arc<dyn DatabaseOpener>;
}
