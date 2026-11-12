//! What a view of an app shows, read from what its script answered into
//! the wire's screen: one piece of data, which the person's window draws
//! and she reads, in the pieces the phone knows by name.

use std::ops::RangeInclusive;

use p02_shared::{Credentials, JsonLimits, bound_json};
use p02_wire::{Screen, ScreenItem, ScreenRange, ScreenRow};
use serde_json::Value;

use crate::manifest::is_blank;
use crate::net::URL_CHARS;

/// How many cells a strip holds.
const CELLS: RangeInclusive<usize> = 2..=8;
/// How many rows ranges hold.
const RANGES: RangeInclusive<usize> = 1..=10;
/// The top of the scale the bars of ranges share.
const SCALE: u32 = 100;

/// The screen `shown` is, once it keeps within the JSON limits and holds
/// only pieces and fields the phone knows, by the rules of each; otherwise
/// why not.
pub(crate) fn read(shown: Value) -> Result<Screen, String> {
    let shown = bound_json(shown, "screen", JsonLimits::default(), Credentials::Keep)
        .map_err(|problem| problem.to_string())?;
    let screen: Screen = serde_json::from_value(shown).map_err(|problem| problem.to_string())?;

    match screen.items.iter().find_map(broken) {
        Some(rule) => Err(rule.to_owned()),
        None => Ok(screen),
    }
}

/// The rule `item` breaks, if it breaks one.
fn broken(item: &ScreenItem) -> Option<&'static str> {
    match item {
        ScreenItem::List { rows, .. } => rows.iter().find_map(broken_row),
        ScreenItem::Strip { cells } => (!CELLS.contains(&cells.len()))
            .then_some("a strip has fewer than 2 cells or more than 8"),
        ScreenItem::Ranges { rows } if !RANGES.contains(&rows.len()) => {
            Some("ranges have no row or more than 10")
        }
        ScreenItem::Ranges { rows } => rows.iter().find_map(broken_range),
        ScreenItem::Bubble { text, .. } => is_blank(text).then_some("a bubble's `text` is blank"),
        ScreenItem::Readout { .. }
        | ScreenItem::Text { .. }
        | ScreenItem::App { .. }
        | ScreenItem::Glance { .. }
        | ScreenItem::Field { .. }
        | ScreenItem::Note { .. } => None,
    }
}

fn broken_row(row: &ScreenRow) -> Option<&'static str> {
    let addressed = |url: &str| {
        (url.starts_with("https://") || url.starts_with("http://"))
            && url.chars().count() <= URL_CHARS
    };

    if row.title.is_none() && row.time.is_none() {
        Some("a row of a list has neither a title nor a time")
    } else if row.url.as_deref().is_some_and(|url| !addressed(url)) {
        Some("a row's `url` is not an https:// or http:// address of 2,048 characters at most")
    } else {
        None
    }
}

fn broken_range(range: &ScreenRange) -> Option<&'static str> {
    if range.from > SCALE || range.to > SCALE {
        Some("a range's `from` or `to` is past 100")
    } else if range.from > range.to {
        Some("a range's `from` is past its `to`")
    } else {
        None
    }
}
