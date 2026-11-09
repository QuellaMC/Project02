//! The inspect command: a home's settings as they stand, and beside them,
//! when asked, a character's sessions, the conversations or one
//! conversation's segments, printed as one JSON document; or one session's
//! records as stored, one JSON object per line. Everything is read through
//! the store's own readers, and nothing is written, ever: a folder that
//! holds no store reports an empty one.

use std::process::ExitCode;

use p02_app::PackageReport;
use p02_characters::{CharacterDefinition, Discovery, discover};
use p02_config::{ConfigReport, Resolution, Sections};
use p02_core::{Conversation, SessionId, select_character};
use p02_shared::{Identifier, error_sentence};
use p02_store::{CharacterData, Home, LogRecord, SessionEntry, StorageError};
use serde::Serialize;

use crate::flags::{InspectFlags, Report};
use crate::{Console, home_of, package_problem};

/// Prints the report the flags ask for, or says why there is none.
pub(crate) fn run(flags: InspectFlags, console: &mut Console) -> ExitCode {
    match inspected(flags, console) {
        Ok(report) => {
            if !report.is_empty() {
                console.say(&report);
            }

            ExitCode::SUCCESS
        }
        Err(refusal) => console.failed(&refusal),
    }
}

/// What a report holds: the settings, and beside them what was asked for.
#[derive(Serialize)]
struct Inspection {
    #[serde(flatten)]
    settings: ConfigReport,
    #[serde(flatten)]
    asked: Asked,
}

/// The listing asked for beside the settings, under the keys it has.
#[derive(Serialize)]
#[serde(untagged)]
enum Asked {
    Settings {},
    Sessions {
        sessions: Vec<SessionEntry>,
    },
    Conversations {
        conversations: Vec<Conversation>,
    },
    Conversation {
        conversation: Conversation,
        /// Her segments of it, in the order they continue one another.
        sessions: Vec<SessionEntry>,
    },
}

/// The report as its text, or the sentence that says why there is none. A
/// package discovery could not publish is warned of on the way, and the
/// report is of the healthy ones.
fn inspected(flags: InspectFlags, console: &mut Console) -> Result<String, String> {
    let home = home_of(flags.store).map_err(|error| error_sentence(&error))?;

    // Every way into a home asks this first, before anything in it is read.
    home.check().map_err(|error| error_sentence(&error))?;

    let manifests = p02_plugins::list::plugins().map_err(|error| error_sentence(error))?;
    let sections = Sections::new(manifests.iter().map(|(manifest, _)| manifest.clone()));

    // Every character reads the home's document, so one that does not load
    // is said as itself, not as what it makes of each of them.
    Resolution::home(&home, &sections).map_err(|error| error.sentence())?;

    let discovery = discover(home.root());

    for diagnostic in &discovery.diagnostics {
        console.warn(&format!(
            "Warning: {}",
            package_problem(&PackageReport::from(diagnostic))
        ));
    }

    let character = chosen(flags.character.as_ref(), &discovery, &home, &sections)?;
    let data = || {
        CharacterData::open(&home, &character.profile.id).map_err(|error| error_sentence(&error))
    };
    let asked = match flags.report {
        Report::Session(session) => return records(&home, data()?.as_ref(), &session, console),
        Report::Settings => Asked::Settings {},
        Report::Sessions => Asked::Sessions {
            sessions: sessions(data()?.as_ref(), console)?,
        },
        Report::Conversations => Asked::Conversations {
            conversations: home
                .conversations()
                .map_err(|error| error_sentence(&error))?,
        },
        Report::Conversation(conversation) => {
            let conversation = home
                .conversation(&conversation)
                .map_err(|error| error_sentence(&error))?;
            let mut sessions: Vec<SessionEntry> = sessions(data()?.as_ref(), console)?
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
    let settings = Resolution::character(&home, &sections, character)
        .map_err(|error| error.sentence())?
        .report(&home);

    serde_json::to_string_pretty(&Inspection { settings, asked })
        .map_err(|error| error_sentence(&error))
}

/// The records of her session `session` as her log stores them, one JSON
/// object per line, what the read skipped warned of.
fn records(
    home: &Home,
    data: Option<&CharacterData>,
    session: &SessionId,
    console: &mut Console,
) -> Result<String, String> {
    let replay = data
        .ok_or_else(|| StorageError::SessionNotFound(session.clone()))
        .and_then(|data| {
            let conversation = home.conversation(session.conversation_id())?;

            data.session_log(&conversation, session.segment())?.read()
        })
        .map_err(|error| error_sentence(&error))?;

    if !replay.skipped_lines().is_empty() {
        console.warn(&format!(
            "Warning: Skipped {} of session \"{session}\", which could not be read.",
            replay.skipped_lines()
        ));
    }

    Ok(replay
        .records()
        .iter()
        .map(LogRecord::to_line)
        .collect::<Vec<_>>()
        .join("\n"))
}

/// Her sessions, as her catalog lists them, what it skipped warned of; none
/// while she has no data.
fn sessions(
    data: Option<&CharacterData>,
    console: &mut Console,
) -> Result<Vec<SessionEntry>, String> {
    let Some(data) = data else {
        return Ok(Vec::new());
    };
    let catalog = data.sessions().map_err(|error| error_sentence(&error))?;

    if !catalog.skipped_lines.is_empty() {
        console.warn(&format!(
            "Warning: Skipped {} of the sessions catalog of \"{}\", which could not be read.",
            catalog.skipped_lines,
            data.character()
        ));
    }

    Ok(catalog.sessions)
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
