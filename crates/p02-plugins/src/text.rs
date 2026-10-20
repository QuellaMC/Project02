use std::borrow::Cow;

pub(crate) const ELLIPSIS: &str = "...";

/// What a kept character may cost on average: the most a character of the
/// Basic Multilingual Plane takes in UTF-8. Every cap below is sized for
/// it, so a text of four-byte characters keeps fewer of them and an
/// output built from cut texts stays inside the JSON limits.
const BYTES_PER_CHARACTER: usize = 3;

/// `text` whole when it fits `max_chars` characters, otherwise cut at a
/// character and ended with an ellipsis, the whole within `max_chars`
/// characters and three bytes a character.
pub(crate) fn excerpt(text: &str, max_chars: usize) -> Cow<'_, str> {
    let max_bytes = max_chars * BYTES_PER_CHARACTER;

    if text.len() <= max_bytes && text.chars().count() <= max_chars {
        return Cow::Borrowed(text);
    }

    let kept_bytes = max_bytes.saturating_sub(ELLIPSIS.len());
    let end = text
        .char_indices()
        .take(max_chars.saturating_sub(ELLIPSIS.len()))
        .map(|(start, character)| start + character.len_utf8())
        .take_while(|&end| end <= kept_bytes)
        .last()
        .unwrap_or(0);

    Cow::Owned(format!("{}{ELLIPSIS}", &text[..end]))
}
