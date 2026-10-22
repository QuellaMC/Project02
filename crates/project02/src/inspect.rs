//! The inspect command: a home's settings as they stand, and beside them,
//! when asked, a character's sessions, one session's evidence, the
//! conversations or one conversation's segments, each read through the
//! store's own readers and printed as one JSON document. Nothing is
//! written, ever: a folder that holds no store reports an empty one.

mod session;

use std::process::ExitCode;

use p02_app::PackageReport;
use p02_characters::{CharacterDefinition, Discovery, discover};
use p02_config::{ConfigReport, ReadSettingsError, Resolution, Sections};
use p02_core::{Conversation, select_character};
use p02_shared::{Identifier, error_sentence};
use p02_store::{CharacterData, Home, SessionEntry, StorageError};
use serde::Serialize;

use crate::flags::{InspectFlags, Report};
use crate::{Console, home_of, package_problem};

use self::session::SessionReport;

/// Prints the report the flags ask for, or says why there is none.
pub(crate) fn run(flags: InspectFlags, console: &mut Console) -> ExitCode {
    match inspected(flags, console) {
        Ok(report) => {
            console.say(&report);
            ExitCode::SUCCESS
        }
        Err(refusal) => console.failed(&refusal),
    }
}

/// What a report holds: the settings, and beside them what was asked for.
#[derive(Serialize)]
struct Inspection<'r> {
    #[serde(flatten)]
    settings: ConfigReport,
    #[serde(flatten)]
    asked: Asked<'r>,
}

/// The report asked for beside the settings, under the keys it has.
#[derive(Serialize)]
#[serde(untagged)]
enum Asked<'r> {
    Settings {},
    Sessions {
        sessions: Vec<SessionEntry>,
    },
    Session(SessionReport<'r>),
    Conversations {
        conversations: Vec<Conversation>,
    },
    Conversation {
        conversation: Conversation,
        /// Her segments of it, in the order they continue one another.
        sessions: Vec<SessionEntry>,
    },
}

/// The report as its JSON text, or the sentence that says why there is
/// none. A package discovery could not publish is warned of on the way,
/// and the report is of the healthy ones.
fn inspected(flags: InspectFlags, console: &mut Console) -> Result<String, String> {
    let home = home_of(flags.store).map_err(|error| error_sentence(&error))?;

    // Every way into a home asks this first, before anything in it is read.
    home.check().map_err(|error| unread(&error))?;

    let manifests = p02_plugins::list::plugins().map_err(|error| error_sentence(error))?;
    let sections = Sections::new(manifests.iter().map(|(manifest, _)| manifest.clone()));

    // Every character reads the home's document, so one that does not load
    // is said as itself, not as what it makes of each of them.
    Resolution::home(&home, &sections).map_err(unsettled)?;

    let discovery = discover(home.root());

    for diagnostic in &discovery.diagnostics {
        console.warn(&format!(
            "Warning: {}",
            package_problem(&PackageReport::from(diagnostic))
        ));
    }

    let character = chosen(flags.character.as_ref(), &discovery, &home, &sections)?;
    let settings = Resolution::character(&home, &sections, character)
        .map_err(unsettled)?
        .report(&home);
    let data = || CharacterData::open(&home, &character.profile.id).map_err(|error| unread(&error));
    let replay;
    let entry;
    let asked = match flags.report {
        Report::Settings => Asked::Settings {},
        Report::Sessions => Asked::Sessions {
            sessions: sessions(data()?.as_ref())?,
        },
        Report::Session(session) => {
            let data =
                data()?.ok_or_else(|| unread(&StorageError::SessionNotFound(session.clone())))?;

            entry = data.session(&session).map_err(|error| unread(&error))?;
            replay = home
                .conversation(session.conversation_id())
                .and_then(|conversation| data.session_log(&conversation, session.segment()))
                .and_then(|log| log.read())
                .map_err(|error| unread(&error))?;
            Asked::Session(SessionReport::new(&entry, &replay))
        }
        Report::Conversations => Asked::Conversations {
            conversations: home.conversations().map_err(|error| unread(&error))?,
        },
        Report::Conversation(conversation) => {
            let conversation = home
                .conversation(&conversation)
                .map_err(|error| unread(&error))?;
            let mut sessions: Vec<SessionEntry> = sessions(data()?.as_ref())?
                .into_iter()
                .filter(|entry| entry.session_id().conversation_id() == conversation.id())
                .collect();

            sessions.sort_by_key(|entry| entry.session_id().segment());
            Asked::Conversation {
                conversation,
                sessions,
            }
        }
    };

    serde_json::to_string_pretty(&Inspection { settings, asked })
        .map_err(|error| error_sentence(&error))
}

/// Her sessions, as her catalog lists them; none while she has no data.
fn sessions(data: Option<&CharacterData>) -> Result<Vec<SessionEntry>, String> {
    data.map_or(Ok(Vec::new()), |data| {
        data.sessions().map_err(|error| unread(&error))
    })
}

/// The character the report is of: the one named, whether or not she is
/// switched on, or else the one character the settings switch on. Settings
/// that cannot be read leave her counted on, as the daemon counts her, so
/// their damage is reported rather than hiding her.
fn chosen<'d>(
    named: Option<&Identifier>,
    discovery: &'d Discovery,
    home: &Home,
    sections: &Sections,
) -> Result<&'d CharacterDefinition, String> {
    let id = match named {
        Some(id) => id.clone(),
        None => select_character(
            discovery
                .characters
                .iter()
                .filter(|character| {
                    Resolution::character(home, sections, character)
                        .ok()
                        .is_none_or(|resolution| resolution.settings().host().enabled)
                })
                .map(|character| character.profile.id.clone()),
        )
        .map_err(|error| format!("{} Name one with --character <id>.", error_sentence(&error)))?,
    };

    discovery
        .find(id.as_str())
        .map_err(|error| error_sentence(&error))
}

/// What a person is told of settings that cannot be read.
fn unsettled(error: ReadSettingsError) -> String {
    match error {
        ReadSettingsError::Storage(error) => unread(&error),
        other => other.sentence(),
    }
}

/// What a person is told of a store inspect could not read. One it cannot
/// read as a store at all, its files unreadable or not what a store holds,
/// could not be read; anything else the store found says what it is:
/// another version, another character's data, damage, or a session or a
/// conversation that is not there.
fn unread(error: &StorageError) -> String {
    match error.code() {
        "read_failed" | "missing_file" => "Local runtime store could not be read.".to_owned(),
        _ => error_sentence(error),
    }
}
