/// The one grammar for the reasoning a model leaks into its text. A block
/// opens on `<think …>` or `<reasoning …>`, in any case and with any blank
/// space and attributes, and closes on the first bare closing tag of the
/// same name; the block is dropped whole, nested tags and all. A tag outside
/// any block, or a block never closed, is a leak the text cannot be cleaned
/// of. What is taken out is read as never written: the text on its two
/// sides is read again as one, so no tag is spelled across it, and what the
/// filter passes reads back as itself. The filter reads the text as it
/// arrives, so a draft can be shown while the model still writes.
#[derive(Debug, Default)]
pub struct ReasoningFilter {
    buffer: String,
    open_block: Option<&'static str>,
    /// The start of a would-be tag that the open block began inside, read
    /// again in front of what follows the block.
    cut: String,
    stray: bool,
}

/// The text holds a reasoning tag outside any block, or a block that never
/// closes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("the text leaks reasoning: a reasoning tag outside a block, or a block never closed")]
pub struct ReasoningLeakError;

const TAG_NAMES: [&str; 2] = ["think", "reasoning"];

enum TagMatch {
    Tag {
        /// Just past the closing `>`.
        end: usize,
        closing: bool,
        name: &'static str,
        /// Only blank space between the name and the `>`: the one shape
        /// that closes a block.
        bare: bool,
    },
    /// A would-be tag cut off by another `<`, at `at`, before it could be
    /// told from text.
    Split {
        at: usize,
    },
    Partial,
    None,
}

enum NameMatch {
    Found(&'static str),
    /// Another `<` begins this far in, where the name had more to match.
    Cut(usize),
    Partial,
    Absent,
}

impl ReasoningFilter {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes the next piece of text and returns what of it lies outside
    /// reasoning blocks; what could still open or close one is held until
    /// it cannot.
    pub fn push(&mut self, text: &str) -> String {
        self.buffer.push_str(text);

        let mut passed = String::new();
        let mut cursor = 0;

        loop {
            let Some(offset) = self.buffer[cursor..].find('<') else {
                if self.open_block.is_none() {
                    passed.push_str(&self.buffer[cursor..]);
                }

                self.buffer.clear();
                return passed;
            };
            let tag_start = cursor + offset;

            if self.open_block.is_none() {
                passed.push_str(&self.buffer[cursor..tag_start]);
            }

            // Inside a block nothing is read but its closing tag, so only
            // outside one does a would-be tag wait for the tag that cuts it.
            let (start, found) = match match_tag(&self.buffer, tag_start) {
                TagMatch::Split { at } if self.open_block.is_none() => {
                    cutting_tag(&self.buffer, at)
                }
                found => (tag_start, found),
            };

            match found {
                TagMatch::Partial => {
                    self.buffer.drain(..tag_start);
                    return passed;
                }
                TagMatch::None | TagMatch::Split { .. } => {
                    if self.open_block.is_none() {
                        passed.push('<');
                    }

                    cursor = tag_start + 1;
                }
                TagMatch::Tag {
                    end,
                    closing,
                    name,
                    bare,
                } => match self.open_block {
                    None => {
                        self.cut = self.buffer[tag_start..start].to_owned();

                        if closing {
                            self.stray = true;
                            self.read_on_after(end);
                            cursor = 0;
                        } else {
                            self.open_block = Some(name);
                            cursor = end;
                        }
                    }
                    Some(open) if closing && bare && name == open => {
                        self.open_block = None;
                        self.read_on_after(end);
                        cursor = 0;
                    }
                    Some(_) => cursor = end,
                },
            }
        }
    }

    /// Drops the text up to `end`, where a tag taken out ends, and puts the
    /// would-be tag it cut off back in front of the rest, to be read again.
    fn read_on_after(&mut self, end: usize) {
        let cut = std::mem::take(&mut self.cut);

        self.buffer.replace_range(..end, &cut);
    }

    /// Releases what was held as text, a `<` that never became a tag.
    ///
    /// # Errors
    ///
    /// [`ReasoningLeakError`] when a block was left open or a tag stood
    /// outside any block.
    pub fn finish(self) -> Result<String, ReasoningLeakError> {
        if self.open_block.is_some() || self.stray {
            Err(ReasoningLeakError)
        } else {
            Ok(self.buffer)
        }
    }
}

/// The text with its reasoning blocks dropped.
///
/// # Errors
///
/// [`ReasoningLeakError`] when the text leaks reasoning it cannot be
/// cleaned of.
pub fn scrub_reasoning_blocks(text: &str) -> Result<String, ReasoningLeakError> {
    let mut filter = ReasoningFilter::new();
    let passed = filter.push(text);

    filter.finish().map(|held| passed + &held)
}

fn match_tag(buffer: &str, start: usize) -> TagMatch {
    let mut index = skip_blank(buffer, start + 1);

    if index == buffer.len() {
        return TagMatch::Partial;
    }

    let closing = buffer.as_bytes()[index] == b'/';

    if closing {
        index = skip_blank(buffer, index + 1);
    }

    let name = match match_tag_name(&buffer.as_bytes()[index..]) {
        NameMatch::Found(name) => name,
        NameMatch::Cut(offset) => return TagMatch::Split { at: index + offset },
        NameMatch::Partial => return TagMatch::Partial,
        NameMatch::Absent => return TagMatch::None,
    };

    index += name.len();

    // Only blank space, `/` or `>` ends a tag's name: `<thinking>` and
    // `<think-aloud>` are other tags.
    match buffer[index..].chars().next() {
        None => return TagMatch::Partial,
        Some('<') => return TagMatch::Split { at: index },
        Some(next) if next.is_whitespace() || next == '/' || next == '>' => {}
        Some(_) => return TagMatch::None,
    }

    let Some(offset) = buffer[index..].find('>') else {
        return TagMatch::Partial;
    };
    let tag_end = index + offset;

    TagMatch::Tag {
        end: tag_end + 1,
        closing,
        name,
        bare: buffer[index..tag_end].trim().is_empty(),
    }
}

/// The tag that cuts off a run of would-be tags, each cut off by the next,
/// and where it starts.
fn cutting_tag(buffer: &str, mut at: usize) -> (usize, TagMatch) {
    loop {
        match match_tag(buffer, at) {
            TagMatch::Split { at: next } => at = next,
            found => return (at, found),
        }
    }
}

fn match_tag_name(available: &[u8]) -> NameMatch {
    for name in TAG_NAMES {
        let matched = available
            .iter()
            .zip(name.as_bytes())
            .take_while(|(byte, expected)| byte.eq_ignore_ascii_case(expected))
            .count();

        if matched == name.len() {
            return NameMatch::Found(name);
        }

        match available.get(matched) {
            None => return NameMatch::Partial,
            Some(b'<') => return NameMatch::Cut(matched),
            Some(_) => {}
        }
    }

    NameMatch::Absent
}

fn skip_blank(buffer: &str, start: usize) -> usize {
    buffer[start..]
        .char_indices()
        .find(|(_, character)| !character.is_whitespace())
        .map_or(buffer.len(), |(offset, _)| start + offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The grammar, whole: what the decision parser and the adapters rely on.
    const CASES: [(&str, Result<&str, ReasoningLeakError>); 19] = [
        ("<think>plan</think>Hello", Ok("Hello")),
        ("a <reasoning kind=\"x\">\nplan\n</reasoning> b", Ok("a  b")),
        ("<THINK>plan</Think>Hello", Ok("Hello")),
        ("< think >plan</ think >Hello", Ok("Hello")),
        ("<think>a<think>b</think>c", Ok("c")),
        ("<think>a</reasoning>b</think>c", Ok("c")),
        ("<thinking>x</thinking>", Ok("<thinking>x</thinking>")),
        (
            "<think-aloud>a</think-aloud> <reasoning:note>b</reasoning:note>",
            Ok("<think-aloud>a</think-aloud> <reasoning:note>b</reasoning:note>"),
        ),
        ("x < y and a<b", Ok("x < y and a<b")),
        ("3 <<think>check</think> 5", Ok("3 < 5")),
        ("<th<think>a</think>ink>b</think>c", Ok("c")),
        ("<<think>plan</think>think>secret", Err(ReasoningLeakError)),
        ("<thin", Ok("<thin")),
        ("plain text", Ok("plain text")),
        ("<think>still thinking about it", Err(ReasoningLeakError)),
        ("<think/>", Err(ReasoningLeakError)),
        ("a </think> b", Err(ReasoningLeakError)),
        ("<think>a</think>b</think>", Err(ReasoningLeakError)),
        ("<think>a</think foo>b", Err(ReasoningLeakError)),
    ];

    #[test]
    fn the_grammar_reads_text_the_same_whole_and_at_every_split_point() {
        for (input, expected) in CASES {
            let expected = expected.map(str::to_owned);

            assert_eq!(scrub_reasoning_blocks(input), expected, "{input:?}");

            if let Ok(clean) = &expected {
                assert_eq!(
                    scrub_reasoning_blocks(clean).as_ref(),
                    Ok(clean),
                    "{input:?}"
                );
            }

            for split in (0..=input.len()).filter(|&split| input.is_char_boundary(split)) {
                let mut filter = ReasoningFilter::new();
                let passed = filter.push(&input[..split]) + &filter.push(&input[split..]);

                assert_eq!(
                    filter.finish().map(|held| passed + &held),
                    expected,
                    "{input:?} split at {split}"
                );
            }
        }
    }

    #[test]
    fn text_before_a_tag_passes_at_once_and_only_a_possible_tag_is_held() {
        let mut filter = ReasoningFilter::new();

        assert_eq!(filter.push("hello <thi"), "hello ");
        assert_eq!(filter.push("nk>hid"), "");
        assert_eq!(filter.push("den</think> wor"), " wor");
        assert_eq!(filter.push("ld <"), "ld ");
        assert_eq!(filter.push("3"), "<3");
        assert_eq!(filter.finish(), Ok(String::new()));

        let mut held = ReasoningFilter::new();

        assert_eq!(held.push("a <thin"), "a ");
        assert_eq!(held.finish(), Ok("<thin".to_owned()));

        let mut open = ReasoningFilter::new();

        assert_eq!(open.push("a <think>b</thi"), "a ");
        assert_eq!(open.finish(), Err(ReasoningLeakError));

        let mut spelled = ReasoningFilter::new();

        assert_eq!(spelled.push("a <<think>plan</think>"), "a ");
        assert_eq!(spelled.push("think>secret"), "");
        assert_eq!(spelled.finish(), Err(ReasoningLeakError));

        let mut stray = ReasoningFilter::new();

        assert_eq!(stray.push("a <th</think>ink>secret"), "a ");
        assert_eq!(stray.finish(), Err(ReasoningLeakError));
    }
}
