//! The fs seam: the one module that reaches the file system. Reads and
//! writes hand back the `io::Error` they met, because callers disagree about
//! what a failure means.
#![expect(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "this module is the fs seam every other module goes through"
)]

use std::ffi::OsString;
use std::fs::{self, File, FileType, OpenOptions};
use std::io::{self, Read as _, Write as _};
use std::path::{Component, Path, PathBuf};
use std::process;

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
/// directory must exist.
///
/// The content goes first to a sibling `.<name>.<pid>.<uuid>.tmp`, flushed
/// to disk before the rename: the pid lets a sweep tell a temporary that a
/// crashed writer abandoned from one still being written.
///
/// # Errors
///
/// The `io::Error` of the step that failed. The temporary is removed and
/// the file at `path` is as it was.
pub fn write_file_atomically(path: &Path, content: &[u8]) -> io::Result<()> {
    let temporary = temporary_sibling(path)?;
    let file = create_owner_only(&temporary)?;

    if let Err(error) = write_then_rename(file, content, &temporary, path) {
        remove_after_failure(&temporary);
        return Err(error);
    }

    sync_directory_of(path);
    Ok(())
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
/// `path`.
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
    // Windows has no mode bits: a file takes its directory's ACL, which in
    // the user's profile admits the user alone.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);

    options.open(path)
}

fn temporary_sibling(path: &Path) -> io::Result<PathBuf> {
    let name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "a file to replace needs a name",
        )
    })?;
    let mut temporary = OsString::from(".");

    temporary.push(name);
    temporary.push(format!(".{}.{}.tmp", process::id(), Uuid::new_v4()));

    Ok(path.with_file_name(temporary))
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

/// Makes a rename durable. Best effort: Windows cannot open a directory as
/// a file, and some file systems refuse to flush one.
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
