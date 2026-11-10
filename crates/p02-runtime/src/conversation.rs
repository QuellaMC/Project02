//! The open thread between the person and one character: its segment
//! under its writer, the turns it takes one at a time, a line of the
//! person's or a moment of hers, and the lines its closed segments took.

use std::num::{NonZeroU32, NonZeroU64};

use async_trait::async_trait;
use p02_characters::Persona;
use p02_contracts::{ConversationTurn, RoleModelAdapter};
use p02_core::{
    CharacterProfile, ClientStamp, ConversationId, EventId, EventIdentity, MessageId, Participant,
    SessionId, SpeakerName,
};
use p02_plugins::PluginHost;
use p02_shared::error_chain;
use p02_store::{
    CharacterData, ContinuedFrom, ConversationWriter, Home, LogRecord, RecordBody,
    SessionContinuation, SessionContinued, SessionWriter, SkippedLines, StorageError, Summarizer,
    TakenLines,
};

use crate::turn::{self, CompletedTurn, Occasion, Progress, RejectedTurn, RunTurnError};

/// A character as a thread runs her: who she is, and the persona her model
/// is given.
#[derive(Clone, Debug)]
pub struct Character {
    /// Her id, and the name her replies carry.
    pub profile: CharacterProfile,
    pub persona: Persona,
}

/// A line as the person's client sent it, with the stamps it put on it.
#[derive(Clone, Debug)]
pub struct Submission<'a> {
    pub line: &'a str,
    /// The surface the line came from.
    pub source: ClientStamp,
    /// The id the client submitted the line under, which a repeat of the
    /// line reuses.
    pub client_message_id: ClientStamp,
}

/// The open thread between the person and one character on one home: the
/// writer of the thread and of its current segment, and the lines its
/// closed segments took. It takes one turn at a time, so `&mut self` is
/// its queue.
#[derive(Debug)]
#[must_use = "a thread holds its writers until it is closed"]
pub struct Conversation {
    id: ConversationId,
    character: Character,
    /// None once a panic on the blocking pool, or a delivery dropped before
    /// it ended, lost it.
    disk: Option<Disk>,
    skipped: Option<String>,
}

/// What became of a line, or of a moment of hers, which is neither a
/// duplicate nor a blank text.
#[derive(Debug)]
pub enum Delivery {
    /// A turn took the line already, as `message_id`: nothing ran, and
    /// nothing was written.
    Duplicate {
        client_message_id: ClientStamp,
        message_id: MessageId,
    },
    /// The text was no line: its event and the refusal are in the log, and
    /// no message is.
    InputRejected { message: String },
    /// The turn completed, and the session continued after it when it was
    /// due to.
    Completed(CompletedTurn),
    /// The turn ended refused, what it committed kept.
    Rejected(RejectedTurn),
    /// The runtime itself failed, so the turn is fatal: its caller restarts
    /// the character.
    Failed(RunTurnError),
}

/// What a turn is answered with: the name the person goes by, the
/// character's model, her plugins, and the size of her model's window in
/// tokens, as her settings say. Its keeper brings it up to date before her
/// turn, and the turn before each request to the model after its first.
#[async_trait]
pub trait Mind: Send + Sync {
    fn person(&self) -> &SpeakerName;

    fn adapter(&self) -> &dyn RoleModelAdapter;

    fn host(&self) -> &PluginHost;

    fn context_window(&self) -> NonZeroU64;

    /// Built again from her settings when they changed since it was
    /// built: true when it was.
    ///
    /// # Errors
    ///
    /// The sentence that says why her settings no longer build her.
    async fn refresh(&mut self) -> Result<bool, String>;
}

/// What a thread keeps on the disk, which only a blocking thread touches.
#[derive(Debug)]
pub(crate) struct Disk {
    data: CharacterData,
    holder: ConversationWriter,
    pub(crate) writer: SessionWriter,
    /// The lines its closed segments took.
    taken: TakenLines,
}

/// Runs `work` over the thread's disk state on tokio's blocking pool, where
/// the store may wait on a lock, and puts the state back. A panic in `work`
/// loses the state, and every later step is refused: the fatal path, on
/// which the character restarts.
pub(crate) async fn on_disk<T: Send + 'static>(
    slot: &mut Option<Disk>,
    work: impl FnOnce(&mut Disk) -> Result<T, RunTurnError> + Send + 'static,
) -> Result<T, RunTurnError> {
    let mut disk = slot.take().ok_or(RunTurnError::StateLost)?;
    let (disk, done) = blocking(move || {
        let done = work(&mut disk);

        (disk, done)
    })
    .await?;

    *slot = Some(disk);
    done
}

/// Runs `work` on tokio's blocking pool: the one way the runtime reaches
/// the disk.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, RunTurnError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(RunTurnError::Interrupted)
}

impl Conversation {
    /// Opens the one thread between the person and `character` on `home`:
    /// her data directory and the thread are made the first time, the
    /// thread's writer lease is taken, and its latest segment resumed under
    /// its own writer lease, or its first made. The store's work is
    /// synchronous and may wait on a lock, so the caller runs this on the
    /// blocking pool.
    ///
    /// # Errors
    ///
    /// [`StorageError`] when the home, her data or the thread is refused, a
    /// lease is held elsewhere, or a segment cannot be read; a lease already
    /// taken is released first.
    pub fn open(home: &Home, character: Character) -> Result<Self, StorageError> {
        let data = CharacterData::ensure(home, &character.profile.id)?;
        let conversation = home.ensure_conversation(vec![
            Participant::character(character.profile.id.clone()),
            Participant::local_user(),
        ])?;
        let holder = home.conversation_writer(conversation)?;
        let current = match current_segment(&data, &holder) {
            Ok(current) => current,
            Err(error) => {
                holder.release();
                return Err(error);
            }
        };

        Ok(Self {
            id: holder.conversation().id().clone(),
            character,
            disk: Some(Disk {
                data,
                holder,
                writer: current.writer,
                taken: current.taken,
            }),
            skipped: current.skipped,
        })
    }

    #[must_use]
    pub fn id(&self) -> &ConversationId {
        &self.id
    }

    /// What the open read past because it could not be read, rows of her
    /// sessions catalog and lines of the segment it resumed, in a
    /// sentence; none when it read everything.
    #[must_use]
    pub fn skipped(&self) -> Option<&str> {
        self.skipped.as_deref()
    }

    /// Takes one line through the turn, as `mind` answers it, unless a turn
    /// took it already. `listener` hears the turn's progress on the turn's
    /// own task, in order, and is never awaited.
    ///
    /// A delivery dropped before it ends loses the thread, as a panic on
    /// the blocking pool does: every later step fails. The thread opens
    /// again once the disk work in flight lets its leases go, and its next
    /// line closes the turn the dropped one left open.
    pub async fn deliver(
        &mut self,
        submission: Submission<'_>,
        mind: &mut dyn Mind,
        listener: &(dyn Fn(Progress) + Send + Sync),
    ) -> Delivery {
        match self.taken(submission.client_message_id.clone()).await {
            Ok(Some(message_id)) => Delivery::Duplicate {
                client_message_id: submission.client_message_id,
                message_id,
            },
            Ok(None) => {
                turn::take(&mut self.disk, submission, &self.character, mind, listener).await
            }
            Err(error) => Delivery::Failed(error),
        }
    }

    /// Takes a moment of hers through the turn, as `mind` answers it: a turn
    /// nobody began, which commits no line of the person's and may end
    /// without a word. `listener` hears it as it hears a line's turn, and a
    /// delivery dropped before it ends loses the thread as a line's does.
    pub async fn moment(
        &mut self,
        mind: &mut dyn Mind,
        listener: &(dyn Fn(Progress) + Send + Sync),
    ) -> Delivery {
        turn::run(
            &mut self.disk,
            Occasion::Moment,
            &self.character,
            mind,
            listener,
        )
        .await
    }

    /// Ends the thread: the segment's lease is released, then the
    /// thread's. What failed, in a sentence, when anything did.
    pub async fn close(mut self) -> Option<String> {
        let Some(disk) = self.disk.take() else {
            return Some(error_chain(&RunTurnError::StateLost));
        };
        let Disk { writer, holder, .. } = disk;

        blocking(move || {
            writer.release();
            holder.release();
        })
        .await
        .err()
        .map(|error| error_chain(&error))
    }

    /// The message a turn committed a line submitted as
    /// `client_message_id` as, in the current segment or a closed one.
    async fn taken(
        &mut self,
        client_message_id: ClientStamp,
    ) -> Result<Option<MessageId>, RunTurnError> {
        on_disk(&mut self.disk, move |disk| {
            let current = disk
                .writer
                .replay()?
                .user_lines()
                .get(&client_message_id)
                .cloned();

            Ok(current.or_else(|| disk.taken.taken(&client_message_id).cloned()))
        })
        .await
    }
}

/// A thread's current segment under its writer, the lines its closed
/// segments took, and what reading it skipped; the writer is released again
/// on a failure after it was taken.
struct Current {
    writer: SessionWriter,
    taken: TakenLines,
    skipped: Option<String>,
}

fn current_segment(
    data: &CharacterData,
    holder: &ConversationWriter,
) -> Result<Current, StorageError> {
    let mut writer = resume(data, holder)?;

    match read_current(data, holder, &mut writer) {
        Ok((taken, skipped)) => Ok(Current {
            writer,
            taken,
            skipped,
        }),
        Err(error) => {
            writer.release();
            Err(error)
        }
    }
}

/// What [`Current`] holds beside the writer of its segment.
fn read_current(
    data: &CharacterData,
    holder: &ConversationWriter,
    writer: &mut SessionWriter,
) -> Result<(TakenLines, Option<String>), StorageError> {
    let session = writer.session_id().clone();
    let skipped = skipped(
        &data.sessions()?.skipped_lines,
        &session,
        writer.replay()?.skipped_lines(),
    );

    Ok((
        TakenLines::before(data, holder.conversation(), session.segment())?,
        skipped,
    ))
}

/// What reading `rows` of her sessions catalog and `lines` of `session`
/// skipped, in a sentence, when either skipped anything.
fn skipped(rows: &SkippedLines, session: &SessionId, lines: &SkippedLines) -> Option<String> {
    let mut parts = Vec::new();

    if !rows.is_empty() {
        parts.push(format!("{rows} of her sessions catalog"));
    }

    if !lines.is_empty() {
        parts.push(format!("{lines} of session {session}"));
    }

    (!parts.is_empty()).then(|| {
        format!(
            "Skipped what could not be read, {}; the rest was read.",
            parts.join(" and ")
        )
    })
}

/// The thread's latest whole segment under its writer, or its first, made
/// now. A latest segment past the first that holds no record is what a
/// rotation interrupted before its continuation record left: it is
/// discarded, and the one before it tried.
fn resume(
    data: &CharacterData,
    holder: &ConversationWriter,
) -> Result<SessionWriter, StorageError> {
    let conversation = holder.conversation();

    loop {
        let Some(latest) = data.latest_segment(conversation.id())? else {
            return data.create_session(holder);
        };
        let segment = latest.session_id().segment();
        let mut writer = data.session_log(conversation, segment)?.writer()?;
        let left_by_a_rotation = match writer.replay() {
            Ok(replay) => segment > NonZeroU64::MIN && replay.records().is_empty(),
            Err(error) => {
                writer.release();
                return Err(error);
            }
        };

        if !left_by_a_rotation {
            return Ok(writer);
        }

        writer.discard()?;
    }
}

/// What a rotation whose first record never landed says of the segment it
/// made, when discarding that segment failed too.
const LEFT_EMPTY: &str = "the segment it made stays empty, for the next open to discard";

/// What a continuation records, but the segments it continues and opens.
#[derive(Debug)]
pub(crate) struct Next {
    /// The event of the turn the segment it continues ended on.
    pub(crate) last_event_id: EventId,
    pub(crate) summary: String,
    pub(crate) summarized_turn_count: NonZeroU32,
    pub(crate) carried_turns: Vec<ConversationTurn>,
    pub(crate) summarizer: Summarizer,
}

impl Disk {
    /// Appends a record of `body`, about the event `identity`, to the
    /// current segment.
    pub(crate) fn append(
        &mut self,
        identity: &EventIdentity,
        body: RecordBody,
    ) -> Result<(), RunTurnError> {
        self.writer.append(LogRecord::new(identity.clone(), body))?;
        Ok(())
    }

    /// Continues the current segment in the next, `next` its first record
    /// and the commit point: a segment whose record never landed is
    /// discarded again through its writer, and the thread stays where it
    /// was. After it, the lines the old segment took are recorded and its
    /// lease released, what fails of that never undone. What failed, in a
    /// sentence.
    pub(crate) fn continue_in(&mut self, next: Next) -> Option<String> {
        let from = self.writer.session_id().clone();
        let lines = match self.writer.replay() {
            Ok(replay) => replay.user_lines().clone(),
            Err(error) => return Some(error_chain(&error)),
        };
        let mut writer = match self.data.continue_session(&self.holder, &from) {
            Ok(writer) => writer,
            Err(error) => return Some(error_chain(&error)),
        };
        let continuation = SessionContinuation::new(
            writer.session_id().clone(),
            ContinuedFrom {
                session_id: from.clone(),
                last_event_id: next.last_event_id,
            },
            next.summary,
            next.summarized_turn_count,
            next.carried_turns,
            next.summarizer,
        );

        if let Err(error) = writer.append(LogRecord::new(
            EventIdentity::mint(),
            RecordBody::SessionContinued(SessionContinued {
                session_continuation: continuation,
            }),
        )) {
            let failure = error_chain(&error);

            return Some(match writer.discard() {
                Ok(()) => failure,
                Err(discard) => format!("{failure}; {LEFT_EMPTY}: {}", error_chain(&discard)),
            });
        }

        let ended = std::mem::replace(&mut self.writer, writer);

        self.taken.insert(from.segment(), lines);

        let recorded = self.taken.write(&self.data, &self.holder);

        ended.release();
        recorded.err().map(|error| error_chain(&error))
    }
}
