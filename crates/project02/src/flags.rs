//! The command line, `project02 serve [--store <dir>] [--init]`,
//! `project02 inspect [--store <dir>] [--character <id>] [<report>]` or
//! `project02 telegram [--store <dir>]`, read by hand: a parser would bring
//! a help flag and sentences of its own, where a person who mistypes is
//! owed these.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

use p02_core::{ConversationId, SessionId};
use p02_shared::Identifier;

const USAGE: &str = "The commands are: project02 serve [--store <dir>] [--init], project02 \
                     inspect [--store <dir>] [--character <id>] [--sessions | --session <id> | \
                     --conversations | --conversation <id>], and project02 telegram [--store \
                     <dir>].";

/// What the person asked the binary to do.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Command {
    Serve(ServeFlags),
    Inspect(InspectFlags),
    Telegram(TelegramFlags),
}

/// What `serve` is asked: the home's directory as the person named it,
/// none for the default, and whether they consent to a store being made
/// there.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ServeFlags {
    pub store: Option<PathBuf>,
    pub init: bool,
}

/// What `inspect` is asked: the home, as `serve` takes it, the character
/// named, none for the one switched on, and the report.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct InspectFlags {
    pub(crate) store: Option<PathBuf>,
    pub(crate) character: Option<Identifier>,
    pub(crate) report: Report,
}

/// What `telegram` is asked: the home whose daemon it follows, as `serve`
/// takes it.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct TelegramFlags {
    pub(crate) store: Option<PathBuf>,
}

/// Which report `inspect` prints beside the settings.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) enum Report {
    /// The settings alone.
    #[default]
    Settings,
    Sessions,
    Session(SessionId),
    Conversations,
    Conversation(ConversationId),
}

/// A command line the binary cannot use; its sentence is all the person
/// is told.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub(crate) struct UsageError(String);

/// What follows the program's name: a command and its flags, a flag given
/// twice taking its last value.
pub(crate) fn read(args: &[OsString]) -> Result<Command, UsageError> {
    match args.split_first() {
        Some((command, flags)) if command == "serve" => serve_flags(flags).map(Command::Serve),
        Some((command, flags)) if command == "inspect" => {
            inspect_flags(flags).map(Command::Inspect)
        }
        Some((command, flags)) if command == "telegram" => {
            telegram_flags(flags).map(Command::Telegram)
        }
        Some((command, _)) => Err(UsageError(format!(
            "Unknown command: {}. {USAGE}",
            command.to_string_lossy()
        ))),
        None => Err(UsageError(format!("No command given. {USAGE}"))),
    }
}

/// The daemon runs every character, so choosing one, as `--character`
/// would, is a client's, and is refused here like any other word.
fn serve_flags(args: &[OsString]) -> Result<ServeFlags, UsageError> {
    let mut flags = ServeFlags::default();
    let mut args = args.iter();

    while let Some(arg) = args.next() {
        if arg == "--store" {
            flags.store = Some(store(args.next())?);
        } else if arg == "--init" {
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

fn inspect_flags(args: &[OsString]) -> Result<InspectFlags, UsageError> {
    let mut flags = InspectFlags::default();
    let mut args = args.iter();

    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--store") => flags.store = Some(store(args.next())?),
            Some("--character") => flags.character = Some(character(args.next())?),
            Some(flag @ ("--sessions" | "--session" | "--conversations" | "--conversation")) => {
                flags.report = report(flag, &mut args)?;
            }
            _ => {
                return Err(UsageError(format!(
                    "Unknown inspect option: {}.",
                    arg.to_string_lossy()
                )));
            }
        }
    }

    Ok(flags)
}

fn telegram_flags(args: &[OsString]) -> Result<TelegramFlags, UsageError> {
    let mut flags = TelegramFlags::default();
    let mut args = args.iter();

    while let Some(arg) = args.next() {
        if arg == "--store" {
            flags.store = Some(store(args.next())?);
        } else {
            return Err(UsageError(format!(
                "Unknown telegram option: {}.",
                arg.to_string_lossy()
            )));
        }
    }

    Ok(flags)
}

/// The report `flag` names, taking the word after it as the session or
/// the conversation it names.
fn report<'a>(
    flag: &str,
    args: &mut impl Iterator<Item = &'a OsString>,
) -> Result<Report, UsageError> {
    match flag {
        "--sessions" => Ok(Report::Sessions),
        "--conversations" => Ok(Report::Conversations),
        "--session" => {
            let value = value_of(flag, args.next())?.to_string_lossy();

            SessionId::parse(&value)
                .map(Report::Session)
                .map_err(|error| refused(flag, &value, &error))
        }
        _ => {
            let value = value_of(flag, args.next())?.to_string_lossy();

            ConversationId::new(&value)
                .map(Report::Conversation)
                .map_err(|error| refused(flag, &value, &error))
        }
    }
}

fn store(value: Option<&OsString>) -> Result<PathBuf, UsageError> {
    value_of("--store", value).map(PathBuf::from)
}

/// A character is named by her id, which a malformed word cannot be: the
/// rule is said rather than a search for her that could not succeed.
fn character(value: Option<&OsString>) -> Result<Identifier, UsageError> {
    let value = value_of("--character", value)?.to_string_lossy();

    Identifier::new(&value).map_err(|error| refused("--character", &value, &error))
}

/// A flag's value is a word of its own: a flag after the flag means its
/// value was left out.
fn value_of<'a>(flag: &str, value: Option<&'a OsString>) -> Result<&'a OsString, UsageError> {
    value
        .filter(|value| is_value(value))
        .ok_or_else(|| UsageError(format!("{flag} requires a value.")))
}

fn is_value(word: &OsStr) -> bool {
    !word.is_empty() && !word.as_encoded_bytes().starts_with(b"--")
}

fn refused(flag: &str, value: &str, error: &dyn std::error::Error) -> UsageError {
    UsageError(format!("{flag} \"{value}\" is {error}."))
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
                Ok(Command::Serve(ServeFlags {
                    store: store.map(PathBuf::from),
                    init,
                })),
                "{words:?}"
            );
        }
    }

    #[test]
    fn inspect_takes_a_store_a_character_and_at_most_one_report() {
        let session = SessionId::parse("conv_a.10").unwrap();

        for (words, store, character, report) in [
            (&["inspect"][..], None, None, Report::Settings),
            (&["inspect", "--sessions"], None, None, Report::Sessions),
            (
                &["inspect", "--conversations", "--store", "home"],
                Some("home"),
                None,
                Report::Conversations,
            ),
            (
                &["inspect", "--character", "nova", "--session", "conv_a.10"],
                None,
                Some("nova"),
                Report::Session(session.clone()),
            ),
            (
                &["inspect", "--conversation", "conv_a", "--character", "mira"],
                None,
                Some("mira"),
                Report::Conversation(ConversationId::new("conv_a").unwrap()),
            ),
        ] {
            assert_eq!(
                read(&line(words)),
                Ok(Command::Inspect(InspectFlags {
                    store: store.map(PathBuf::from),
                    character: character.map(|id| Identifier::new(id).unwrap()),
                    report,
                })),
                "{words:?}"
            );
        }
    }

    #[test]
    fn telegram_takes_a_store() {
        for (words, store) in [
            (&["telegram"][..], None),
            (&["telegram", "--store", "home"], Some("home")),
        ] {
            assert_eq!(
                read(&line(words)),
                Ok(Command::Telegram(TelegramFlags {
                    store: store.map(PathBuf::from),
                })),
                "{words:?}"
            );
        }
    }

    #[test]
    fn every_other_command_line_is_refused_with_the_sentence_a_person_reads() {
        for (words, said) in [
            (&[][..], format!("No command given. {USAGE}")),
            (&["chat"], format!("Unknown command: chat. {USAGE}")),
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
                &["inspect", "--sessions", "--init"],
                "Unknown inspect option: --init.".to_owned(),
            ),
            (
                &["inspect", "--session"],
                "--session requires a value.".to_owned(),
            ),
            (
                &["inspect", "--conversation", "--sessions"],
                "--conversation requires a value.".to_owned(),
            ),
            (
                &["inspect", "--character"],
                "--character requires a value.".to_owned(),
            ),
            (
                &["inspect", "--character", "../bad"],
                "--character \"../bad\" is not an identifier: an ASCII letter, then up to 127 \
                 ASCII letters, digits, '.', '_' or '-'."
                    .to_owned(),
            ),
            (
                &["inspect", "--session", "conv_a"],
                "--session \"conv_a\" is not a session id: a conversation id, then '.' and a \
                 segment number from 1 without leading zeros."
                    .to_owned(),
            ),
            (
                &["inspect", "--conversation", "conv.a"],
                "--conversation \"conv.a\" is not a conversation id: an ASCII letter or digit, \
                 then up to 55 ASCII letters, digits, '_' or '-'."
                    .to_owned(),
            ),
            (
                &["inspect", "--all"],
                "Unknown inspect option: --all.".to_owned(),
            ),
            (
                &["telegram", "--init"],
                "Unknown telegram option: --init.".to_owned(),
            ),
            (
                &["telegram", "--store"],
                "--store requires a value.".to_owned(),
            ),
        ] {
            assert_eq!(read(&line(words)), Err(UsageError(said)), "{words:?}");
        }
    }
}
