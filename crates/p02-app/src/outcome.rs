//! The wire's answers and frames as the daemon makes them from what it
//! holds: a storage error as the failure a person is told, a package
//! discovery could not publish as health reports it, a turn as the stream
//! is told it, and whether the person's act changed what it acted on.

use p02_characters::{PackageDiagnostic, PackageLocation};
use p02_core::{ClientStamp, ConversationId, MessageId, app_of};
use p02_plugins::PHONE_PLUGIN;
use p02_runtime::Progress;
use p02_shared::{Identifier, error_sentence};
use p02_store::{QueuedLine, StorageError};
use p02_wire::{Event, PackageReport, RunningTurn, StorageFailure, ToolCallStatus, TurnProgress};
use p02_world::WORLD_PLUGIN;

/// An outcome of the person's act on what is hers, her phone or her world,
/// which says whether it changed it: then the stream says so.
pub(crate) trait Changed {
    fn changed(&self) -> bool;
}

/// What a line sent again once a turn took it is refused with: the
/// message it was committed as.
pub(crate) fn duplicate(client_message_id: &ClientStamp, message_id: &MessageId) -> String {
    format!(
        "clientMessageId \"{client_message_id}\" is already on this conversation as message \
         {message_id}; read the thread for its reply."
    )
}

/// `error` as the failure the person is told.
pub(crate) fn storage_failure(error: &StorageError) -> StorageFailure {
    StorageFailure {
        code: error.code().to_owned(),
        message: error_sentence(error),
    }
}

/// A package discovery could not publish, as health reports it.
#[must_use]
pub fn package_report(diagnostic: &PackageDiagnostic) -> PackageReport {
    PackageReport {
        // As a refused start embeds it, so the one reads in the other.
        message: diagnostic.problem.to_string(),
        path: match &diagnostic.location {
            PackageLocation::Bundled => "bundled".to_owned(),
            PackageLocation::Home(path) => path.display().to_string(),
        },
    }
}

/// A turn of `character`'s on `conversation`, before anything of it is
/// told: the turn of `line`, under its stamps, or one of her own when there
/// is none; she is not writing yet.
pub(crate) fn running_turn(
    character: Identifier,
    conversation: ConversationId,
    line: Option<&QueuedLine>,
) -> RunningTurn {
    RunningTurn {
        character_id: character,
        conversation_id: conversation,
        source: line.map(|line| line.source.clone()),
        client_message_id: line.map(|line| line.client_message_id.clone()),
        writing: false,
    }
}

/// What the stream is told of `progress` on `turn`, in order: the message
/// or the tool calls it says, then the turn as it now runs when that
/// changed, or what a call of hers that came back accepted changed, which a
/// client reads again: her phone, or `lives_in`, the world she lives in,
/// when she lives in one. The turn changes as the line that began it is
/// committed, and as each round begins and ends: whether she is writing. A
/// round's messages come before its end, so a surface that shows her
/// writing ends it as the message rather than taking it back.
pub(crate) fn told(
    turn: &mut RunningTurn,
    progress: Progress,
    lives_in: Option<&Identifier>,
) -> Vec<Event> {
    let reread = match &progress {
        Progress::ToolCallCompleted {
            plugin_id,
            accepted: true,
            ..
        } => to_read_again(plugin_id, &turn.character_id, lives_in),
        _ => None,
    };
    let (said, changed) = match progress {
        Progress::UserMessage {
            message,
            written,
            source,
            client_message_id,
            read_at,
        } => (
            Some(TurnProgress::UserMessage {
                message_id: message.id,
                speaker_id: message.speaker_id,
                speaker_name: message.speaker_name,
                text: message.text,
                written,
                sent_at: message.sent_at,
                read_at,
                app: app_of(Some(&source)).to_owned(),
                source,
                client_message_id,
            }),
            true,
        ),
        Progress::VisibleReply {
            message,
            translation,
            app,
        } => (
            Some(TurnProgress::VisibleReply {
                message_id: message.id,
                speaker_id: message.speaker_id,
                speaker_name: message.speaker_name,
                text: message.text,
                translation,
                sent_at: message.sent_at,
                app,
            }),
            false,
        ),
        Progress::RoundBegan => {
            turn.writing = true;
            (None, true)
        }
        Progress::RoundEnded => {
            turn.writing = false;
            (None, true)
        }
        Progress::ToolCallsRequested { round, tool_names } => (
            Some(TurnProgress::ToolCallsRequested { round, tool_names }),
            false,
        ),
        Progress::ToolCallCompleted {
            round,
            plugin_id,
            tool_name,
            accepted,
        } => (
            Some(TurnProgress::ToolCallCompleted {
                round,
                status: if accepted {
                    ToolCallStatus::Accepted
                } else {
                    ToolCallStatus::Rejected
                },
                plugin_id,
                tool_name,
            }),
            false,
        ),
    };

    said.map(|progress| Event::TurnProgress {
        character_id: turn.character_id.clone(),
        conversation_id: turn.conversation_id.clone(),
        progress,
    })
    .into_iter()
    .chain(changed.then(|| Event::TurnRunning(turn.clone())))
    .chain(reread)
    .collect()
}

/// What is to be read again once a call of `character`'s to the tools of
/// the plugin `plugin` came back accepted, by what that plugin keeps: her
/// phone, or the world she lives in, `lives_in`; nothing a client reads for
/// any other.
fn to_read_again(
    plugin: &Identifier,
    character: &Identifier,
    lives_in: Option<&Identifier>,
) -> Option<Event> {
    match plugin.as_str() {
        PHONE_PLUGIN => Some(Event::PhoneChanged {
            character_id: character.clone(),
        }),
        WORLD_PLUGIN => lives_in.map(|world| Event::WorldChanged {
            world: world.clone(),
        }),
        _ => None,
    }
}
