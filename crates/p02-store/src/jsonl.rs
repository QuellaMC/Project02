//! A file of JSON lines: a line counts once its newline is on disk, so text
//! after the last newline is an append a crash cut short and is no line,
//! while a line before it that is not what it should be is damage. A file
//! of lines is read as it was at one moment, with what lies beside it.

use std::io;
use std::path::Path;

use p02_shared::{FileStamp, file_stamp, read_file};

use crate::error::StorageError;

/// The committed lines of `bytes`, without their newlines, each numbered
/// from 1.
pub(crate) fn committed_lines(bytes: &[u8]) -> impl Iterator<Item = (usize, &[u8])> {
    bytes[..committed_length(bytes)]
        .split_inclusive(|byte| *byte == b'\n')
        .map(|line| &line[..line.len() - 1])
        .enumerate()
        .map(|(index, line)| (index + 1, line))
}

/// How many of `bytes` the committed lines take up: everything up to the
/// last newline, and none of what follows it.
pub(crate) fn committed_length(bytes: &[u8]) -> usize {
    bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |at| at + 1)
}

/// Whether `bytes` holds a committed line at all.
pub(crate) fn holds_a_line(bytes: &[u8]) -> bool {
    bytes.contains(&b'\n')
}

/// The bytes of the file of lines at `path`, none when no line was ever
/// written to it.
pub(crate) fn read_lines(path: &Path) -> Result<Vec<u8>, StorageError> {
    match read_file(path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(source) => Err(StorageError::Read {
            path: path.to_path_buf(),
            source,
        }),
    }
}

/// What `read` makes of the file at `path`, and of what lies beside it, as
/// they were at one moment: the file's stamp is taken before and after, and
/// a read the two do not agree on is tried once more before it is given up
/// as raced. A read that failed while the file changed is tried again too,
/// since the change is what can fail it.
pub(crate) fn read_coherently<T>(
    path: &Path,
    read: impl Fn() -> Result<T, StorageError>,
) -> Result<(Option<FileStamp>, T), StorageError> {
    for _ in 0..2 {
        let before = file_stamp(path).map_err(StorageError::read(path))?;
        let read = read();
        let after = file_stamp(path).map_err(StorageError::read(path))?;

        if before == after {
            return read.map(|value| (after, value));
        }
    }

    Err(StorageError::ConcurrentWrite {
        path: path.to_path_buf(),
    })
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use p02_shared::{DanglingLinks, append_line, canonical_path};

    use super::*;

    /// storage.coherent-read: a read that meets a change to its file is tried once more, and one whose two attempts both race is refused `concurrent_write`
    #[test]
    fn a_read_the_file_changes_beneath_is_tried_again_once_then_refused() {
        let directory = tempfile::tempdir().unwrap();
        let root = canonical_path(directory.path(), DanglingLinks::Keep).unwrap();
        let path = root.join("raw-events.jsonl");
        let attempts = Cell::new(0);
        let changing = |changes: usize| {
            let attempts = &attempts;
            let path = &path;

            move || {
                attempts.set(attempts.get() + 1);

                let content = read_lines(path);

                if attempts.get() <= changes {
                    append_line(path, b"{}").unwrap();
                }

                content
            }
        };

        append_line(&path, b"{}").unwrap();

        let (stamp, content) = read_coherently(&path, changing(1)).unwrap();

        assert_eq!(attempts.get(), 2);
        assert_eq!(content, b"{}\n{}\n");
        assert_eq!(stamp, file_stamp(&path).unwrap());

        attempts.set(0);

        let raced = read_coherently(&path, changing(2)).unwrap_err();

        assert_eq!(attempts.get(), 2);
        assert_eq!(raced.code(), "concurrent_write");
    }
}
