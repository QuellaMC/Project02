//! The wire's answers and frames as the daemon makes them from what it
//! holds: a storage error as the failure a person is told, a package
//! discovery could not publish as health reports it, and a turn as the
//! stream is told it.

use p02_characters::{PackageDiagnostic, PackageLocation};
use p02_core::{ClientStamp, ConversationId, MessageId};
use p02_plugins::PHONE_PLUGIN;
use p02_runtime::Progress;
use p02_shared::{Identifier, error_sentence};
use p02_store::{QueuedLine, StorageError};
use p02_wire::{
    Event, PackageReport, RunningDraft, RunningTurn, StorageFailure, ToolCallStatus, TurnProgress,
};

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
/// is none.
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
        drafts: Vec::new(),
    }
}

/// What the stream is told of `progress` on `turn`, in order: the message
/// or the tool calls it says, then the turn as it now runs when that
/// changed, or that her phone is to be read again when a call of hers to
/// it came back accepted. A commit comes before the turn without its
/// draft, so a surface that shows the draft ends it as the message rather
/// than taking it back.
pub(crate) fn told(turn: &mut RunningTurn, progress: Progress) -> Vec<Event> {
    let phoned = matches!(
        &progress,
        Progress::ToolCallCompleted { plugin_id, accepted: true, .. }
            if plugin_id.as_str() == PHONE_PLUGIN
    );
    let (said, changed) = match progress {
        Progress::UserMessage {
            message,
            source,
            client_message_id,
        } => (
            Some(TurnProgress::UserMessage {
                message_id: message.id,
                speaker_id: message.speaker_id,
                speaker_name: message.speaker_name,
                text: message.text,
                source,
                client_message_id,
            }),
            true,
        ),
        Progress::VisibleReply { message, draft } => {
            let draft_id = draft.to_string();

            turn.drafts.retain(|open| open.draft_id != draft_id);
            (
                Some(TurnProgress::VisibleReply {
                    message_id: message.id,
                    speaker_id: message.speaker_id,
                    speaker_name: message.speaker_name,
                    text: message.text,
                    draft_id,
                }),
                true,
            )
        }
        Progress::ReplyDelta { draft, text } => {
            let draft_id = draft.to_string();

            match turn
                .drafts
                .iter_mut()
                .find(|open| open.draft_id == draft_id)
            {
                Some(open) => open.text.push_str(&text),
                None => turn.drafts.push(RunningDraft { draft_id, text }),
            }

            (None, true)
        }
        Progress::ReplyWithdrawn { draft } => {
            let draft_id = draft.to_string();

            turn.drafts.retain(|open| open.draft_id != draft_id);
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
    .chain(phoned.then(|| Event::PhoneChanged {
        character_id: turn.character_id.clone(),
    }))
    .collect()
}
