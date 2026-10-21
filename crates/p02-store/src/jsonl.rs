//! A file of JSON lines: a line counts once its newline is on disk, so text
//! after the last newline is an append a crash cut short and is no line,
//! while a line before it that is not what it should be is damage.

/// The committed lines of `bytes`, without their newlines, each numbered
/// from 1.
pub(crate) fn committed_lines(bytes: &[u8]) -> impl Iterator<Item = (usize, &[u8])> {
    let end = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |at| at + 1);

    bytes[..end]
        .split_inclusive(|byte| *byte == b'\n')
        .map(|line| &line[..line.len() - 1])
        .enumerate()
        .map(|(index, line)| (index + 1, line))
}

/// Whether `bytes` holds a committed line at all.
pub(crate) fn holds_a_line(bytes: &[u8]) -> bool {
    bytes.contains(&b'\n')
}
