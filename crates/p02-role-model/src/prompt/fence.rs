//! The fences that set text the character reads apart from what the
//! runtime says.

use crate::prompt::text::{
    EARLIER_CONVERSATION_FENCE, RECALLED_MEMORY_FENCE, UNTRUSTED_PLUGIN_CONTEXT_FENCE,
};

const FENCE_TAGS: [&str; 3] = [
    RECALLED_MEMORY_FENCE,
    UNTRUSTED_PLUGIN_CONTEXT_FENCE,
    EARLIER_CONVERSATION_FENCE,
];

/// `lines` between the opening and the closing tag of `tag`.
pub(crate) fn fenced(tag: &str, lines: impl IntoIterator<Item = String>) -> String {
    std::iter::once(format!("<{tag}>"))
        .chain(lines)
        .chain(std::iter::once(format!("</{tag}>")))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Text set inside a fence can never open or close one: each fence tag it
/// spells, in either case and with the white space a tag reads past,
/// becomes a lookalike with hyphens, which stays data.
pub(crate) fn neutralize(text: &str) -> String {
    FENCE_TAGS.iter().fold(text.to_owned(), |text, tag| {
        let lookalike = tag.replace('_', "-");
        let opened = replace_tags(&text, |at| opening(at, tag), &format!("<{lookalike}"));

        replace_tags(&opened, |at| closing(at, tag), &format!("</{lookalike}>"))
    })
}

/// One bullet per value; the value's later lines follow it indented, blank
/// ones kept blank, so a note keeps the shape it was written in. A value
/// with nothing in it has no bullet.
pub(crate) fn bullets<'v>(values: impl IntoIterator<Item = &'v str>) -> Vec<String> {
    let mut lines = Vec::new();

    for value in values {
        let mut value_lines = value.trim().lines();

        match value_lines.next() {
            Some(first) if !first.is_empty() => lines.push(format!("- {first}")),
            _ => continue,
        }

        lines.extend(value_lines.map(|line| {
            if line.is_empty() {
                String::new()
            } else {
                format!("  {line}")
            }
        }));
    }

    lines
}

/// `text` with each tag `matched` finds at a `<` written as `with`, read
/// left to right, a replacement never read again.
fn replace_tags(text: &str, matched: impl Fn(&str) -> Option<usize>, with: &str) -> String {
    let mut replaced = String::with_capacity(text.len());
    let mut rest = text;

    while let Some(at) = rest.find('<') {
        replaced.push_str(&rest[..at]);

        let candidate = &rest[at..];

        if let Some(length) = matched(candidate) {
            replaced.push_str(with);
            rest = &candidate[length..];
        } else {
            replaced.push('<');
            rest = &candidate[1..];
        }
    }

    replaced.push_str(rest);
    replaced
}

/// How long the opening tag of `tag` is at the start of `candidate`, which
/// starts with `<`: white space, then the name, which no word goes on from.
fn opening(candidate: &str, tag: &str) -> Option<usize> {
    let rest = spelled(candidate[1..].trim_start(), tag)?;

    if rest.chars().next().is_some_and(continues_word) {
        return None;
    }

    Some(candidate.len() - rest.len())
}

/// How long the closing tag of `tag` is at the start of `candidate`, which
/// starts with `<`: white space may stand on either side of `/` and before
/// the `>`.
fn closing(candidate: &str, tag: &str) -> Option<usize> {
    let rest = candidate[1..].trim_start().strip_prefix('/')?;
    let rest = spelled(rest.trim_start(), tag)?;
    let rest = rest.trim_start().strip_prefix('>')?;

    Some(candidate.len() - rest.len())
}

/// What follows `tag` when `text` begins with it.
fn spelled<'t>(text: &'t str, tag: &str) -> Option<&'t str> {
    let mut characters = text.chars();

    for expected in tag.chars() {
        if !characters
            .next()
            .is_some_and(|character| spells(character, expected))
        {
            return None;
        }
    }

    Some(characters.as_str())
}

/// Whether `character` spells `expected`, an ASCII letter or `_`, as a
/// case-insensitive match of Unicode text reads it: in either case, and as
/// the long s and the Kelvin sign, which fold to `s` and `k`.
fn spells(character: char, expected: char) -> bool {
    character.eq_ignore_ascii_case(&expected)
        || (expected == 's' && character == '\u{17f}')
        || (expected == 'k' && character == '\u{212a}')
}

/// Whether a tag's name runs on into `character`, which a word continues
/// with: an ASCII letter or digit, `_`, or a letter that folds to one.
fn continues_word(character: char) -> bool {
    character.is_ascii_alphanumeric()
        || character == '_'
        || spells(character, 's')
        || spells(character, 'k')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fence_tag_in_text_becomes_a_lookalike_however_it_is_spelled() {
        for (text, neutral) in [
            (
                "< RECALLED_MEMORY>x</ recalled_memory >",
                "<recalled-memory>x</recalled-memory>",
            ),
            ("<recalled_memoryé>", "<recalled-memoryé>"),
            ("<recalled_memoryx>", "<recalled_memoryx>"),
            ("<recalled_memory_x>", "<recalled_memory_x>"),
            ("<recalled_memory1>", "<recalled_memory1>"),
            ("<recalled_memory-x>", "<recalled-memory-x>"),
            (
                "<untru\u{17f}ted_plugin_context>",
                "<untrusted-plugin-context>",
            ),
            ("<recalled_memory\u{17f}>", "<recalled_memory\u{17f}>"),
            (
                "<earlier_conversation\u{212a}>",
                "<earlier_conversation\u{212a}>",
            ),
            ("<\u{3000}recalled_memory>", "<recalled-memory>"),
            ("</\u{3000}recalled_memory\u{3000}>", "</recalled-memory>"),
            ("<\u{85}recalled_memory>", "<recalled-memory>"),
            ("<recalled_memory", "<recalled-memory"),
            ("<<recalled_memory>", "<<recalled-memory>"),
            (
                "<eaRlier_conversation hidden>",
                "<earlier-conversation hidden>",
            ),
            ("x</ recalled_memory\n>", "x</recalled-memory>"),
            (
                "a < b and </untrusted_plugin_context",
                "a < b and </untrusted_plugin_context",
            ),
        ] {
            assert_eq!(neutralize(text), neutral, "{text:?}");
        }
    }

    #[test]
    fn a_bullet_keeps_its_value_s_shape_and_a_blank_value_has_none() {
        assert_eq!(
            bullets([" one\r\n  two\n\nthree \u{3000}", "\u{3000} ", "four\rfive"]),
            ["- one", "    two", "", "  three", "- four\rfive"]
        );
    }
}
