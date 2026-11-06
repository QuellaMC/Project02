//! The lines a conversation's closed segments took, by segment and by the id
//! each was submitted under: what a delivery asks, to refuse a line an
//! earlier run took however far back. One record per conversation,
//! `taken-lines/<conversation>.json` beside the character's sessions,
//! rewritten whole. The segments stay the truth, so a record that is
//! missing or holds anything unexpected reads as none, and is made again
//! from them.

use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::path::PathBuf;

use p02_core::{ClientStamp, ConversationId, MessageId, SessionId};
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
