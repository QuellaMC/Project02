//! A home's conversations, `conversations/<id>/conversation.json`: one file
//! per thread, made under the catalog's lock. The directories are the
//! catalog; a directory whose file was never written is a make a crash
//! interrupted, and no thread.

use std::io;
use std::path::Path;

use p02_core::{Conversation, ConversationId, Participant, Timestamp};
use p02_shared::{
    PathEntry, create_directories, describe_entry, list_directory, read_file, remove_directory,
    write_file_atomically,
};

use crate::error::StorageError;
use crate::home::Home;
use crate::layout::{CONVERSATION_FILE, EntryKind, FINDER_METADATA};
use crate::lock::{Lease, Resource, acquire, with_lock};

/// One process's hold on an open conversation, refused at once to every
/// other: only its holder makes the conversation's segments and writes the
/// record of its taken lines. It holds the conversation as it began, so
/// every segment it makes speaks of its participants by the names they had
/// then.
#[derive(Debug)]
#[must_use = "a writer holds its conversation until it is released"]
pub struct ConversationWriter {
    conversation: Conversation,
    lease: Lease,
}

impl ConversationWriter {
    #[must_use]
    pub fn conversation(&self) -> &Conversation {
        &self.conversation
    }

    /// Releases the conversation.
    pub fn release(self) {
        self.lease.release();
    }
}

impl Home {
    /// The one conversation between exactly `participants`, made the first
    /// time it is asked for, with a new id, `conv_` and a random UUID.
    /// Participants are told apart by kind and id: their names are the ones
    /// they had when the thread began.
    ///
    /// # Errors
    ///
    /// [`StorageError`] when the home is refused, a thread there cannot be
    /// read, the participants make no conversation, or a write fails.
    pub fn ensure_conversation(
        &self,
        participants: Vec<Participant>,
    ) -> Result<Conversation, StorageError> {
        self.check()?;

        with_lock(&self.locks_root(), &Resource::ConversationsCatalog, || {
            if let Some(existing) = self
                .conversations()?
                .into_iter()
                .find(|conversation| conversation.is_between(&participants))
            {
                return Ok(existing);
            }

            let conversation =
                Conversation::new(ConversationId::mint(), participants, Timestamp::now())
                    .map_err(StorageError::InvalidParticipants)?;

            self.ensure()?;
            self.write_conversation(&conversation, &write_file_atomically)?;
            Ok(conversation)
        })
    }

    /// Writes the record of `conversation`, new, in a directory made for it,
    /// with `write`; when the write fails the directory is taken back, so a
    /// make that fails leaves nothing.
    pub(crate) fn write_conversation(
        &self,
        conversation: &Conversation,
        write: &dyn Fn(&Path, &[u8]) -> io::Result<()>,
    ) -> Result<(), StorageError> {
        let directory = self.conversations_root().join(conversation.id().as_str());
        let path = directory.join(CONVERSATION_FILE);
        let mut content = serde_json::to_vec(conversation)
            .expect("a conversation of plain fields always serializes");

        content.push(b'\n');
        create_directories(&directory).map_err(StorageError::write(&directory))?;

        if let Err(source) = write(&path, &content) {
            remove_directory(&directory).map_err(StorageError::write(&directory))?;
            return Err(StorageError::Write { path, source });
        }

        Ok(())
    }

    /// The conversation `id`.
    ///
    /// # Errors
    ///
    /// [`StorageError::ConversationNotFound`] when the home holds no such
    /// thread, or an error when the home is refused or the thread's record
    /// cannot be read or is malformed.
    pub fn conversation(&self, id: &ConversationId) -> Result<Conversation, StorageError> {
        self.check()?;

        read_conversation(&self.conversations_root().join(id.as_str()))?
            .ok_or_else(|| StorageError::ConversationNotFound(id.clone()))
    }

    /// Every conversation of the home, oldest first: by when each began,
    /// then by id, both in code-point order.
    ///
    /// # Errors
    ///
    /// [`StorageError`] when the home is refused, or a thread there cannot
    /// be read or is malformed.
    pub fn conversations(&self) -> Result<Vec<Conversation>, StorageError> {
        self.check()?;

        let root = self.conversations_root();
        let entries = match list_directory(&root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => return Err(StorageError::Read { path: root, source }),
        };
        let mut conversations = Vec::new();

        for (name, _) in entries {
            if name == FINDER_METADATA {
                continue;
            }

            if let Some(conversation) = read_conversation(&root.join(&name))? {
                conversations.push(conversation);
            }
        }

        conversations.sort_by(|left, right| {
            (left.created_at(), left.id()).cmp(&(right.created_at(), right.id()))
        });
        Ok(conversations)
    }

    /// The writer's hold on `conversation`.
    ///
    /// # Errors
    ///
    /// [`StorageError::Busy`] while another process holds it, or a refusal
    /// of [`Home::check`].
    pub fn conversation_writer(
        &self,
        conversation: Conversation,
    ) -> Result<ConversationWriter, StorageError> {
        self.check()?;

        let lease = acquire(&[(
            &self.locks_root(),
            &Resource::ConversationWriter(conversation.id()),
        )])?;

        Ok(ConversationWriter {
            conversation,
            lease,
        })
    }
}

/// The conversation in `directory`, `None` when there is none or its file
/// was never written.
fn read_conversation(directory: &Path) -> Result<Option<Conversation>, StorageError> {
    match describe_entry(directory) {
        PathEntry::Absent => return Ok(None),
        PathEntry::Directory => {}
        PathEntry::Unreadable(source) => {
            return Err(StorageError::Read {
                path: directory.to_path_buf(),
                source,
            });
        }
        PathEntry::File | PathEntry::Link | PathEntry::Other => {
            return Err(StorageError::NotReal {
                path: directory.to_path_buf(),
                expected: EntryKind::Directory,
            });
        }
    }

    let path = directory.join(CONVERSATION_FILE);

    match describe_entry(&path) {
        PathEntry::Absent => return Ok(None),
        PathEntry::File => {}
        PathEntry::Unreadable(source) => return Err(StorageError::Read { path, source }),
        PathEntry::Directory | PathEntry::Link | PathEntry::Other => {
            return Err(StorageError::NotReal {
                path,
                expected: EntryKind::File,
            });
        }
    }

    let content = match read_file(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(StorageError::Read { path, source }),
    };
    let conversation: Conversation =
        serde_json::from_slice(&content).map_err(|source| StorageError::MalformedConversation {
            path: path.clone(),
            source,
        })?;

    if directory.file_name() != Some(conversation.id().as_str().as_ref()) {
        return Err(StorageError::MisplacedConversation {
            path,
            named: conversation.id().clone(),
        });
    }

    Ok(Some(conversation))
}
