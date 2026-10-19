use p02_contracts::{AccessLevel, AccessMap, AccessName, Hook, StoreAccess};

/// The capabilities an access map grants a plugin's hooks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Grants {
    pub(crate) turn_text: bool,
    pub(crate) file_store: Option<StoreAccess>,
    pub(crate) session_history: bool,
    pub(crate) databases: bool,
}

pub(crate) fn grants(access: &AccessMap) -> Grants {
    let file_store = if access.grants(AccessName::CharacterFileStore, AccessLevel::Write) {
        Some(StoreAccess::ReadWrite)
    } else if access.grants(AccessName::CharacterFileStore, AccessLevel::Read) {
        Some(StoreAccess::ReadOnly)
    } else {
        None
    };

    Grants {
        turn_text: access.grants(AccessName::TurnContext, AccessLevel::Read),
        file_store,
        session_history: access.grants(AccessName::SessionHistory, AccessLevel::Read),
        databases: access.grants(AccessName::PluginDatabase, AccessLevel::Write),
    }
}

/// What one hook may do with a store the plugin is granted: a plugin
/// that is ending only reads.
pub(crate) fn hook_store_access(granted: StoreAccess, hook: Hook) -> StoreAccess {
    if hook == Hook::OnShutdown {
        StoreAccess::ReadOnly
    } else {
        granted
    }
}
