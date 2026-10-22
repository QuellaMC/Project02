//! A character's bot: her thread with the person, opened once the bot
//! knows its name; the pairing gate on every message and press; a paired
//! account's line carried to her; her conversation shown in every paired
//! chat as the stream tells it; and a card with Approve and Deny for each
//! confirmation a turn of this bot's line raises. Nothing is read from
//! history.

use std::collections::VecDeque;
use std::sync::Arc;

use p02_app::{
    CharacterState, Event, OpenOutcome, PendingConfirmation, RunningTurn, RunningTurns,
    StorageFailure, TurnOutcome, TurnProgress, TurnRefusal, TurnStatus,
};
use p02_core::{ClientStamp, ConversationId};
use p02_gateway::{GatewayMessage, Text};
use p02_shared::Identifier;
use tokio::time::Instant;

use crate::backoff;
use crate::bot::{Chat, DAEMON_DOWN, Done, Rules};
use crate::bot_api::{CallbackQuery, Update};
use crate::cards::{CardKind, CardText, Press, confirm, confirmation_ending};
use crate::daemon::short;
use crate::gate::Gate;
use crate::outbox::Target;
use crate::table::{Owner, Snapshot};

const TEXT_ONLY: &str = "I can only read text here for now.";

/// Her thread with the person: the conversation, and who the person is in
/// it.
#[derive(Debug)]
struct Thread {
    conversation: ConversationId,
    sender: Identifier,
}

/// A line waiting to be carried to her.
#[derive(Debug)]
struct Line {
    chat: i64,
    id: ClientStamp,
    text: Text,
}

/// Where opening her thread stands.
#[derive(Debug)]
enum Opening {
    Idle,
    Asked,
    /// Asked again at this instant: the daemon could not be reached.
    Again(Instant),
}

#[derive(Debug)]
pub(crate) struct Character {
    id: Identifier,
    /// The stamp on every line this bot carries.
    source: ClientStamp,
    gate: Gate,
    thread: Option<Thread>,
    /// Every running turn, folded by the contract's one rule; her thread's
    /// is the one shown.
    turns: RunningTurns,
    /// Her turn frames from before her thread was known, followed once it
    /// is.
    held: Vec<Arc<Event>>,
    /// The lines waiting to be carried, oldest first.
    lines: VecDeque<Line>,
    /// The line handed to her that she has not taken yet: the next waits
    /// for it, since she takes lines in the order they reach her.
    handed: Option<ClientStamp>,
    opening: Opening,
    open_failures: u32,
}

impl Character {
    pub(crate) fn new(id: Identifier, chat: &Chat) -> Self {
        Self {
            id,
            source: ClientStamp::new(&format!("telegram:{}", chat.username))
                .expect("a bot's username is letters, digits and underscores"),
            gate: Gate::default(),
            thread: None,
            turns: RunningTurns::default(),
            held: Vec::new(),
            lines: VecDeque::new(),
            handed: None,
            opening: Opening::Idle,
            open_failures: 0,
        }
    }

    fn name(chat: &Chat) -> String {
        chat.settings().owner.name().to_owned()
    }

    /// Whether a turn is shown here: this bot carried its line, or Mirror
    /// is on.
    fn shown(&self, chat: &Chat, turn: &RunningTurn) -> bool {
        turn.source == self.source
            || matches!(chat.settings().owner, Owner::Character { mirror: true, .. })
    }

    fn her_turn(&self) -> Option<&RunningTurn> {
        self.turns.get(&self.thread.as_ref()?.conversation)
    }

    /// Opens her thread, unless it is open or being opened.
    fn open(&mut self, chat: &mut Chat) {
        if self.thread.is_some() || matches!(self.opening, Opening::Asked) {
            return;
        }

        let Some(daemon) = chat.daemon() else {
            return;
        };
        let id = self.id.clone();

        self.opening = Opening::Asked;
        chat.spawn(async move { Done::Opened(daemon.open(&id).await) });
    }

    /// Hands her the next line once she has taken the one before it,
    /// opening her thread first when it is not known. The delivery then
    /// waits for its turn, however long, while the lines after it go on.
    fn carry(&mut self, chat: &mut Chat) {
        if self.handed.is_some() || self.lines.is_empty() {
            return;
        }

        let Some(thread) = &self.thread else {
            self.open(chat);
            return;
        };
        let Some(daemon) = chat.daemon() else {
            return;
        };
        let Some(line) = self.lines.pop_front() else {
            return;
        };
        let message = GatewayMessage {
            conversation_id: short(thread.conversation.as_str()),
            sender_id: short(thread.sender.as_str()),
            text: line.text,
            source: self.source.clone(),
            client_message_id: line.id.clone(),
        };

        self.handed = Some(line.id);
        chat.spawn(async move {
            Done::Delivered {
                chat: line.chat,
                outcome: daemon.deliver(&message).await,
                id: message.client_message_id,
            }
        });
    }

    /// The line waiting first is told, in its chat, why her thread could
    /// not be opened for it, and the next asks again.
    fn unopened(&mut self, chat: &mut Chat, told: String) {
        if let Some(line) = self.lines.pop_front() {
            chat.outbox.say_to_paired(line.chat, told);
        }

        self.carry(chat);
    }

    fn opened(&mut self, chat: &mut Chat, thread: Thread) {
        self.open_failures = 0;
        self.thread = Some(thread);
        self.show_drafts(chat);

        for event in std::mem::take(&mut self.held) {
            self.frame(chat, &event);
        }

        self.carry(chat);
    }

    /// Her thread's drafts as the fold has them, brought to their words in
    /// the chats: posted where none is, edited where one shows other words.
    fn show_drafts(&self, chat: &Chat) {
        let Some(turn) = self.her_turn() else {
            return;
        };
        let shown = self.shown(chat, turn);

        for draft in &turn.drafts {
            chat.outbox
                .draft(&draft.draft_id, draft.text.clone(), shown);
        }
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
            Some(turn) if turn.source == self.source => {
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

    /// A turn of her thread, as the stream tells it: its line shown as the
    /// person's when another surface carried it, its reply as it is
    /// written, then as committed; and, for a line of this bot's that did
    /// not complete, why, in the chat it came from.
    fn follow_turn(&self, chat: &Chat, event: &Event) {
        match event {
            Event::TurnCompleted {
                source,
                client_message_id,
                status,
                committed,
                message,
                ..
            } => {
                let unanswered = matches!(status, TurnStatus::Rejected | TurnStatus::Failed);

                if *source == self.source
                    && unanswered
                    && let Some(account) = chat_of_line(client_message_id)
                {
                    let why = message.clone().unwrap_or_else(|| {
                        match status {
                            TurnStatus::Rejected => "rejected",
                            _ => "failed",
                        }
                        .to_owned()
                    });
                    let again = if *committed {
                        ""
                    } else {
                        "\nYour message was not taken; send it again."
                    };

                    chat.outbox.say_to_paired(
                        account,
                        format!("{} could not answer: {why}{again}", Self::name(chat)),
                    );
                }
            }
            Event::TurnProgress {
                conversation_id,
                progress,
                ..
            } => {
                let turn = self.turns.get(conversation_id);
                let shown = turn.is_some_and(|turn| self.shown(chat, turn));

                match progress {
                    TurnProgress::UserMessage {
                        client_message_id: Some(id),
                        text,
                        ..
                    } => {
                        if let Some(turn) =
                            turn.filter(|turn| shown && turn.client_message_id == *id)
                        {
                            chat.outbox.started(
                                (turn.source != self.source)
                                    .then(|| format!("You ({}): {text}", turn.source)),
                            );
                        }
                    }
                    TurnProgress::ReplyDelta { draft_id, .. } => {
                        let text = turn
                            .and_then(|turn| {
                                turn.drafts.iter().find(|draft| draft.draft_id == *draft_id)
                            })
                            .map(|draft| draft.text.clone())
                            .unwrap_or_default();

                        chat.outbox.draft(draft_id, text, shown);
                    }
                    TurnProgress::VisibleReply { draft_id, text, .. } => {
                        chat.outbox.commit(draft_id, text.to_string(), shown);
                    }
                    TurnProgress::ReplyWithdrawn { draft_id } => chat.outbox.withdraw(draft_id),
                    _ => {}
                }
            }
            _ => {}
        }
    }

    /// Her thread's line the stream says she took: when it is the one
    /// handed to her, the next goes.
    fn taken(&mut self, chat: &mut Chat, event: &Event) {
        if let Event::TurnProgress {
            progress:
                TurnProgress::UserMessage {
                    client_message_id: Some(id),
                    ..
                },
            ..
        } = event
            && self.handed.as_ref() == Some(id)
        {
            self.handed = None;
            self.carry(chat);
        }
    }

    async fn press(&mut self, chat: &mut Chat, press: CallbackQuery) {
        chat.outbox.heard_from(press.from.id);

        let mut toast = None;

        if let Some(asked) = Press::parse(press.data.as_deref())
            && self.gate.admit(chat, press.from.id, &press.from).await
            && asked.kind == CardKind::Confirmation
        {
            toast = confirm(chat, &asked).await;
        }

        chat.toast(&press, toast);
    }
}

impl Rules for Character {
    fn started(&mut self, chat: &mut Chat) {
        self.open(chat);
    }

    async fn update(&mut self, chat: &mut Chat, update: Update) {
        if let Some(press) = update.callback_query {
            self.press(chat, press).await;
            return;
        }

        let Some(message) = update.message else {
            return;
        };
        let Some(from) = message.from.filter(|_| message.chat.kind == "private") else {
            return;
        };
        let account = message.chat.id;

        chat.outbox.heard_from(account);

        if !self.gate.admit(chat, account, &from).await {
            return;
        }

        match message.text.filter(|text| !text.is_empty()) {
            None => chat.outbox.say_to_paired(account, TEXT_ONLY.to_owned()),
            Some(text) if text.split_whitespace().next() == Some("/start") => {
                chat.outbox.say_to_paired(
                    account,
                    format!("Hi, I'm {}. Write to me here.", Self::name(chat)),
                );
            }
            Some(text) => {
                // The id names the bot, the chat and the message, so a
                // resend after a lost answer joins its turn: Telegram
                // numbers messages within a chat, and a bot that replaces
                // this one opens a chat of its own numbered from one again.
                let (Ok(id), Ok(text)) = (
                    ClientStamp::new(&format!("{}.{account}.{}", chat.id, message.id)),
                    Text::new(&text),
                ) else {
                    return;
                };

                chat.outbox.typing(account);
                self.lines.push_back(Line {
                    chat: account,
                    id,
                    text,
                });
                self.carry(chat);
            }
        }
    }

    /// On a stream the daemon could not resume, the running turns are the
    /// snapshot's, and what was held for a thread not known yet is
    /// superseded. A draft shown here that the snapshot still carries keeps
    /// its message and is brought to the snapshot's words; one it does not
    /// is withdrawn. A card whose confirmation the snapshot no longer holds
    /// is ended, and one still waiting has its card where it should.
    fn install(&mut self, chat: &mut Chat, snapshot: &Snapshot) {
        self.turns = snapshot.turns.clone();
        self.held.clear();
        chat.outbox.withdraw_except(
            self.her_turn()
                .map(|turn| {
                    turn.drafts
                        .iter()
                        .map(|draft| draft.draft_id.clone())
                        .collect()
                })
                .unwrap_or_default(),
        );

        if self.thread.is_none() {
            self.open(chat);
        } else {
            self.show_drafts(chat);
        }

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
            Event::TurnProgress {
                character_id,
                conversation_id,
                ..
            }
            | Event::TurnCompleted {
                character_id,
                conversation_id,
                ..
            } => match &self.thread {
                None if *character_id == self.id => self.held.push(Arc::new(event.clone())),
                None => {}
                Some(thread) => {
                    let hers = *conversation_id == thread.conversation;

                    self.turns.fold(event);

                    if hers {
                        self.follow_turn(chat, event);
                        self.taken(chat, event);
                    }
                }
            },
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
            Event::PairingSettled { .. } => self.gate.settled(chat, event),
            _ => {}
        }
    }

    fn done(&mut self, chat: &mut Chat, done: Done) {
        match done {
            Done::Toasted => {}
            Done::Opened(opened) => {
                self.opening = Opening::Idle;

                match opened {
                    Ok(OpenOutcome::Opened {
                        conversation_id,
                        user_participant_id,
                        ..
                    }) => self.opened(
                        chat,
                        Thread {
                            conversation: conversation_id,
                            sender: user_participant_id,
                        },
                    ),
                    // She cannot take a line yet: the line waiting is told
                    // why, and her thread is opened once she is ready, or by
                    // the next line.
                    Ok(
                        OpenOutcome::Refused { message, .. }
                        | OpenOutcome::Failed(StorageFailure { message, .. }),
                    ) => {
                        let told =
                            format!("{} is not available right now: {message}", Self::name(chat));

                        self.unopened(chat, told);
                    }
                    Err(_) => {
                        self.opening = Opening::Again(Instant::now() + backoff(self.open_failures));
                        self.open_failures = self.open_failures.saturating_add(1);
                        self.unopened(chat, DAEMON_DOWN.to_owned());
                    }
                }
            }
            // How a turn that ran ended is the stream's to tell; a refusal
            // before any turn only its answer says, but for a line the daemon
            // took already under this id, which Telegram hands on again.
            Done::Delivered {
                chat: account,
                id,
                outcome,
            } => {
                let told = match outcome {
                    Ok(TurnOutcome::Refused { reason, message })
                        if reason != TurnRefusal::DuplicateSubmission =>
                    {
                        Some(format!(
                            "{} is not available right now: {message}",
                            Self::name(chat)
                        ))
                    }
                    Ok(_) => None,
                    Err(_) => Some(DAEMON_DOWN.to_owned()),
                };

                if let Some(told) = told {
                    chat.outbox.say_to_paired(account, told);
                }

                if self.handed.as_ref() == Some(&id) {
                    self.handed = None;
                    self.carry(chat);
                }
            }
        }
    }

    fn due(&self) -> Option<Instant> {
        match self.opening {
            Opening::Again(at) => Some(at),
            Opening::Idle | Opening::Asked => None,
        }
    }

    fn at_due(&mut self, chat: &mut Chat) {
        self.opening = Opening::Idle;
        self.open(chat);
    }
}

/// The account whose chat a line of this bot's came from: its id names the
/// bot, the chat and the message.
fn chat_of_line(id: &ClientStamp) -> Option<i64> {
    id.as_str().split('.').nth(1)?.parse().ok()
}
