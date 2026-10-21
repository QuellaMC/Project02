//! A conversation as one scrollback: its character keeps it in segments,
//! a page is filled backward across them, newest first, and its cursor
//! names where the next page ends. Only committed messages are read, from
//! the store, so a stopped character's thread reads as a running one's.

use std::num::NonZeroU64;
use std::ops::Range;

use p02_core::{Conversation, ConversationId, SessionId};
use p02_store::{CharacterData, Home, RecordBody, SessionEntry, SettingsDocument, StorageError};

use crate::daemon::character_of;
use crate::outcome::{HistoryMessage, HistoryOutcome, HistoryRefusal, StorageFailure};

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 500;
const INVALID_PAGE: &str = "A history page takes a limit from 1 to 500 and, to read further \
     back, the cursor the previous page returned.";

/// Which page of a scrollback to read, as a client asks for it: the
/// cursor a previous page returned, for older messages than it held, and
/// how many messages, 1 to 500, 100 unless given.
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

/// The one reading of a page request: a limit of one to three digits
/// within bounds, and a cursor this module hands out, `v1:<segment>:<index>`.
fn page(asked: &HistoryPage) -> Option<Page> {
    let limit = match &asked.limit {
        None => DEFAULT_LIMIT,
        Some(text) => digits(text, 3)?,
    };

    if !(1..=MAX_LIMIT).contains(&limit) {
        return None;
    }

    let before = match &asked.before {
        None => None,
        Some(cursor) => {
            let (segment, index) = cursor.strip_prefix("v1:")?.split_once(':')?;

            Some(Position {
                segment: u64::try_from(digits(segment, 9)?).ok()?,
                index: digits(index, 9)?,
            })
        }
    };

    Some(Page { limit, before })
}

/// `text` as a number of 1 to `most` ASCII digits.
fn digits(text: &str, most: usize) -> Option<usize> {
    if text.is_empty() || text.len() > most || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    text.parse().ok()
}

fn cursor(segment: NonZeroU64, index: usize) -> String {
    format!("v1:{segment}:{index}")
}

/// The page `asked` of conversation `conversation` on `home`.
pub(crate) fn read(home: &Home, conversation: &str, asked: &HistoryPage) -> HistoryOutcome {
    let refused = |reason, message: String| HistoryOutcome::Refused { reason, message };
    let Some(page) = page(asked) else {
        return refused(HistoryRefusal::InvalidPage, INVALID_PAGE.to_owned());
    };
    let unknown = || {
        refused(
            HistoryRefusal::UnknownConversation,
            format!("Conversation \"{conversation}\" does not exist."),
        )
    };
    let Ok(id) = ConversationId::new(conversation) else {
        return unknown();
    };
    let record = match home.conversation(&id) {
        Ok(record) => record,
        Err(StorageError::ConversationNotFound(_)) => return unknown(),
        Err(error) => return HistoryOutcome::Failed(StorageFailure::of(&error)),
    };
    let Some(character) = character_of(&record) else {
        return refused(
            HistoryRefusal::UnknownConversation,
            format!("Conversation \"{id}\" has no character to answer it."),
        );
    };
    let scrolled = CharacterData::open(home, &character).and_then(|data| {
        let Some(data) = data else {
            // Her conversation outlived her data: what it held is gone.
            let overlay = home.settings_path(SettingsDocument::Overlay(&character));

            return Err(StorageError::NoMarker {
                path: overlay.parent().unwrap_or(&overlay).to_path_buf(),
            });
        };

        Segments::of(data, record)?.page(&page)
    });

    match scrolled {
        Ok(Some((messages, earlier))) => HistoryOutcome::Ok {
            conversation_id: id,
            character_id: character,
            messages,
            earlier,
        },
        Ok(None) => refused(HistoryRefusal::InvalidPage, INVALID_PAGE.to_owned()),
        Err(error) => HistoryOutcome::Failed(StorageFailure::of(&error)),
    }
}

/// A page's messages, and the cursor of the page before it.
type Scrolled = (Vec<HistoryMessage>, Option<String>);

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

    /// Segment `segment`'s committed messages, with the stamps the person's
    /// lines carry and when each was committed.
    fn messages(&mut self, segment: usize) -> Result<&[HistoryMessage], StorageError> {
        if self.read[segment].is_none() {
            let replay = self
                .data
                .session_log(&self.conversation, self.numbers[segment])?
                .read()?;
            let messages = replay
                .records()
                .iter()
                .filter_map(|record| match record.body() {
                    RecordBody::MessageCommitted(commit) => {
                        let message = commit.message().clone();

                        Some(HistoryMessage {
                            message_id: message.id,
                            role: message.role,
                            speaker_id: message.speaker_id,
                            speaker_name: message.speaker_name,
                            text: message.text,
                            committed_at: record.identity().created_at().clone(),
                            source: commit.source().cloned(),
                            client_message_id: commit.client_message_id().cloned(),
                        })
                    }
                    _ => None,
                })
                .collect();

            self.read[segment] = Some(messages);
        }

        Ok(self.read[segment].as_deref().unwrap_or_default())
    }
}
