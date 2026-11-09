//! A character's bot: her thread with the person, opened once the bot
//! knows its name; a paired account's line handed to her inbox; her
//! conversation shown in every paired chat as the stream tells it; and a
//! card with Approve and Deny for each confirmation a turn of this bot's
//! line raises. Nothing is read from history.

use p02_core::{ClientStamp, ConversationId};
use p02_shared::Identifier;
use p02_wire::{
    CharacterState, Event, GatewayMessage, OpenOutcome, PendingConfirmation, RunningTurn,
    StorageFailure, SubmitOutcome, Text, TurnProgress, TurnRefusal, TurnStatus,
};

use crate::bot::{Chat, DAEMON_DOWN, Done, Rules};
use crate::bot_api::Message;
use crate::cards::{CardKind, CardText, Press, confirm, confirmation_ending};
use crate::daemon::short;
use crate::outbox::Target;
use crate::table::{Owner, Snapshot};

const TEXT_ONLY: &str = "I can only read text here for now.";

#[derive(Debug)]
pub(crate) struct Character {
    id: Identifier,
    /// Her thread with the person, where her lines go, once it is open.
    thread: Option<ConversationId>,
    /// Her turn as the daemon last said it, while one runs.
    turn: Option<RunningTurn>,
    /// Whether her thread is being opened.
    opening: bool,
}

impl Character {
    pub(crate) fn new(id: Identifier) -> Self {
        Self {
            id,
            thread: None,
            turn: None,
            opening: false,
        }
    }

    fn name(chat: &Chat) -> String {
        chat.settings().owner.name().to_owned()
    }

    /// Whether a turn of the line `source` carried is shown here: this bot
    /// carried it, or Mirror is on.
    fn shown(chat: &Chat, source: &ClientStamp) -> bool {
        *source == chat.source
            || matches!(chat.settings().owner, Owner::Character { mirror: true, .. })
    }

    /// Opens her thread, unless it is open or being opened.
    fn open(&mut self, chat: &mut Chat) {
        if self.thread.is_some() || self.opening {
            return;
        }

        let Some(daemon) = chat.daemon() else {
            return;
        };
        let id = self.id.clone();

        self.opening = true;
        chat.spawn(async move { Done::Opened(daemon.open(&id).await) });
    }

    /// Hands the line `id` to her inbox, her thread opened first when it is
    /// not known, and waits for the daemon's answer: the update is handed
    /// on only after it, so Telegram lets go of a message once it is
    /// queued. The daemon answers once the line is in her inbox, never
    /// after her turn, so a press behind it that answers a confirmation her
    /// running turn waits on is not held by it. What it says is why the
    /// line was not queued, which its chat is told; nothing once it is, or
    /// once the bot stops.
    async fn hand(&mut self, chat: &mut Chat, id: ClientStamp, text: Text) -> Option<String> {
        let Some(daemon) = chat.daemon() else {
            return Some(DAEMON_DOWN.to_owned());
        };
        let conversation = match &self.thread {
            Some(thread) => thread.clone(),
            None => match chat.unless_stopped(daemon.open(&self.id)).await? {
                Ok(OpenOutcome::Opened {
                    conversation_id, ..
                }) => self.thread.insert(conversation_id).clone(),
                Ok(
                    OpenOutcome::Refused { message, .. }
                    | OpenOutcome::Failed(StorageFailure { message, .. }),
                ) => return Some(unavailable(chat, &message)),
                Err(_) => return Some(DAEMON_DOWN.to_owned()),
            },
        };
        let message = GatewayMessage {
            conversation_id: short(conversation.as_str()),
            text,
            source: chat.source.clone(),
            client_message_id: id,
        };

        match chat.unless_stopped(daemon.deliver(&message)).await? {
            Ok(
                SubmitOutcome::Queued
                | SubmitOutcome::AlreadyQueued
                // A line the daemon took already under this id, which
                // Telegram handed on again.
                | SubmitOutcome::Refused {
                    reason: TurnRefusal::DuplicateSubmission,
                    ..
                },
            ) => None,
            Ok(
                SubmitOutcome::Refused { message, .. }
                | SubmitOutcome::Failed(StorageFailure { message, .. }),
            ) => Some(unavailable(chat, &message)),
            Err(_) => Some(DAEMON_DOWN.to_owned()),
        }
    }

    /// Her turn as the daemon says it now, none once it ended: its drafts
    /// brought to their words in the chats, posted where none is when it
    /// is shown here, and a draft shown that it no longer holds withdrawn.
    fn running(&mut self, chat: &Chat, turn: Option<RunningTurn>) {
        let (drafts, shown) = turn.as_ref().map_or((Vec::new(), false), |turn| {
            (turn.drafts.clone(), Self::shown(chat, &turn.source))
        });

        chat.outbox.drafts(drafts, shown);
        self.turn = turn;
    }

    /// A confirmation of hers that a turn of this bot's line raised is
    /// shown in the chat the line came from, and one raised with no turn,
    /// or whose line's chat is paired no longer, in every paired chat.
    /// Another surface's turn leaves it to that surface.
    fn raise_card(&self, chat: &Chat, pending: &PendingConfirmation) {
        if pending.character_id != self.id {
            return;
        }

        let to = match &pending.turn {
            None => Target::EveryPaired,
            Some(turn) if turn.source == chat.source => {
                chat_of_line(&turn.client_message_id).map_or(Target::EveryPaired, Target::Chat)
            }
            Some(_) => return,
        };

        chat.outbox.card(
            CardKind::Confirmation,
            pending.id.to_string(),
            CardText::Confirmation {
                pending: pending.clone(),
                name: Self::name(chat),
                raised_on: None,
            },
            to,
        );
    }

    /// What her turn says as it goes: its line shown as the person's when
    /// another surface carried it, and each reply ending its draft as
    /// committed.
    fn progressed(&self, chat: &Chat, progress: &TurnProgress) {
        match progress {
            TurnProgress::UserMessage { source, text, .. } if Self::shown(chat, source) => {
                chat.outbox
                    .started((*source != chat.source).then(|| format!("You ({source}): {text}")));
            }
            TurnProgress::VisibleReply { draft_id, text, .. } => {
                let shown = self
                    .turn
                    .as_ref()
                    .is_some_and(|turn| Self::shown(chat, &turn.source));

                chat.outbox.commit(draft_id, text.to_string(), shown);
            }
            _ => {}
        }
    }
}

impl Rules for Character {
    fn started(&mut self, chat: &mut Chat) {
        self.open(chat);
    }

    async fn message(&mut self, chat: &mut Chat, message: Message) {
        let account = message.chat.id;

        match message.text.filter(|text| !text.is_empty()) {
            None => chat.outbox.say_to_paired(account, TEXT_ONLY.to_owned()),
            Some(text) if text.split_whitespace().next() == Some("/start") => {
                chat.outbox.say_to_paired(
                    account,
                    format!("Hi, I'm {}. Write to me here.", Self::name(chat)),
                );
            }
            Some(text) => {
                let (Some(id), Ok(text)) =
                    (line_id(chat.id, account, message.id), Text::new(&text))
                else {
                    return;
                };

                chat.outbox.typing(account);

                if let Some(told) = self.hand(chat, id, text).await {
                    chat.outbox.say_to_paired(account, told);
                }
            }
        }
    }

    /// A card this bot shows is a confirmation's.
    async fn press(&mut self, chat: &mut Chat, press: &Press) -> Option<String> {
        match press.kind {
            CardKind::Confirmation => confirm(chat, press).await,
            CardKind::Pairing => None,
        }
    }

    /// On a stream the daemon could not resume, her turn is the snapshot's:
    /// a draft shown here that it still carries keeps its message and is
    /// brought to its words, and one it does not is withdrawn. A card whose
    /// confirmation the snapshot no longer holds is ended, and one still
    /// waiting has its card where it should.
    fn install(&mut self, chat: &mut Chat, snapshot: &Snapshot) {
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.character_id == self.id)
            .cloned();

        self.running(chat, turn);
        self.open(chat);
        chat.outbox.keep_cards(
            CardKind::Confirmation,
            snapshot
                .confirmations
                .iter()
                .map(|pending| pending.id.to_string())
                .collect(),
        );

        for pending in &snapshot.confirmations {
            self.raise_card(chat, pending);
        }
    }

    fn frame(&mut self, chat: &mut Chat, event: &Event) {
        match event {
            Event::TurnRunning(turn) if turn.character_id == self.id => {
                self.running(chat, Some(turn.clone()));
            }
            Event::TurnProgress {
                character_id,
                progress,
                ..
            } if *character_id == self.id => self.progressed(chat, progress),
            Event::TurnCompleted {
                character_id,
                source,
                client_message_id,
                status,
                committed,
                message,
                ..
            } if *character_id == self.id => {
                if *source == chat.source
                    && matches!(status, TurnStatus::Rejected | TurnStatus::Failed)
                    && let Some(account) = chat_of_line(client_message_id)
                {
                    chat.outbox.say_to_paired(
                        account,
                        unanswered(chat, *status, *committed, message.as_deref()),
                    );
                }

                if self.turn.as_ref().is_some_and(|turn| event.ends(turn)) {
                    self.running(chat, None);
                }
            }
            Event::StateChanged {
                character_id,
                state: CharacterState::Ready,
                ..
            } if *character_id == self.id => self.open(chat),
            Event::ConfirmationRequested(pending) => self.raise_card(chat, pending),
            Event::ConfirmationSettled { id, settlement, .. } => chat.outbox.end_card(
                CardKind::Confirmation,
                id.to_string(),
                confirmation_ending(*settlement),
            ),
            _ => {}
        }
    }

    fn done(&mut self, _chat: &mut Chat, done: Done) {
        match done {
            Done::Toasted => {}
            Done::Opened(opened) => {
                self.opening = false;

                // One she cannot open yet is opened once she is ready, by
                // the next line, or by the next snapshot.
                if let Ok(OpenOutcome::Opened {
                    conversation_id, ..
                }) = opened
                {
                    self.thread = Some(conversation_id);
                }
            }
        }
    }
}

/// What the chat of a line of this bot's is told when its turn was
/// rejected or failed: why, in the daemon's words, and whether to send the
/// line again.
fn unanswered(chat: &Chat, status: TurnStatus, committed: bool, message: Option<&str>) -> String {
    let why = message.unwrap_or(match status {
        TurnStatus::Rejected => "rejected",
        _ => "failed",
    });
    let again = if committed {
        ""
    } else {
        "\nYour message was not taken; send it again."
    };

    format!("{} could not answer: {why}{again}", Character::name(chat))
}

/// What a chat is told when she cannot take its line, and why.
fn unavailable(chat: &Chat, why: &str) -> String {
    format!(
        "{} is not available right now: {why}",
        Character::name(chat)
    )
}

/// The id of a line: it names the bot, the chat and the message, so a
/// message Telegram hands on again is the line it was. Telegram numbers
/// messages within a chat, and a bot that replaces this one opens a chat of
/// its own, numbered from one again.
fn line_id(bot: i64, chat: i64, message: i64) -> Option<ClientStamp> {
    ClientStamp::new(&format!("{bot}.{chat}.{message}")).ok()
}

/// The account whose chat a line of this bot's came from, as its id names
/// it.
fn chat_of_line(id: &ClientStamp) -> Option<i64> {
    id.as_str().split('.').nth(1)?.parse().ok()
}
