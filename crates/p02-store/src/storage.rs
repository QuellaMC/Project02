//! What a character's plugins reach of her data: her committed
//! conversations, and under `plugin-data/<plugin>/` each plugin's own files
//! and databases. A handle is made without touching the disk, so a
//! capability nobody uses touches no file.

use std::sync::Arc;

use p02_contracts::{CharacterStorage, DatabaseOpener, FileStoreBackend, SessionHistoryFeed};
use p02_shared::Identifier;

use crate::character_data::CharacterData;
use crate::database::PluginDatabases;
use crate::feed::HistoryFeed;
use crate::plugin_files::PluginFiles;

impl CharacterStorage for CharacterData {
    fn session_history(&self) -> Arc<dyn SessionHistoryFeed> {
        Arc::new(HistoryFeed::new(self.clone()))
    }

    fn file_store(&self, plugin_id: &Identifier) -> Arc<dyn FileStoreBackend> {
        Arc::new(PluginFiles::new(self.clone(), plugin_id.clone()))
    }

    fn databases(&self, plugin_id: &Identifier) -> Arc<dyn DatabaseOpener> {
        Arc::new(PluginDatabases::new(self.clone(), plugin_id.clone()))
    }
}
