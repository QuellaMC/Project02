use std::collections::BTreeSet;

use p02_contracts::{
    AccessLevel, AccessMap, AccessName, ContextItem, ContextItemKind, PluginContextItem,
    PluginCuratedSection, contains_forbidden_control_character,
};
use p02_shared::Identifier;

/// How much of one kind of entry the trusted frame holds from one plugin.
#[derive(Clone, Copy)]
struct Cap {
    label: &'static str,
    noun: &'static str,
    entries: usize,
    chars: usize,
}

const RUNTIME_NOTES: Cap = Cap {
    label: "runtime notes",
    noun: "note",
    entries: 4,
    chars: 2_048,
};

const CURATED_CONTEXT: Cap = Cap {
    label: "curated context",
    noun: "section",
    entries: 4,
    chars: 8_192,
};

/// Whether the item reaches the trusted frame: a runtime note, from a
/// plugin granted `trusted_context: write`. Every other item rides the
/// person's turn as untrusted input.
pub(crate) fn is_trusted_note(access: &AccessMap, item: &ContextItem) -> bool {
    item.kind() == ContextItemKind::RuntimeNote
        && access.grants(AccessName::TrustedContext, AccessLevel::Write)
}

/// The first cap a plugin's trusted contribution breaks. The trusted frame
/// shows its entries whole or not at all, so a breach fails the plugin
/// rather than cutting what it said.
pub(crate) fn cap_breach(
    plugin_id: &Identifier,
    notes: &[PluginContextItem],
    sections: &[PluginCuratedSection],
) -> Option<String> {
    RUNTIME_NOTES
        .breach(
            plugin_id,
            notes
                .iter()
                .map(|note| (note.item().id(), note.item().text())),
        )
        .or_else(|| {
            notes
                .iter()
                .find(|note| contains_forbidden_control_character(note.item().text()))
                .map(|note| {
                    format!(
                        "Plugin \"{plugin_id}\" runtime note \"{}\" contains control characters.",
                        note.item().id()
                    )
                })
        })
        .or_else(|| {
            CURATED_CONTEXT.breach(
                plugin_id,
                sections
                    .iter()
                    .map(|section| (section.section().id(), section.section().text())),
            )
        })
}

impl Cap {
    fn breach<'a>(
        self,
        plugin_id: &Identifier,
        entries: impl ExactSizeIterator<Item = (&'a Identifier, &'a str)>,
    ) -> Option<String> {
        let Self {
            label,
            noun,
            entries: limit,
            chars,
        } = self;

        if entries.len() > limit {
            return Some(format!(
                "Plugin \"{plugin_id}\" {label} exceeds the {limit}-{noun} limit."
            ));
        }

        let mut ids = BTreeSet::new();
        let mut total = 0;

        for (id, text) in entries {
            if !ids.insert(id) {
                return Some(format!(
                    "Plugin \"{plugin_id}\" {label} repeats {noun} id \"{id}\"."
                ));
            }

            total += text.chars().count();
        }

        (total > chars)
            .then(|| format!("Plugin \"{plugin_id}\" {label} exceeds the {chars}-character limit."))
    }
}
