//! The person's home: one folder per operating system, outside the app
//! and the same for every version, so an update or a reinstall finds it
//! where the last one left it.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The home under the platform's local data folder `local_data`:
/// `%LOCALAPPDATA%\Project02`, `~/Library/Application Support/Project02`,
/// or `$XDG_DATA_HOME/project02`, else `~/.local/share/project02`. Never the
/// app's own data folder, which the webview writes into before a store
/// could be made there.
pub(crate) fn per_user(local_data: &Path) -> PathBuf {
    local_data.join(if cfg!(target_os = "linux") {
        "project02"
    } else {
        "Project02"
    })
}

/// The home the shell's own command line names, `--store <dir>`, which
/// takes the per-user home's place; none when the line is empty.
pub(crate) fn named(args: &[OsString]) -> Result<Option<PathBuf>, &'static str> {
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
    fn the_command_line_names_a_home_or_none_and_nothing_else() {
        let line = |words: &[&str]| words.iter().map(OsString::from).collect::<Vec<_>>();

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
