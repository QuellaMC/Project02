//! A conversation as one scrollback: its character keeps it in segments,
//! a page is filled backward across them, newest first, and its cursor
//! names where the next page ends; the newest messages of one app, as her
//! phone shows them; and one message of hers, by its id. Only committed
//! messages are read, from the store, so a stopped character's thread
//! reads as a running one's.

use std::num::NonZeroU64;
use std::ops::Range;

use p02_core::{
    Conversation, ConversationId, MESSAGES, MessageId, SessionId, VisibleMessageRole, app_of,
};
use p02_shared::Identifier;
use p02_store::{
    CharacterData, Home, LogRecord, RecordBody, SessionEntry, SettingsDocument, StorageError,
};
use p02_wire::{HistoryMessage, HistoryOutcome, HistoryRefusal};

use crate::daemon::character_of;
use crate::outcome::storage_failure;

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 500;
const INVALID_PAGE: &str = "A history page takes a number as its limit and, to read further \
     back, the cursor the previous page returned.";

/// Which page of a scrollback to read, as a client asks for it: the
/// cursor a previous page returned, for older messages than it held, and
/// how many messages, 100 unless given, held to 1 to 500.
#[derive(Clone, Debug, Default)]
pub struct HistoryPage {
    pub before: Option<String>,
    pub limit: Option<String>,
}

/// A page asked for, read: how many messages, and where the page ends.
struct Page {
    limit: usize,
    before: Option<Position>,
}

/// A place in one segment: `index` of its messages lie before it.
#[derive(Clone, Copy)]
struct Position {
    segment: u64,
    index: usize,
}

/// The one reading of a page request: a limit, and a cursor this module
/// hands out, `v1:<segment>:<index>`.
fn page(asked: &HistoryPage) -> Option<Page> {
    let limit = match &asked.limit {
        None => DEFAULT_LIMIT,
        Some(text) => text.parse::<usize>().ok()?.clamp(1, MAX_LIMIT),
    };
    let before = match &asked.before {
        None => None,
        Some(cursor) => {
            let (segment, index) = cursor.strip_prefix("v1:")?.split_once(':')?;

            Some(Position {
                segment: segment.parse().ok()?,
                index: index.parse().ok()?,
            })
        }
    };

    Some(Page { limit, before })
}

fn cursor(segment: NonZeroU64, index: usize) -> String {
    format!("v1:{segment}:{index}")
}

/// The page `asked` of conversation `conversation` on `home`.
pub(crate) fn read(home: &Home, conversation: &str, asked: &HistoryPage) -> HistoryOutcome {
    let refused = |reason, message: String| HistoryOutcome::Refused { reason, message };
    let invalid = || refused(HistoryRefusal::InvalidPage, INVALID_PAGE.to_owned());
    let Some(page) = page(asked) else {
        return invalid();
    };
    let Scrollback {
        character,
        mut segments,
    } = match Scrollback::of(home, conversation) {
        Ok(Some(scrollback)) => scrollback,
        Ok(None) => {
            return refused(
                HistoryRefusal::UnknownConversation,
                no_conversation(conversation),
            );
        }
        Err(error) => return HistoryOutcome::Failed(storage_failure(&error)),
    };

    match segments.page(&page) {
        Ok(Some((messages, earlier))) => HistoryOutcome::Ok {
            conversation_id: segments.conversation.id().clone(),
            character_id: character,
            messages,
            earlier,
        },
        Ok(None) => invalid(),
        Err(error) => HistoryOutcome::Failed(storage_failure(&error)),
    }
}

/// What a conversation the home does not hold is said to be.
pub(crate) fn no_conversation(conversation: &str) -> String {
    format!("Conversation \"{conversation}\" does not exist.")
}

/// What the scrollback of a conversation holds of a message of hers.
pub(crate) enum Hers {
    /// The home holds no such conversation.
    NoConversation,
    /// The conversation holds no message of hers by that id.
    NoMessage,
    /// A message of hers, in the conversation of `character`.
    Found {
        character: Identifier,
        message: MessageId,
    },
}

/// Message `message` of conversation `conversation` on `home`, as [`Hers`]
/// says it.
pub(crate) fn hers(home: &Home, conversation: &str, message: &str) -> Result<Hers, StorageError> {
    let Some(Scrollback {
        character,
        mut segments,
    }) = Scrollback::of(home, conversation)?
    else {
        return Ok(Hers::NoConversation);
    };
    let found = match MessageId::parse(message) {
        Ok(id) => segments.find(&id)?,
        Err(_) => None,
    };

    Ok(match found {
        Some(found) if found.role == VisibleMessageRole::Character => Hers::Found {
            character,
            message: found.message_id.clone(),
        },
        _ => Hers::NoMessage,
    })
}

/// The newest messages of the conversation between `character` and the
/// person on `home` that are in `app`, `count` at most, oldest first, as
/// the scrollback reads them, however far back they lie: none while the
/// conversation was never made.
pub(crate) fn newest(
    home: &Home,
    character: &Identifier,
    app: &str,
    count: usize,
) -> Result<Vec<HistoryMessage>, StorageError> {
    let Some(conversation) = p02_runtime::Conversation::find(home, character)? else {
        return Ok(Vec::new());
    };
    let Some(data) = CharacterData::open(home, character)? else {
        return Ok(Vec::new());
    };
    let mut segments = Segments::of(data, conversation)?;
    let mut newest = Vec::new();

    for segment in (0..segments.numbers.len()).rev() {
        let wanted = count - newest.len();

        newest.extend(
            segments
                .messages(segment)?
                .iter()
                .rev()
                .filter(|message| message.app == app)
                .take(wanted)
                .cloned(),
        );

        if newest.len() == count {
            break;
        }
    }

    newest.reverse();
    Ok(newest)
}

/// A page's messages, and the cursor of the page before it.
type Scrolled = (Vec<HistoryMessage>, Option<String>);

/// A conversation as the store keeps it: the character whose it is, and
/// its segments.
struct Scrollback {
    character: Identifier,
    segments: Segments,
}

impl Scrollback {
    /// The conversation a client names `conversation` on `home`: none while
    /// the home holds no such conversation with a character.
    fn of(home: &Home, conversation: &str) -> Result<Option<Self>, StorageError> {
        let Ok(id) = ConversationId::new(conversation) else {
            return Ok(None);
        };
        let record = match home.conversation(&id) {
            Ok(record) => record,
            Err(StorageError::ConversationNotFound(_)) => return Ok(None),
            Err(error) => return Err(error),
        };
        let Some(character) = character_of(&record) else {
            return Ok(None);
        };
        let Some(data) = CharacterData::open(home, &character)? else {
            // Her conversation outlived her data: what it held is gone.
            let overlay = home.settings_path(SettingsDocument::Overlay(&character));

            return Err(StorageError::NoMarker {
                path: overlay.parent().unwrap_or(&overlay).to_path_buf(),
            });
        };

        Ok(Some(Self {
            segments: Segments::of(data, record)?,
            character,
        }))
    }
}

/// A conversation's segments, oldest first, each read at most once a page.
struct Segments {
    data: CharacterData,
    conversation: Conversation,
    numbers: Vec<NonZeroU64>,
    read: Vec<Option<Vec<HistoryMessage>>>,
}

impl Segments {
    fn of(data: CharacterData, conversation: Conversation) -> Result<Self, StorageError> {
        let mut numbers: Vec<NonZeroU64> = data
            .sessions()?
            .sessions
            .iter()
            .map(SessionEntry::session_id)
            .filter(|session| session.conversation_id() == conversation.id())
            .map(SessionId::segment)
            .collect();

        numbers.sort_unstable();

        Ok(Self {
            read: vec![None; numbers.len()],
            data,
            conversation,
            numbers,
        })
    }

    /// The messages of the page, and the cursor of the one before it while
    /// older messages exist; none for a cursor no page handed out.
    fn page(&mut self, page: &Page) -> Result<Option<Scrolled>, StorageError> {
        let start = match page.before {
            None => match self.numbers.len().checked_sub(1) {
                Some(newest) => Some((newest, self.len(newest)?)),
                None => None,
            },
            Some(Position { segment, index }) => {
                let Some(at) = self
                    .numbers
                    .iter()
                    .position(|number| number.get() == segment)
                else {
                    return Ok(None);
                };

                if index > self.len(at)? {
                    return Ok(None);
                }

                Some((at, index))
            }
        };
        let mut chunks = Vec::new();
        let mut taken = 0;
        let mut at = start;

        while let Some((segment, end)) = at {
            if taken == page.limit {
                break;
            }

            let take = (page.limit - taken).min(end);

            chunks.push(self.slice(segment, end - take..end)?);
            taken += take;
            at = if end > take {
                Some((segment, end - take))
            } else {
                self.older(segment)?
            };
        }

        // An older segment that holds nothing is no place to point at.
        while let Some((segment, 0)) = at {
            at = self.older(segment)?;
        }

        Ok(Some((
            chunks.into_iter().rev().flatten().collect(),
            at.map(|(segment, end)| cursor(self.numbers[segment], end)),
        )))
    }

    /// The end of the segment before `segment`, if there is one.
    fn older(&mut self, segment: usize) -> Result<Option<(usize, usize)>, StorageError> {
        match segment.checked_sub(1) {
            Some(older) => Ok(Some((older, self.len(older)?))),
            None => Ok(None),
        }
    }

    fn len(&mut self, segment: usize) -> Result<usize, StorageError> {
        Ok(self.messages(segment)?.len())
    }

    fn slice(
        &mut self,
        segment: usize,
        range: Range<usize>,
    ) -> Result<Vec<HistoryMessage>, StorageError> {
        Ok(self.messages(segment)?[range].to_vec())
    }

    /// The message `id` names, when it is one of the conversation's.
    fn find(&mut self, id: &MessageId) -> Result<Option<&HistoryMessage>, StorageError> {
        let session = id.session_id();

        if session.conversation_id() != self.conversation.id() {
            return Ok(None);
        }

        let Some(segment) = self
            .numbers
            .iter()
            .position(|number| *number == session.segment())
        else {
            return Ok(None);
        };

        Ok(self
            .messages(segment)?
            .iter()
            .find(|message| message.message_id == *id))
    }

    /// Segment `segment`'s committed messages, as [`messages_of`] reads
    /// them.
    fn messages(&mut self, segment: usize) -> Result<&[HistoryMessage], StorageError> {
        if self.read[segment].is_none() {
            let replay = self
                .data
                .session_log(&self.conversation, self.numbers[segment])?
                .read()?;

            self.read[segment] = Some(messages_of(replay.records()));
        }

        Ok(self.read[segment].as_deref().unwrap_or_default())
    }
}

/// The messages `records`, one segment's, committed: each with when it was
/// sent and the app it is in, and the person's lines with when she read
/// them, the moment of the record that holds each, and the stamps they
/// carry. A message of hers an earlier build kept names no app: it is in
/// the app of the person's line nearest before it in the segment, which it
/// answered, and in Messages when there is none.
fn messages_of(records: &[LogRecord]) -> Vec<HistoryMessage> {
    let mut nearest = MESSAGES;

    records
        .iter()
        .filter_map(|record| match record.body() {
            RecordBody::MessageCommitted(commit) => Some((record.identity(), commit)),
            _ => None,
        })
        .map(|(identity, commit)| {
            let message = commit.message().clone();
            let (app, read_at) = match message.role {
                VisibleMessageRole::User => {
                    nearest = app_of(commit.source());
                    (nearest, Some(identity.created_at().clone()))
                }
                VisibleMessageRole::Character => (commit.app().unwrap_or(nearest), None),
            };

            HistoryMessage {
                message_id: message.id,
                role: message.role,
                speaker_id: message.speaker_id,
                speaker_name: message.speaker_name,
                text: message.text,
                sent_at: message.sent_at,
                read_at,
                app: app.to_owned(),
                source: commit.source().cloned(),
                client_message_id: commit.client_message_id().cloned(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    /// Message `number` of a segment as its commit's log line holds it,
    /// said by `role`, with `fields` beside it: the person's line sent half
    /// a minute before the turn that took it began, at its record's moment,
    /// and hers four seconds after.
    fn commit(number: u64, role: &str, fields: &Value) -> LogRecord {
        let id = format!("conv_a.1:message-{number}");
        let theirs = role == "user";
        let sent = if theirs {
            "2026-11-24T08:59:30.000Z"
        } else {
            "2026-11-24T09:00:04.000Z"
        };
        let mut line = json!({
            "eventId": "evt_1",
            "traceId": "trace_1",
            "createdAt": "2026-11-24T09:00:00.000Z",
            "kind": "visible_message_committed",
            "visibleMessageIds": [id],
            "visibleMessage": {
                "id": id,
                "role": role,
                "speakerId": if theirs { "local-user" } else { "mira" },
                "speakerName": if theirs { "Sam" } else { "Mira" },
                "text": "Hello.",
                "sentAt": sent,
            },
        });

        line.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        LogRecord::from_line(line.to_string().as_bytes()).unwrap()
    }

    /// A message of hers an earlier build kept, which names no app, is in
    /// the app of the person's line nearest before it in its segment, and
    /// in Messages before the first; one this build kept is in its own.
    #[test]
    fn a_message_of_hers_kept_without_its_app_is_in_the_app_of_the_line_before_it() {
        let hers = json!({"round": 1});
        let records = [
            commit(1, "character", &hers),
            commit(
                2,
                "user",
                &json!({"source": "telegram:mira_bot", "clientMessageId": "a"}),
            ),
            commit(3, "character", &hers),
            commit(4, "user", &json!({"source": "web", "clientMessageId": "b"})),
            commit(5, "character", &hers),
            commit(6, "character", &json!({"app": "telegram", "round": 2})),
        ];
        let apps: Vec<String> = messages_of(&records)
            .into_iter()
            .map(|message| message.app)
            .collect();

        assert_eq!(
            apps,
            [
                "messages", "telegram", "telegram", "messages", "messages", "telegram"
            ]
        );
    }

    /// The person's line was read when her turn took it, the moment of the
    /// record that holds it, and not when it was sent; hers says no such
    /// moment.
    #[test]
    fn the_person_s_line_is_read_at_its_record_s_moment_not_when_it_was_sent() {
        let records = [
            commit(1, "user", &json!({"source": "web", "clientMessageId": "a"})),
            commit(2, "character", &json!({"app": "messages", "round": 1})),
        ];
        let times: Vec<(String, Option<String>)> = messages_of(&records)
            .into_iter()
            .map(|message| {
                (
                    message.sent_at.to_string(),
                    message.read_at.map(|at| at.to_string()),
                )
            })
            .collect();

        assert_eq!(
            times,
            [
                (
                    "2026-11-24T08:59:30.000Z".to_owned(),
                    Some("2026-11-24T09:00:00.000Z".to_owned())
                ),
                ("2026-11-24T09:00:04.000Z".to_owned(), None),
            ]
        );
    }
}
