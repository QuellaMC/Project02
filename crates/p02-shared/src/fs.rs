//! The fs seam: the one module that reaches the file system. Reads and
//! writes hand back the `io::Error` they met, because callers disagree about
//! what a failure means.
#![expect(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "this module is the fs seam every other module goes through"
)]

use std::ffi::{OsStr, OsString};
use std::fs::{self, File, FileType, OpenOptions, TryLockError};
use std::io::{self, Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use uuid::Uuid;

/// Reads the file at `path` as text, each invalid UTF-8 sequence becoming
/// U+FFFD rather than a refusal of the whole file.
///
/// # Errors
///
/// The `io::Error` the read failed with.
pub fn read_text_lossy(path: &Path) -> io::Result<String> {
    fs::read(path).map(String::from_utf8_lossy_owned)
}

/// Reads the whole file at `path` as it is on disk.
///
/// # Errors
///
/// The `io::Error` the read failed with.
pub fn read_file(path: &Path) -> io::Result<Vec<u8>> {
    fs::read(path)
}

/// Reads the file at `path` up to its first `limit` bytes, so a file that
/// should be small costs no more than that however large it is.
///
/// # Errors
///
/// The `io::Error` the open or the read failed with.
pub fn read_at_most(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();

    File::open(path)?
        .take(u64::try_from(limit).unwrap_or(u64::MAX))
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Replaces the file at `path` with `content`, owner-only, so that a reader
/// and a crash both see the old file or the new one, never a mix. The
/// directory must exist, and the caller must hold the lock that guards
/// `path`: every writer of a file holds it.
///
/// The content goes first to a sibling `.<name>.<uuid>.tmp`, flushed to disk
/// before the rename, and the directory after it. Because no other writer of
/// `path` can be at work while the caller holds its lock, a temporary of
/// `path` found beside it was left by a writer that died, and it is removed
/// first; nothing else in the directory is touched.
///
/// # Errors
///
/// The `io::Error` of the step that failed. The new temporary is removed
/// and the file at `path` is as it was.
pub fn write_file_atomically(path: &Path, content: &[u8]) -> io::Result<()> {
    let name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "a file to replace needs a name",
        )
    })?;

    remove_abandoned_temporaries(path, name)?;

    let temporary = path.with_file_name(temporary_name(name));
    let file = create_owner_only(&temporary)?;

    if let Err(error) = write_then_rename(file, content, &temporary, path) {
        remove_after_failure(&temporary);
        return Err(error);
    }

    sync_directory_of(path);
    Ok(())
}

/// Appends `line` and a newline to the file at `path`, creating the file
/// owner-only. The file is a sequence of lines each ending in a newline, so
/// text after its last newline is an append a crash cut short: it is cut
/// away first, and `line` follows the last whole one. The append is not
/// flushed to disk: a line counts once its newline is there, and a crash
/// before that loses it as it would have lost the call.
///
/// # Errors
///
/// `io::ErrorKind::InvalidInput` when `line` holds a newline; otherwise the
/// `io::Error` of the step that failed, which may leave part of the line
/// behind for the next append to cut.
pub fn append_line(path: &Path, line: &[u8]) -> io::Result<()> {
    if line.contains(&b'\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a line to append holds no newline",
        ));
    }

    let mut options = OpenOptions::new();

    options.read(true).write(true).create(true).truncate(false);
    owner_only(&mut options);

    let mut file = options.open(path)?;
    let whole = whole_lines_length(&mut file)?;

    if whole != file.metadata()?.len() {
        file.set_len(whole)?;
    }

    file.seek(SeekFrom::Start(whole))?;

    let mut bytes = Vec::with_capacity(line.len() + 1);

    bytes.extend_from_slice(line);
    bytes.push(b'\n');
    file.write_all(&bytes)
}

/// How many bytes of `file` its last newline ends, read back from the end.
fn whole_lines_length(file: &mut File) -> io::Result<u64> {
    const CHUNK: usize = 64 * 1_024;

    let mut end = file.metadata()?.len();
    let mut chunk = vec![0; CHUNK];

    while end > 0 {
        let size = usize::try_from(end).map_or(CHUNK, |end| end.min(CHUNK));
        let start = end - size as u64;

        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut chunk[..size])?;

        if let Some(at) = chunk[..size].iter().rposition(|byte| *byte == b'\n') {
            return Ok(start + at as u64 + 1);
        }

        end = start;
    }

    Ok(0)
}

/// What a file is at one moment, as far as a reader can tell without reading
/// it: two stamps of one path differ when it was written, cut or replaced
/// between them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
    #[cfg(windows)]
    created: Option<SystemTime>,
}

/// The stamp of the file at `path`, following a link at its end; `None`
/// when nothing is there.
///
/// # Errors
///
/// The `io::Error` the question failed with, but `NotFound`.
pub fn file_stamp(path: &Path) -> io::Result<Option<FileStamp>> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };

    Ok(Some(FileStamp {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(unix)]
        identity: {
            use std::os::unix::fs::MetadataExt as _;

            (
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            )
        },
        #[cfg(windows)]
        created: metadata.created().ok(),
    }))
}

/// Creates the directory at `path`, whose parent must exist, and flushes
/// its name into its parent, so a crash of the machine keeps it.
///
/// # Errors
///
/// `io::ErrorKind::AlreadyExists` when something is at `path`; otherwise
/// the `io::Error` the create failed with.
pub fn create_directory(path: &Path) -> io::Result<()> {
    fs::create_dir(path)?;
    sync_directory_of(path);
    Ok(())
}

/// Creates the directory at `path` and any parent missing above it, each
/// one made flushed into the directory above it, from the top down, so a
/// crash of the machine keeps every directory a later write is made in.
///
/// # Errors
///
/// The `io::Error` the create failed with; none when the directory exists.
pub fn create_directories(path: &Path) -> io::Result<()> {
    let missing: Vec<&Path> = path
        .ancestors()
        .take_while(|ancestor| matches!(describe_entry(ancestor), PathEntry::Absent))
        .collect();

    fs::create_dir_all(path)?;

    for made in missing.into_iter().rev() {
        sync_directory_of(made);
    }

    Ok(())
}

/// Empties the file at `path` in place, which takes no new file, so it
/// works where a replacement would not: on a full disk, or in a directory
/// that takes no new entry. The caller must hold the lock that guards
/// `path`. The truncation is not flushed to disk: a crash before it lands
/// leaves the file whole.
///
/// # Errors
///
/// The `io::Error` the open or the truncation failed with, `NotFound` when
/// nothing is there.
pub fn empty_file(path: &Path) -> io::Result<()> {
    OpenOptions::new().write(true).open(path)?.set_len(0)
}

/// Removes the file at `path`; a link there is removed, not followed.
/// Nothing there is no failure, so a removal a crash cut short can be done
/// again.
///
/// # Errors
///
/// The `io::Error` the removal failed with.
pub fn remove_file(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        removed => removed,
    }
}

/// Removes the directory at `path`, which must be empty.
///
/// # Errors
///
/// The `io::Error` the removal failed with, `NotFound` when nothing is
/// there.
pub fn remove_directory(path: &Path) -> io::Result<()> {
    fs::remove_dir(path)
}

/// An exclusive advisory lock on a file, held for as long as this value
/// lives. Any other handle is refused it, in this process or another, and
/// the operating system releases it when the process holding it dies.
#[derive(Debug)]
pub struct LockedFile(File);

impl Drop for LockedFile {
    /// Windows releases the lock of a closed handle in its own time, so it
    /// is released here first; the close that follows releases it anyway.
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

/// Takes the exclusive lock of the file at `path`, creating the file
/// owner-only if it is absent; `None` when another handle holds it. The
/// lock is the file's whole content, so nothing reads or writes the file
/// itself: Windows refuses that to every other handle while it is held.
///
/// # Errors
///
/// The `io::Error` the open or the lock failed with.
pub fn try_lock_file(path: &Path) -> io::Result<Option<LockedFile>> {
    let mut options = OpenOptions::new();

    options.read(true).write(true).create(true).truncate(false);
    owner_only(&mut options);

    let file = options.open(path)?;

    match file.try_lock() {
        Ok(()) => Ok(Some(LockedFile(file))),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

/// Creates the file at `path`, owner-only, with `content`, unless anything
/// is already there: the way to claim a name.
///
/// # Errors
///
/// `io::ErrorKind::AlreadyExists` when something is at `path`; otherwise
/// the `io::Error` that stopped the create or the write, which leaves no
/// partial file behind.
pub fn create_new_file(path: &Path, content: &[u8]) -> io::Result<()> {
    let mut file = create_owner_only(path)?;

    if let Err(error) = file.write_all(content) {
        drop(file);
        remove_after_failure(path);
        return Err(error);
    }

    Ok(())
}

/// What is at a path, read without following a link at its end.
#[derive(Debug)]
pub enum PathEntry {
    File,
    Directory,
    /// A symbolic link, whether or not its target exists; on Windows, a
    /// junction too.
    Link,
    /// A socket, a FIFO or a device.
    Other,
    /// Nothing is there. On Windows this includes a path under a file.
    Absent,
    /// The question itself failed; callers judge the error.
    Unreadable(io::Error),
}

/// Says what is at `path` without judging it: a link is not wrong in
/// itself, so the caller owns that policy.
#[must_use]
pub fn describe_entry(path: &Path) -> PathEntry {
    match fs::symlink_metadata(path) {
        Ok(metadata) => entry_of(metadata.file_type()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => PathEntry::Absent,
        Err(error) => PathEntry::Unreadable(error),
    }
}

/// The entries of the directory at `path`, in no particular order, each
/// named and described as [`describe_entry`] describes a path: a link among
/// them is not followed, though a link at `path` itself is.
///
/// # Errors
///
/// The `io::Error` the listing failed with, `NotFound` when nothing is at
/// `path` or a link there leads nowhere.
pub fn list_directory(path: &Path) -> io::Result<Vec<(OsString, PathEntry)>> {
    fs::read_dir(path)?
        .map(|entry| {
            let entry = entry?;
            let described = entry
                .file_type()
                .map_or_else(PathEntry::Unreadable, entry_of);

            Ok((entry.file_name(), described))
        })
        .collect()
}

fn entry_of(kind: FileType) -> PathEntry {
    if kind.is_symlink() {
        PathEntry::Link
    } else if kind.is_dir() {
        PathEntry::Directory
    } else if kind.is_file() {
        PathEntry::File
    } else {
        PathEntry::Other
    }
}

/// What [`canonical_path`] makes of a link whose target does not exist.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DanglingLinks {
    /// The link's own location is the canonical path.
    Keep,
    /// The link is followed to the path it names, link after link.
    Follow,
}

/// Why a path has no canonical spelling.
#[derive(Debug, thiserror::Error)]
pub enum ResolvePathError {
    #[error("could not make {path} absolute")]
    Absolute {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("{path} is part of a symlink cycle")]
    Cycle { path: PathBuf },
}

/// The canonical spelling of `path`, which need not exist yet: the links in
/// the part that exists are resolved and the rest is appended as written.
/// `.` and `..` are read lexically first, as Node's `path.resolve` reads
/// them, so `a/link/..` is `a` wherever `link` points. On Windows the
/// result has no `\\?\` prefix wherever a plain path names the same file.
///
/// # Errors
///
/// [`ResolvePathError::Cycle`] when following dangling links meets one
/// twice; [`ResolvePathError::Absolute`] when a relative `path` cannot be
/// resolved against the current directory.
pub fn canonical_path(path: &Path, dangling: DanglingLinks) -> Result<PathBuf, ResolvePathError> {
    let absolute = std::path::absolute(path).map_err(|source| ResolvePathError::Absolute {
        path: path.to_path_buf(),
        source,
    })?;

    resolve(&fold_dots(&absolute), dangling, &mut Vec::new())
}

/// The path from `root` down to `path` when `path` lies inside `root`, and
/// empty when the two are the same. Both are compared as given once `.` and
/// `..` are read, so a caller that cares about links canonicalizes first;
/// Windows compares names ignoring case, as its file systems do.
#[must_use]
pub fn relative_path_if_contained(root: &Path, path: &Path) -> Option<PathBuf> {
    let root = fold_dots(root);
    let path = fold_dots(path);
    let mut rest = path.components();

    for expected in root.components() {
        if !same_name(expected, rest.next()?) {
            return None;
        }
    }

    let rest = rest.as_path();

    (rest.components().next() != Some(Component::ParentDir)).then(|| rest.to_path_buf())
}

fn create_owner_only(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();

    options.write(true).create_new(true);
    owner_only(&mut options);
    options.open(path)
}

/// Windows has no mode bits: a file takes its directory's ACL, which in the
/// user's profile admits the user alone.
fn owner_only(options: &mut OpenOptions) {
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(options, 0o600);
    #[cfg(not(unix))]
    let _ = options;
}

fn temporary_name(target: &OsStr) -> OsString {
    let mut temporary = OsString::from(".");

    temporary.push(target);
    temporary.push(format!(".{}.tmp", Uuid::new_v4()));
    temporary
}

/// The name of the file that [`write_file_atomically`] was replacing through
/// a temporary named `entry`; `None` when `entry` is no such temporary.
#[must_use]
pub fn temporary_target(entry: &OsStr) -> Option<&str> {
    let inner = entry.to_str()?.strip_prefix('.')?.strip_suffix(".tmp")?;
    let (target, id) = inner.rsplit_once('.')?;

    Uuid::try_parse(id).ok().map(|_| target)
}

fn remove_abandoned_temporaries(path: &Path, name: &OsStr) -> io::Result<()> {
    let directory = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };

    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let abandoned = entry.file_type()?.is_file()
            && temporary_target(&entry.file_name()).is_some_and(|target| *name == *target);

        if abandoned {
            remove_file(&entry.path())?;
        }
    }

    Ok(())
}

fn write_then_rename(
    mut file: File,
    content: &[u8],
    temporary: &Path,
    path: &Path,
) -> io::Result<()> {
    file.write_all(content)?;
    file.sync_all()?;
    drop(file);

    fs::rename(temporary, path)
}

/// The failure being cleaned up after is the one worth reporting, so a
/// failed removal is not.
fn remove_after_failure(path: &Path) {
    let _ = fs::remove_file(path);
}

/// Makes the name `path` was given durable, by a rename or a create. Best
/// effort: Windows cannot open a directory as a file, and some file systems
/// refuse to flush one.
fn sync_directory_of(path: &Path) {
    let directory = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };

    if let Ok(handle) = File::open(directory) {
        let _ = handle.sync_all();
    }
}

fn resolve(
    path: &Path,
    dangling: DanglingLinks,
    followed: &mut Vec<PathBuf>,
) -> Result<PathBuf, ResolvePathError> {
    if let Ok(canonical) = dunce::canonicalize(path) {
        return Ok(canonical);
    }

    if dangling == DanglingLinks::Follow
        && let Ok(target) = fs::read_link(path)
    {
        if followed.iter().any(|link| link == path) {
            return Err(ResolvePathError::Cycle {
                path: path.to_path_buf(),
            });
        }

        followed.push(path.to_path_buf());
        let directory = path.parent().unwrap_or(path);

        return resolve(&fold_dots(&directory.join(target)), dangling, followed);
    }

    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => Ok(resolve(parent, dangling, followed)?.join(name)),
        _ => Ok(path.to_path_buf()),
    }
}

/// `path` with each `.` dropped and each `..` taking back the name before
/// it; a `..` at the root stays at the root.
fn fold_dots(path: &Path) -> PathBuf {
    let mut kept: Vec<Component<'_>> = Vec::new();

    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match kept.last() {
                Some(Component::Normal(_)) => {
                    kept.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => kept.push(component),
            },
            _ => kept.push(component),
        }
    }

    kept.iter().collect()
}

fn same_name(left: Component<'_>, right: Component<'_>) -> bool {
    if cfg!(windows) {
        left.as_os_str().to_string_lossy().to_lowercase()
            == right.as_os_str().to_string_lossy().to_lowercase()
    } else {
        left == right
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Spelled canonically: macOS reaches its temporary directory through a
    /// link, and Windows through short names.
    fn temp_root() -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(directory.path()).unwrap();

        (directory, root)
    }

    fn link(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            let created = if target.is_dir() {
                std::os::windows::fs::symlink_dir(target, link)
            } else {
                std::os::windows::fs::symlink_file(target, link)
            };

            created.unwrap();
        }
    }

    fn names_in(directory: &Path) -> Vec<String> {
        fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect()
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt as _;

        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn reads_invalid_utf8_as_replacement_characters() {
        let (_directory, root) = temp_root();
        let path = root.join("notes.txt");

        fs::write(&path, b"caf\xc3\xa9 \xff!").unwrap();

        assert_eq!(read_text_lossy(&path).unwrap(), "caf\u{e9} \u{fffd}!");
    }

    #[test]
    fn reads_no_more_of_a_file_than_asked() {
        let (_directory, root) = temp_root();
        let path = root.join("descriptor.json");

        fs::write(&path, b"0123456789").unwrap();

        assert_eq!(read_at_most(&path, 4).unwrap(), b"0123");
        assert_eq!(read_at_most(&path, 64).unwrap(), b"0123456789");
    }

    #[test]
    fn an_atomic_write_replaces_the_file_owner_only_and_leaves_no_temporary() {
        let (_directory, root) = temp_root();
        let path = root.join("config.json");

        fs::write(&path, "old\n").unwrap();
        write_file_atomically(&path, b"new\n").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new\n");
        assert_eq!(names_in(&root), ["config.json"]);
        #[cfg(unix)]
        assert_eq!(mode_of(&path), 0o600);
    }

    #[test]
    fn a_failed_atomic_write_removes_its_temporary() {
        let (_directory, root) = temp_root();
        let path = root.join("config.json");

        fs::create_dir(&path).unwrap();

        assert!(write_file_atomically(&path, b"new\n").is_err());
        assert_eq!(names_in(&root), ["config.json"]);
    }

    #[test]
    fn an_append_cuts_what_a_crash_left_after_the_last_line_and_creates_the_file_owner_only() {
        let (_directory, root) = temp_root();
        let path = root.join("raw-events.jsonl");

        append_line(&path, b"first").unwrap();
        #[cfg(unix)]
        assert_eq!(mode_of(&path), 0o600);

        fs::write(&path, "first\nsecond\nthi").unwrap();
        append_line(&path, b"third").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "first\nsecond\nthird\n");

        fs::write(&path, format!("first\n{}", "x".repeat(100 * 1_024))).unwrap();
        append_line(&path, b"after a long cut").unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "first\nafter a long cut\n"
        );

        fs::write(&path, "torn").unwrap();
        append_line(&path, "\u{1f600}".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "\u{1f600}\n");

        assert_eq!(
            append_line(&path, b"two\nlines").unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "\u{1f600}\n");
    }

    #[test]
    fn a_stamp_changes_with_what_is_written_and_is_none_where_nothing_is() {
        let (_directory, root) = temp_root();
        let path = root.join("raw-events.jsonl");

        assert_eq!(file_stamp(&path).unwrap(), None);
        append_line(&path, b"one").unwrap();

        let before = file_stamp(&path).unwrap();

        assert_eq!(file_stamp(&path).unwrap(), before);
        append_line(&path, b"two").unwrap();
        assert_ne!(file_stamp(&path).unwrap(), before);
    }

    #[test]
    fn a_locked_file_is_refused_to_every_other_handle_until_it_is_dropped() {
        let (_directory, root) = temp_root();
        let path = root.join("a.lock");
        let held = try_lock_file(&path).unwrap().unwrap();

        assert!(try_lock_file(&path).unwrap().is_none());
        #[cfg(unix)]
        assert_eq!(mode_of(&path), 0o600);

        drop(held);
        assert!(try_lock_file(&path).unwrap().is_some());
    }

    #[test]
    fn an_exclusive_create_claims_a_name_once() {
        let (_directory, root) = temp_root();
        let path = root.join("owner.json");

        create_new_file(&path, b"first\n").unwrap();
        let second = create_new_file(&path, b"second\n").unwrap_err();

        assert_eq!(second.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&path).unwrap(), "first\n");
        #[cfg(unix)]
        assert_eq!(mode_of(&path), 0o600);
    }

    #[test]
    fn says_what_is_at_a_path_without_following_a_final_link() {
        let (_directory, root) = temp_root();

        fs::create_dir(root.join("directory")).unwrap();
        fs::write(root.join("file.txt"), "contents\n").unwrap();
        link(&root.join("file.txt"), &root.join("link"));
        link(&root.join("missing"), &root.join("dangling"));

        for (name, entry) in [
            ("file.txt", "File"),
            ("directory", "Directory"),
            ("link", "Link"),
            ("dangling", "Link"),
            ("missing", "Absent"),
        ] {
            assert_eq!(format!("{:?}", describe_entry(&root.join(name))), entry);
        }
    }

    #[test]
    fn lists_a_directory_saying_what_each_entry_is_without_following_links() {
        let (_directory, root) = temp_root();

        fs::create_dir(root.join("folder")).unwrap();
        fs::write(root.join("file.txt"), "contents\n").unwrap();
        link(&root.join("folder"), &root.join("link"));

        let mut listed: Vec<(String, String)> = list_directory(&root)
            .unwrap()
            .into_iter()
            .map(|(name, entry)| (name.into_string().unwrap(), format!("{entry:?}")))
            .collect();

        listed.sort();
        assert_eq!(
            listed,
            [
                ("file.txt".to_owned(), "File".to_owned()),
                ("folder".to_owned(), "Directory".to_owned()),
                ("link".to_owned(), "Link".to_owned()),
            ]
        );
        assert_eq!(
            list_directory(&root.join("missing")).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
    }

    /// Windows answers this one as absent.
    #[cfg(unix)]
    #[test]
    fn a_path_under_a_file_is_unreadable_not_absent() {
        let (_directory, root) = temp_root();

        fs::write(root.join("file.txt"), "contents\n").unwrap();

        assert!(matches!(
            describe_entry(&root.join("file.txt").join("child")),
            PathEntry::Unreadable(error) if error.kind() == io::ErrorKind::NotADirectory
        ));
    }

    #[test]
    fn a_canonical_path_resolves_the_links_that_exist_and_appends_the_rest() {
        let (_directory, root) = temp_root();

        fs::create_dir_all(root.join("real").join("nested")).unwrap();
        link(&root.join("real"), &root.join("linked"));

        assert_eq!(
            canonical_path(&root.join("linked").join("nested"), DanglingLinks::Keep).unwrap(),
            root.join("real").join("nested")
        );
        assert_eq!(
            canonical_path(
                &root.join("linked").join("not").join("yet"),
                DanglingLinks::Keep
            )
            .unwrap(),
            root.join("real").join("not").join("yet")
        );
    }

    #[test]
    fn a_dot_dot_after_a_link_leaves_the_link_not_its_target() {
        let (_directory, root) = temp_root();

        fs::create_dir_all(root.join("elsewhere").join("real")).unwrap();
        link(&root.join("elsewhere").join("real"), &root.join("linked"));

        assert_eq!(
            canonical_path(
                &root.join("linked").join("..").join("next"),
                DanglingLinks::Keep
            )
            .unwrap(),
            root.join("next")
        );
    }

    #[test]
    fn a_dangling_link_names_itself_unless_followed() {
        let (_directory, root) = temp_root();

        link(&root.join("target"), &root.join("dangling"));

        assert_eq!(
            canonical_path(&root.join("dangling"), DanglingLinks::Keep).unwrap(),
            root.join("dangling")
        );
        assert_eq!(
            canonical_path(&root.join("dangling"), DanglingLinks::Follow).unwrap(),
            root.join("target")
        );
    }

    #[test]
    fn following_a_cycle_of_dangling_links_is_refused() {
        let (_directory, root) = temp_root();

        link(&root.join("second"), &root.join("first"));
        link(&root.join("first"), &root.join("second"));

        assert!(matches!(
            canonical_path(&root.join("first"), DanglingLinks::Follow),
            Err(ResolvePathError::Cycle { .. })
        ));
    }

    #[test]
    fn containment_compares_paths_as_given_once_dots_are_read() {
        let root = Path::new("/a/b");

        for (path, expected) in [
            ("/a/b/c/d", Some("c/d")),
            ("/a/b", Some("")),
            ("/a/b/c/../d", Some("d")),
            ("/a/c", None),
            ("/a", None),
            ("/a/bc", None),
            ("/a/b/../c", None),
            ("a/b/c", None),
        ] {
            assert_eq!(
                relative_path_if_contained(root, Path::new(path)),
                expected.map(PathBuf::from),
                "{path}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn containment_ignores_case_on_windows() {
        assert_eq!(
            relative_path_if_contained(Path::new(r"C:\Home"), Path::new(r"c:\home\Notes")),
            Some(PathBuf::from("Notes"))
        );
    }
}
