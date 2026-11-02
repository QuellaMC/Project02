//! The person's home: one folder per operating system, outside the app and
//! the same for every version, so an update or a reinstall finds it where
//! the last one left it.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The home under the platform's data folder `data`, as Tauri's
/// `data_dir()` names it: `%APPDATA%` on Windows, `~/Library/Application
/// Support` on macOS, and `$XDG_DATA_HOME`, else `~/.local/share`, on
/// Linux. `Project02` there, `project02` on Linux. Never one of the app's
/// own data folders, which the webview writes into before a store could be
/// made there, which the store then refuses; and not Windows' local data
/// folder, where the per-user installer puts the app itself under this
/// same name.
#[must_use]
pub fn per_user(data: &Path) -> PathBuf {
    data.join(if cfg!(target_os = "linux") {
        "project02"
    } else {
        "Project02"
    })
}

/// The home the shell's own command line names, `--store <dir>`, which
/// takes the per-user home's place; none when the line is empty, as when a
/// person opens the app.
///
/// # Errors
///
/// The sentence to say when the line holds anything else.
pub fn named(args: &[OsString]) -> Result<Option<PathBuf>, &'static str> {
    match args {
        [] => Ok(None),
        [flag, dir] if flag == "--store" && !dir.is_empty() => Ok(Some(PathBuf::from(dir))),
        _ => Err("The shell takes one option, --store <dir>."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_home_is_the_per_user_one_unless_the_command_line_names_one() {
        let line = |words: &[&str]| words.iter().map(OsString::from).collect::<Vec<_>>();

        #[cfg(target_os = "linux")]
        assert_eq!(
            per_user(Path::new("/home/ada/.local/share")),
            Path::new("/home/ada/.local/share/project02")
        );
        #[cfg(target_os = "macos")]
        assert_eq!(
            per_user(Path::new("/Users/ada/Library/Application Support")),
            Path::new("/Users/ada/Library/Application Support/Project02")
        );
        #[cfg(windows)]
        assert_eq!(
            per_user(Path::new(r"C:\Users\ada\AppData\Roaming")),
            Path::new(r"C:\Users\ada\AppData\Roaming\Project02")
        );

        assert_eq!(named(&line(&[])), Ok(None));
        assert_eq!(
            named(&line(&["--store", "home"])),
            Ok(Some(PathBuf::from("home")))
        );

        for words in [&["--store"][..], &["--store", ""], &["--init"], &["home"]] {
            assert!(named(&line(words)).is_err(), "{words:?}");
        }
    }
}
