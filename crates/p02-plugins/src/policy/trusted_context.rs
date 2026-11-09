use p02_contracts::{AccessLevel, AccessMap, AccessName, ContextItem, ContextItemKind};

/// Whether the item reaches the trusted frame: a runtime note, from a
/// plugin granted `trusted_context: write`. Every other item rides the
/// person's turn as untrusted input.
pub(crate) fn is_trusted_note(access: &AccessMap, item: &ContextItem) -> bool {
    item.kind() == ContextItemKind::RuntimeNote
        && access.grants(AccessName::TrustedContext, AccessLevel::Write)
}
