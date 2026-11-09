//! What the adapter speaks while the model writes: each native
//! `visible_reply` call's text, decoded from its arguments as they stream,
//! behind the reasoning filter the judge will scrub the whole with.
//! Content is never spoken: alone it is the reply and arrives whole at the
//! commit, and beside a tool call it is the model's note to itself, which
//! the prompt promises the person never hears; which of the two it is
//! cannot be known while it arrives.

use p02_contracts::{Invocation, ReasoningFilter, ReplyDelta, VISIBLE_REPLY};

use super::stream::Fragment;
use crate::prompt::{ToolNameMapping, runtime_name};

/// Follows one string field of a flat JSON object as its text arrives in
/// pieces, `{"text": "…"}`, decoding the value as far as the pieces reach:
/// an escape is decoded whole, a high surrogate waits for its pair, and
/// what is not that object, or comes after the value's closing quote, is
/// silence. The judge reads the whole object later; this reads ahead.
#[derive(Debug)]
pub(super) struct FieldScanner {
    field: &'static str,
    state: State,
    pending: String,
    high_surrogate: Option<u16>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Brace,
    Key,
    Colon,
    Quote,
    Value,
    Done,
}

impl FieldScanner {
    pub(super) fn new(field: &'static str) -> Self {
        Self {
            field,
            state: State::Brace,
            pending: String::new(),
            high_surrogate: None,
        }
    }

    /// The value's next decoded characters, as far as `piece` reaches.
    pub(super) fn push(&mut self, piece: &str) -> String {
        self.pending.push_str(piece);

        loop {
            let read_on = match self.state {
                State::Brace => self.expect('{', State::Key),
                State::Key => self.read_key(),
                State::Colon => self.expect(':', State::Quote),
                State::Quote => self.expect('"', State::Value),
                State::Value => return self.read_value(),
                State::Done => {
                    self.pending.clear();
                    return String::new();
                }
            };

            if !read_on {
                return String::new();
            }
        }
    }

    /// Whether there was anything to read: `expected` moves on to `next`,
    /// anything else ends the scan.
    fn expect(&mut self, expected: char, next: State) -> bool {
        self.skip_blank();

        let Some(first) = self.pending.chars().next() else {
            return false;
        };

        if first == expected {
            self.pending.drain(..first.len_utf8());
            self.state = next;
        } else {
            self.state = State::Done;
        }

        true
    }

    fn read_key(&mut self) -> bool {
        self.skip_blank();

        if self.pending.is_empty() {
            return false;
        }

        let Some(rest) = self.pending.strip_prefix('"') else {
            self.state = State::Done;
            return true;
        };
        let Some(close) = rest.find('"') else {
            return false;
        };
        // An escaped key is not the plain one the field is named by.
        let key = &rest[..close];

        self.state = if key == self.field && !key.contains('\\') {
            State::Colon
        } else {
            State::Done
        };
        self.pending.drain(..close + 2);
        true
    }

    /// Decodes the value until the pieces run out, it closes, or an escape
    /// is cut.
    fn read_value(&mut self) -> String {
        let mut decoded = String::new();

        loop {
            let mut characters = self.pending.chars();
            let Some(first) = characters.next() else {
                break;
            };

            if first == '"' {
                self.pending.clear();
                self.state = State::Done;
                break;
            }

            if first != '\\' {
                self.orphan_into(&mut decoded);
                decoded.push(first);
                self.pending.drain(..first.len_utf8());
                continue;
            }

            let Some(escaped) = characters.next() else {
                break;
            };

            if escaped == 'u' {
                let hex: String = characters.take(4).collect();

                if hex.chars().count() < 4 {
                    break;
                }

                let unit = hex
                    .chars()
                    .all(|digit| digit.is_ascii_hexdigit())
                    .then(|| u16::from_str_radix(&hex, 16).ok())
                    .flatten();
                let Some(unit) = unit else {
                    self.pending.clear();
                    self.state = State::Done;
                    break;
                };

                self.pending.drain(..6);
                self.unit_into(unit, &mut decoded);
                continue;
            }

            let simple = match escaped {
                '"' => '"',
                '\\' => '\\',
                '/' => '/',
                'b' => '\u{8}',
                'f' => '\u{c}',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                _ => {
                    self.pending.clear();
                    self.state = State::Done;
                    break;
                }
            };

            self.orphan_into(&mut decoded);
            decoded.push(simple);
            self.pending.drain(..2);
        }

        decoded
    }

    /// A UTF-16 unit an escape spelled: a high surrogate waits for the low
    /// one it pairs with; a half that pairs with nothing is no character.
    fn unit_into(&mut self, unit: u16, decoded: &mut String) {
        if (0xd800..=0xdbff).contains(&unit) {
            self.orphan_into(decoded);
            self.high_surrogate = Some(unit);
            return;
        }

        let units: Vec<u16> = self
            .high_surrogate
            .take()
            .into_iter()
            .chain([unit])
            .collect();

        decoded.extend(
            char::decode_utf16(units)
                .map(|character| character.unwrap_or(char::REPLACEMENT_CHARACTER)),
        );
    }

    fn orphan_into(&mut self, decoded: &mut String) {
        if self.high_surrogate.take().is_some() {
            decoded.push(char::REPLACEMENT_CHARACTER);
        }
    }

    fn skip_blank(&mut self) {
        let blank = self.pending.len() - self.pending.trim_start().len();

        self.pending.drain(..blank);
    }
}

#[derive(Debug)]
struct Draft {
    index: u64,
    reply: usize,
    filter: ReasoningFilter,
    scanner: FieldScanner,
}

/// The drafts of one round's replies: the n-th `visible_reply` call to
/// begin is reply n, each behind its own filter. Silent when no one
/// listens, since the invocation hears for no one then.
#[derive(Debug)]
pub(super) struct ReplyDrafts<'a> {
    invocation: Invocation<'a>,
    mappings: &'a [ToolNameMapping],
    drafts: Vec<Draft>,
}

impl<'a> ReplyDrafts<'a> {
    pub(super) fn new(invocation: Invocation<'a>, mappings: &'a [ToolNameMapping]) -> Self {
        Self {
            invocation,
            mappings,
            drafts: Vec::new(),
        }
    }

    pub(super) fn hear(&mut self, fragment: Fragment<'_>) {
        if runtime_name(fragment.name, self.mappings) != VISIBLE_REPLY {
            return;
        }

        let at = self
            .drafts
            .iter()
            .position(|draft| draft.index == fragment.index)
            .unwrap_or_else(|| {
                self.drafts.push(Draft {
                    index: fragment.index,
                    reply: self.drafts.len(),
                    filter: ReasoningFilter::new(),
                    scanner: FieldScanner::new("text"),
                });
                self.drafts.len() - 1
            });
        let draft = &mut self.drafts[at];
        let passed = draft.filter.push(&draft.scanner.push(fragment.text));

        if !passed.is_empty() {
            self.invocation.hear(ReplyDelta {
                reply: draft.reply,
                text: passed,
            });
        }
    }

    /// The message is whole: what each filter still held is text, a `<`
    /// that never became a tag.
    pub(super) fn finish(self) {
        for draft in self.drafts {
            let held = draft.filter.finish();

            if !held.is_empty() {
                self.invocation.hear(ReplyDelta {
                    reply: draft.reply,
                    text: held,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Texts and what the scanner decodes of them, whole or in any pieces.
    const CASES: [(&str, &str); 10] = [
        ("{\"text\": \"hello\"}", "hello"),
        (
            "{\"text\":\"a\\\"b\\\\c\\/d\\n\\t\\b\\f\\r\"}",
            "a\"b\\c/d\n\t\u{8}\u{c}\r",
        ),
        ("{ \"text\" : \"caf\\u00e9 \\ud83d\\ude00!\" }", "café 😀!"),
        ("{\"text\": \"done\"} and whatever follows", "done"),
        ("{\"other\": \"x\", \"text\": \"y\"}", ""),
        ("{\"text\": 5}", ""),
        ("{\"text\": \"bad \\q escape\"}", "bad "),
        ("{\"te\\u0078t\": \"escaped key\"}", ""),
        ("not json at all", ""),
        ("", ""),
    ];

    fn scanned(pieces: &[&str]) -> String {
        let mut scanner = FieldScanner::new("text");

        pieces.iter().map(|piece| scanner.push(piece)).collect()
    }

    #[test]
    fn a_field_reads_the_same_whole_and_cut_at_every_character() {
        for (text, expected) in CASES {
            assert_eq!(scanned(&[text]), expected, "{text:?}");

            for (cut, _) in text.char_indices().skip(1) {
                assert_eq!(
                    scanned(&[&text[..cut], &text[cut..]]),
                    expected,
                    "{text:?} cut at {cut}"
                );
            }

            let characters: Vec<String> = text.chars().map(String::from).collect();
            let pieces: Vec<&str> = characters.iter().map(String::as_str).collect();

            assert_eq!(scanned(&pieces), expected, "{text:?} a character at a time");
        }
    }

    #[test]
    fn a_cut_escape_and_a_high_surrogate_wait_until_they_are_whole() {
        let mut scanner = FieldScanner::new("text");

        assert_eq!(scanner.push("{\"text\":\"a\\u00"), "a");
        assert_eq!(scanner.push("e9\\ud8"), "é");
        assert_eq!(scanner.push("3d"), "");
        assert_eq!(scanner.push("\\ude00 b"), "😀 b");
        assert_eq!(scanner.push("\\ud83dc\"}"), "\u{fffd}c");
        assert_eq!(scanner.push("{\"text\":\"again\"}"), "");
    }
}
