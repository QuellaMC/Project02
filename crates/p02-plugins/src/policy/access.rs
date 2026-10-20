use p02_contracts::{AccessLevel, AccessMap, AccessName, Hook, StoreAccess};

use crate::invoke::Invocation;

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

/// Whether an invocation only reads what its plugin is granted: a plugin
/// that is ending does, and so does an approval-gated call's preparation,
/// since what the call changes is its effect's, applied only on the
/// person's yes. Its store is then read-only, and it opens no database,
/// which has no read-only view.
pub(crate) fn only_reads(invocation: Invocation) -> bool {
    matches!(
        invocation,
        Invocation::Hook(Hook::OnShutdown) | Invocation::Preparation
    )
}
