//! The open thread between the person and one character: lines taken one
//! at a time, a line an earlier run took refused, the turn run, and the
//! segment rotated when its history outgrows the model's window.

use std::num::{NonZeroU32, NonZeroU64};

use p02_characters::Persona;
use p02_contracts::{ConversationTurn, RoleModelAdapter};
use p02_core::{
    CharacterProfile, ClientStamp, ConversationId, EventIdentity, MessageId, Participant,
    SessionId, SpeakerName,
};
use p02_plugins::PluginHost;
use p02_shared::error_chain;
use p02_store::{
    CharacterData, ContinuedFrom, ConversationWriter, Home, LogRecord, RecordBody,
    SessionContinuation, SessionContinued, SessionWriter, SkippedLines, StorageError, Summarizer,
    TakenLines,
};

use crate::continuation;
use crate::turn::{self, CompletedTurn, Ended, Progress, RejectedTurn, RunTurnError};

/// A character as a thread runs her: who she is, and the persona her model
/// is given.
#[derive(Clone, Debug)]
pub struct Character {
    /// Her id, and the name a thread made now gives her.
    pub profile: CharacterProfile,
    pub persona: Persona,
}

/// A line as the person's client sent it, with the stamps it put on it.
#[derive(Clone, Debug)]
pub struct Submission<'a> {
    pub line: &'a str,
    /// The surface the line came from.
    pub source: Option<ClientStamp>,
    /// The id the client submitted the line under, which a repeat of the
    /// line reuses.
    pub client_message_id: Option<ClientStamp>,
}

/// The open thread between the person and one character on one home: the
/// writer of the thread and of its current segment, and the lines its
/// closed segments took. It takes one line at a time, so `&mut self` is
/// its queue.
#[derive(Debug)]
#[must_use = "a thread holds its writers until it is closed"]
pub struct Conversation {
    id: ConversationId,
    cast: Cast,
    /// None once a panic on the blocking pool, or a delivery dropped before
    /// it ended, lost it.
    disk: Option<Disk>,
    skipped: Option<String>,
}

/// What became of a line.
#[derive(Debug)]
pub enum Delivery {
    /// A run before this one took the line, as `message_id`: nothing ran,
    /// and nothing was written.
    Duplicate {
        client_message_id: ClientStamp,
        message_id: MessageId,
    },
    /// The text was no line: its event and the refusal are in the log, and
    /// no message is.
    InputRejected {
        identity: EventIdentity,
        message: String,
    },
    /// The turn completed, and `rotation` says what then became of the
    /// character's memory, when anything did.
    Completed {
        turn: CompletedTurn,
        rotation: Option<Rotation>,
    },
    /// The turn ended refused, the person's line kept.
    Rejected { turn: RejectedTurn },
    /// The runtime itself failed, so the turn is fatal: its caller restarts
    /// the character.
    Failed {
        identity: EventIdentity,
        error: RunTurnError,
    },
}

/// What happened to the character's memory after a completed turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rotation {
    /// The session continues in segment `to`, the oldest turns of `from`
    /// condensed. What failed of ending `from` is reported, the
    /// continuation adopted all the same.
    Rotated {
        from: SessionId,
        to: SessionId,
        summarized_turn_count: NonZeroU32,
        summarizer: Summarizer,
        end_failure: Option<String>,
    },
    /// The continuation was not committed: the thread stays in `from`, and
    /// the next completed turn plans it again.
    Failed { from: SessionId, message: String },
}

/// Who a thread is between, under the names they had when it began, and
/// what the character is given to play herself.
#[derive(Debug)]
pub(crate) struct Cast {
    pub(crate) character: CharacterProfile,
    pub(crate) person: SpeakerName,
    pub(crate) persona: Persona,
}

/// What a line is answered with: the character's model, her plugins, and
/// the size of the model's window in tokens.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Mind<'a> {
    pub(crate) adapter: &'a dyn RoleModelAdapter,
    pub(crate) host: &'a PluginHost,
    pub(crate) context_window: NonZeroU64,
}

/// What a thread keeps on the disk, which only a blocking thread touches.
#[derive(Debug)]
pub(crate) struct Disk {
    data: CharacterData,
    holder: ConversationWriter,
    pub(crate) writer: SessionWriter,
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
    /// its own writer lease, or its first made. The thread keeps the names
    /// its participants had when it began, so `person` names the person only
    /// in a thread made now. The store's work is synchronous and may wait on
    /// a lock, so the caller runs this on the blocking pool.
    ///
    /// # Errors
    ///
    /// [`StorageError`] when the home, her data or the thread is refused, a
    /// lease is held elsewhere, or a segment cannot be read; a lease already
    /// taken is released first.
    pub fn open(
        home: &Home,
        character: Character,
        person: SpeakerName,
    ) -> Result<Self, StorageError> {
        let data = CharacterData::ensure(home, &character.profile.id)?;
        let conversation = home.ensure_conversation(vec![
            Participant::character(character.profile),
            Participant::local_user(person),
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
            cast: Cast {
                character: current.character,
                person: current.person,
                persona: character.persona,
            },
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

    /// Takes one line through the turn, as `adapter` and `host` answer it
    /// within a model window of `context_window` tokens, and continues the
    /// session in a new segment after a completed turn whose history the
    /// window would no longer hold whole. `listener` hears the turn's
    /// progress on the turn's own task, in order, and is never awaited.
    ///
    /// A delivery dropped before it ends loses the thread, as a panic on
    /// the blocking pool does: every later step fails. The thread opens
    /// again once the disk work in flight lets its leases go, and its next
    /// line closes the turn the dropped one left open.
    pub async fn deliver(
        &mut self,
        submission: Submission<'_>,
        adapter: &dyn RoleModelAdapter,
        host: &PluginHost,
        context_window: NonZeroU64,
        listener: &(dyn Fn(Progress) + Send + Sync),
    ) -> Delivery {
        let identity = EventIdentity::mint();

        if let Some(client_message_id) = submission.client_message_id.clone() {
            match self.taken(client_message_id.clone()).await {
                Ok(Some(message_id)) => {
                    return Delivery::Duplicate {
                        client_message_id,
                        message_id,
                    };
                }
                Ok(None) => {}
                Err(error) => return Delivery::Failed { identity, error },
            }
        }

        let Some(session) = self
            .disk
            .as_ref()
            .map(|disk| disk.writer.session_id().clone())
        else {
            return Delivery::Failed {
                identity,
                error: RunTurnError::StateLost,
            };
        };
        let mind = Mind {
            adapter,
            host,
            context_window,
        };

        match turn::run(
            &mut self.disk,
            &identity,
            submission,
            &self.cast,
            mind,
            listener,
        )
        .await
        {
            Ended::InputRejected { message } => Delivery::InputRejected { identity, message },
            Ended::Rejected(turn) => Delivery::Rejected { turn },
            Ended::Failed(error) => Delivery::Failed { identity, error },
            Ended::Completed(turn) => Delivery::Completed {
                turn,
                rotation: self.rotate(session, mind).await,
            },
        }
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

    /// The message a run before this one committed a line submitted as
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

    /// Continues the session `from` in a new segment when the model's window
    /// would no longer hold its history whole. The continuation record is
    /// the commit point: until it lands the thread stays where it was, and
    /// after it the old segment's lines are recorded and its lease is
    /// released, what of that fails reported and never undone.
    async fn rotate(&mut self, from: SessionId, mind: Mind<'_>) -> Option<Rotation> {
        let read = on_disk(&mut self.disk, |disk| {
            let replay = disk.writer.replay()?;

            Ok((replay.history(), replay.user_lines().clone()))
        })
        .await;
        let (history, user_lines) = match read {
            Ok(read) => read,
            Err(error) => {
                return Some(Rotation::Failed {
                    from,
                    message: error_chain(&error),
                });
            }
        };
        let selection = continuation::select(&history.turns, mind.context_window)?;
        let last_event_id = history.turns.last()?.identity.event_id().clone();
        let summary = continuation::summarize(
            mind.adapter,
            selection.summarized,
            history.summary.as_deref(),
            &self.cast.person,
            &self.cast.character.display_name,
            mind.context_window,
        )
        .await;
        let next = Next {
            continued_from: ContinuedFrom {
                session_id: from.clone(),
                last_event_id,
            },
            summary: summary.text,
            summarized_turn_count: selection.summarized_turn_count,
            carried_turns: selection.carried.to_vec(),
            summarizer: summary.summarizer.clone(),
        };
        let continued = on_disk(&mut self.disk, move |disk| Ok(disk.continue_in(next))).await;
        let (ended, to) = match continued {
            Ok(Ok(continued)) => continued,
            Ok(Err(message)) => return Some(Rotation::Failed { from, message }),
            Err(error) => {
                return Some(Rotation::Failed {
                    from,
                    message: error_chain(&error),
                });
            }
        };
        let segment = from.segment();
        let mut failures = Vec::new();

        if let Err(error) = on_disk(&mut self.disk, move |disk| {
            disk.taken.insert(segment, user_lines);
            Ok(disk.taken.write(&disk.data, &disk.holder)?)
        })
        .await
        {
            failures.push(error_chain(&error));
        }

        if let Err(error) = blocking(move || ended.release()).await {
            failures.push(error_chain(&error));
        }

        Some(Rotation::Rotated {
            from,
            to,
            summarized_turn_count: selection.summarized_turn_count,
            summarizer: summary.summarizer,
            end_failure: joined(&failures),
        })
    }
}

/// A thread's current segment under its writer, who the thread is between,
/// the lines its closed segments took, and what reading it skipped; the
/// writer is released again on a failure after it was taken.
struct Current {
    writer: SessionWriter,
    character: CharacterProfile,
    person: SpeakerName,
    taken: TakenLines,
    skipped: Option<String>,
}

fn current_segment(
    data: &CharacterData,
    holder: &ConversationWriter,
) -> Result<Current, StorageError> {
    let mut writer = resume(data, holder)?;

    match read_current(data, holder, &mut writer) {
        Ok((character, person, taken, skipped)) => Ok(Current {
            writer,
            character,
            person,
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
) -> Result<(CharacterProfile, SpeakerName, TakenLines, Option<String>), StorageError> {
    let session = writer.session_id().clone();
    let replay = writer.replay()?;
    let character = replay.session().character().clone();
    let person = replay.session().user_name().clone();
    let skipped = skipped(
        &data.sessions()?.skipped_lines,
        &session,
        replay.skipped_lines(),
    );

    Ok((
        character,
        person,
        taken_lines(data, holder.conversation(), session.segment())?,
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

/// The lines the segments before `current` took: the thread's record of
/// them, completed from every segment it does not cover. The segment just
/// before `current` must be read, as the current one must, since a run can
/// end between a rotation and its record; an older one that cannot be read
/// gives up its lines.
fn taken_lines(
    data: &CharacterData,
    conversation: &p02_core::Conversation,
    current: NonZeroU64,
) -> Result<TakenLines, StorageError> {
    let mut taken = TakenLines::read(data, conversation.id());

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

/// What a rotation whose first record never landed says of the segment it
/// made, when discarding that segment failed too.
const LEFT_EMPTY: &str = "the segment it made stays empty, for the next open to discard";

/// What a continuation records, but the segment it opens.
struct Next {
    continued_from: ContinuedFrom,
    summary: String,
    summarized_turn_count: NonZeroU32,
    carried_turns: Vec<ConversationTurn>,
    summarizer: Summarizer,
}

impl Disk {
    /// Appends a record of `body`, about the event `identity`, to the
    /// current segment.
    pub(crate) fn append(
        &mut self,
        identity: &EventIdentity,
        body: RecordBody,
    ) -> Result<(), RunTurnError> {
        self.writer
            .append(LogRecord::new(identity.clone(), body)?)?;
        Ok(())
    }

    /// Makes the segment after the current one, under its writer, and
    /// commits `next` as its first record, the last step that can fail: a
    /// segment whose record never landed is discarded again through that
    /// writer. Hands back the writer of the segment it continued, for its
    /// end, and the segment it opened.
    fn continue_in(&mut self, next: Next) -> Result<(SessionWriter, SessionId), String> {
        let from = next.continued_from.session_id.clone();
        let mut writer = self
            .data
            .continue_session(&self.holder, &from)
            .map_err(|error| error_chain(&error))?;
        let to = writer.session_id().clone();
        let committed = SessionContinuation::new(
            to.clone(),
            next.continued_from,
            &next.summary,
            next.summarized_turn_count,
            next.carried_turns,
            next.summarizer,
        )
        .and_then(|continuation| {
            LogRecord::new(
                EventIdentity::mint(),
                RecordBody::SessionContinued(SessionContinued {
                    session_continuation: continuation,
                }),
            )
        })
        .map_err(RunTurnError::from)
        .and_then(|record| Ok(writer.append(record)?));

        match committed {
            Ok(()) => Ok((std::mem::replace(&mut self.writer, writer), to)),
            Err(error) => {
                let failure = error_chain(&error);

                match writer.discard() {
                    Ok(()) => Err(failure),
                    Err(discard) => Err(format!(
                        "{failure}; {LEFT_EMPTY}: {}",
                        error_chain(&discard)
                    )),
                }
            }
        }
    }
}

fn joined(failures: &[String]) -> Option<String> {
    (!failures.is_empty()).then(|| failures.join("; "))
}
