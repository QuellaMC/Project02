//! The command line, `project02 serve [--store <dir>] [--init]`, read by
//! hand: a parser would bring a help flag and sentences of its own, where
//! a person who mistypes is owed these.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

const USAGE: &str = "The command is: project02 serve [--store <dir>] [--init].";

/// What `serve` is asked: the home's directory as the person named it,
/// none for the default, and whether they consent to a store being made
/// there.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ServeFlags {
    pub(crate) store: Option<PathBuf>,
    pub(crate) init: bool,
}

/// A command line the binary cannot use; its sentence is all the person
/// is told.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub(crate) struct UsageError(String);

/// What follows the program's name: `serve` and its flags, each at most
/// once. The daemon runs every character, so choosing one, as `--character`
/// would, is a client's, and is refused here like any other word.
pub(crate) fn read(args: &[OsString]) -> Result<ServeFlags, UsageError> {
    match args.split_first() {
        Some((command, flags)) if command == "serve" => serve_flags(flags),
        Some((command, _)) => Err(UsageError(format!(
            "Unknown command: {}. {USAGE}",
            command.to_string_lossy()
        ))),
        None => Err(UsageError(format!("No command given. {USAGE}"))),
    }
}

fn serve_flags(args: &[OsString]) -> Result<ServeFlags, UsageError> {
    let mut flags = ServeFlags::default();
    let mut args = args.iter();

    while let Some(arg) = args.next() {
        if arg == "--store" {
            if flags.store.is_some() {
                return Err(given_twice("--store"));
            }

            let value = args
                .next()
                .filter(|value| is_value(value))
                .ok_or_else(|| UsageError("--store requires a value.".to_owned()))?;

            flags.store = Some(PathBuf::from(value));
        } else if arg == "--init" {
            if flags.init {
                return Err(given_twice("--init"));
            }

            flags.init = true;
        } else {
            return Err(UsageError(format!(
                "Unknown serve option: {}.",
                arg.to_string_lossy()
            )));
        }
    }

    Ok(flags)
}

/// A flag's value is a word of its own: a flag after `--store` means its
/// value was left out.
fn is_value(word: &OsStr) -> bool {
    !word.is_empty() && !word.as_encoded_bytes().starts_with(b"--")
}

fn given_twice(flag: &str) -> UsageError {
    UsageError(format!("{flag} can only be provided once."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(words: &[&str]) -> Vec<OsString> {
        words.iter().map(OsString::from).collect()
    }

    #[test]
    fn serve_takes_a_store_and_the_consent_to_make_one_in_either_order() {
        for (words, store, init) in [
            (&["serve"][..], None, false),
            (&["serve", "--store", "home"], Some("home"), false),
            (&["serve", "--init"], None, true),
            (
                &["serve", "--store", "-home", "--init"],
                Some("-home"),
                true,
            ),
            (&["serve", "--init", "--store", "home"], Some("home"), true),
        ] {
            assert_eq!(
                read(&line(words)),
                Ok(ServeFlags {
                    store: store.map(PathBuf::from),
                    init,
                }),
                "{words:?}"
            );
        }
    }

    #[test]
    fn every_other_command_line_is_refused_with_the_sentence_a_person_reads() {
        for (words, said) in [
            (&[][..], format!("No command given. {USAGE}")),
            (&["inspect"], format!("Unknown command: inspect. {USAGE}")),
            (
                &["serve", "--help"],
                "Unknown serve option: --help.".to_owned(),
            ),
            (
                &["serve", "--character", "mira"],
                "Unknown serve option: --character.".to_owned(),
            ),
            (&["serve", "home"], "Unknown serve option: home.".to_owned()),
            (
                &["serve", "--store"],
                "--store requires a value.".to_owned(),
            ),
            (
                &["serve", "--store", "--init"],
                "--store requires a value.".to_owned(),
            ),
            (
                &["serve", "--store", ""],
                "--store requires a value.".to_owned(),
            ),
            (
                &["serve", "--store", "a", "--store", "b"],
                "--store can only be provided once.".to_owned(),
            ),
            (
                &["serve", "--init", "--init"],
                "--init can only be provided once.".to_owned(),
            ),
        ] {
            assert_eq!(read(&line(words)), Err(UsageError(said)), "{words:?}");
        }
    }
}
