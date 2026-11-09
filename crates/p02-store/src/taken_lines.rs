//! The lines a conversation's closed segments took, by segment and by the id
//! each was submitted under: what a delivery asks, to refuse a line taken
//! however far back. One record per conversation,
//! `taken-lines/<conversation>.json` beside the character's sessions,
//! rewritten whole. The segments stay the truth, so a record that is
//! missing or holds anything unexpected reads as none, and is made again
//! from them.

use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::path::PathBuf;

use p02_core::{ClientStamp, Conversation, ConversationId, MessageId, SessionId};
use p02_shared::{create_directories, read_file, write_file_atomically};
use serde_json::{Map, Value};

use crate::character_data::CharacterData;
use crate::conversations::ConversationWriter;
use crate::error::StorageError;

/// By segment, the id each line was submitted under and the message it was
/// committed as.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TakenLines {
    segments: BTreeMap<NonZeroU64, BTreeMap<ClientStamp, MessageId>>,
}

impl TakenLines {
    /// The record of `conversation`, or none when it cannot be read as one.
    #[must_use]
    pub fn read(data: &CharacterData, conversation: &ConversationId) -> Self {
        read_file(&path(data, conversation))
            .ok()
            .and_then(|content| serde_json::from_slice(&content).ok())
            .and_then(|record| decode(&record, conversation))
            .unwrap_or_default()
    }

    /// The lines the segments of `conversation` before `current` took: its
    /// record, completed from every segment the record does not cover, and
    /// nothing written. The segment just before `current` must be read, as
    /// the current one must, since a run can end between a rotation and
    /// its record; an older one that cannot be read gives up its lines.
    ///
    /// # Errors
    ///
    /// An error of reading the segment just before `current`.
    pub fn before(
        data: &CharacterData,
        conversation: &Conversation,
        current: NonZeroU64,
    ) -> Result<Self, StorageError> {
        let mut taken = Self::read(data, conversation.id());

        for segment in (1..current.get()).filter_map(NonZeroU64::new) {
            if taken.covers(segment) {
                continue;
            }

            match data
                .session_log(conversation, segment)
                .and_then(|log| log.read())
            {
                Ok(replay) => taken.insert(segment, replay.user_lines().clone()),
                Err(error) if segment.get() + 1 == current.get() => return Err(error),
                Err(_) => {}
            }
        }

        Ok(taken)
    }

    /// Writes the record of the conversation `writer` holds.
    ///
    /// # Errors
    ///
    /// [`StorageError::Write`] when the write fails.
    pub fn write(
        &self,
        data: &CharacterData,
        writer: &ConversationWriter,
    ) -> Result<(), StorageError> {
        let root = data.taken_lines_root();
        let path = path(data, writer.conversation().id());
        let segments: Map<String, Value> = self
            .segments
            .iter()
            .map(|(segment, lines)| {
                let lines = lines
                    .iter()
                    .map(|(stamp, message)| (stamp.to_string(), Value::String(message.to_string())))
                    .collect();

                (segment.to_string(), Value::Object(lines))
            })
            .collect();
        let mut content = Value::Object(Map::from_iter([(
            "segments".to_owned(),
            Value::Object(segments),
        )]))
        .to_string()
        .into_bytes();

        content.push(b'\n');
        create_directories(&root).map_err(StorageError::write(&root))?;
        write_file_atomically(&path, &content).map_err(StorageError::write(&path))
    }

    /// Whether the record holds segment `segment`'s lines.
    #[must_use]
    pub fn covers(&self, segment: NonZeroU64) -> bool {
        self.segments.contains_key(&segment)
    }

    /// Records the lines segment `segment` took.
    pub fn insert(&mut self, segment: NonZeroU64, lines: BTreeMap<ClientStamp, MessageId>) {
        self.segments.insert(segment, lines);
    }

    /// The message a line submitted under `client_message_id` was
    /// committed as, in whichever segment took it.
    #[must_use]
    pub fn taken(&self, client_message_id: &ClientStamp) -> Option<&MessageId> {
        self.segments
            .values()
            .find_map(|lines| lines.get(client_message_id))
    }
}

impl CharacterData {
    /// The message a line submitted under `id` was committed as in
    /// `conversation`, in whichever of its segments took it, as the disk
    /// holds them now.
    pub(crate) fn taken_line(
        &self,
        conversation: &Conversation,
        id: &ClientStamp,
    ) -> Result<Option<MessageId>, StorageError> {
        let Some(latest) = self.latest_segment(conversation.id())? else {
            return Ok(None);
        };
        let current = latest.session_id().segment();

        if let Some(message) = self
            .session_log(conversation, current)?
            .read()?
            .user_lines()
            .get(id)
        {
            return Ok(Some(message.clone()));
        }

        Ok(TakenLines::before(self, conversation, current)?
            .taken(id)
            .cloned())
    }
}

fn path(data: &CharacterData, conversation: &ConversationId) -> PathBuf {
    data.taken_lines_root()
        .join(format!("{}.json", conversation.as_str()))
}

/// The record's shape exactly, each line a message of its own segment of
/// `conversation`, or no record at all.
fn decode(record: &Value, conversation: &ConversationId) -> Option<TakenLines> {
    let mut segments = BTreeMap::new();

    for (segment, lines) in record.get("segments")?.as_object()? {
        if segment.starts_with('0') || !segment.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }

        let segment = segment.parse().ok()?;
        let session = SessionId::new(conversation.clone(), segment);
        let lines = lines
            .as_object()?
            .iter()
            .map(|(stamp, message)| {
                let message = MessageId::parse(message.as_str()?).ok()?;

                if message.session_id() != &session {
                    return None;
                }

                Some((ClientStamp::new(stamp).ok()?, message))
            })
            .collect::<Option<BTreeMap<_, _>>>()?;

        segments.insert(segment, lines);
    }

    Some(TakenLines { segments })
}
