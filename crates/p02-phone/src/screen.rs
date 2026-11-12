//! What a view of an app shows, read from what its script answered into
//! the wire's screen: one piece of data, which the person's window draws
//! and she reads, in the pieces the phone knows by name.

use p02_shared::{Credentials, JsonLimits, bound_json};
use p02_wire::{Screen, ScreenItem};
use serde_json::Value;

/// The screen `shown` is, once it keeps within the JSON limits and holds
/// only pieces and fields the phone knows; otherwise why not.
pub(crate) fn read(shown: Value) -> Result<Screen, String> {
    let shown = bound_json(shown, "screen", JsonLimits::default(), Credentials::Keep)
        .map_err(|problem| problem.to_string())?;
    let screen: Screen = serde_json::from_value(shown).map_err(|problem| problem.to_string())?;
    let untitled = screen.items.iter().any(|item| match item {
        ScreenItem::List { rows, .. } => rows
            .iter()
            .any(|row| row.title.is_none() && row.time.is_none()),
        ScreenItem::Readout { .. } | ScreenItem::Text { .. } => false,
    });

    if untitled {
        Err("a row of a list has neither a title nor a time".to_owned())
    } else {
        Ok(screen)
    }
}
