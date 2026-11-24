//! What a bot writes in its chats. Its calls to Telegram go one at a time
//! in the order they were decided, so no message overtakes one decided
//! before it, and none once the bot has stopped; one Telegram asks to wait
//! on is made again after the pause. A write to a paired account's chat
//! waits while the settings are in doubt and is made only while the
//! account is paired, each checked as the call's turn comes. A chat that
//! answers 403 never opened the bot, and is skipped until it writes.

use std::collections::{BTreeSet, VecDeque};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep, sleep_until};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::Lines;
use crate::bot::unwritten;
use crate::bot_api::{BotApi, Failure, Keyboard, MAX_MESSAGE, Message};
use crate::cards::{CardKind, CardText, Cards, Revision};
use crate::table::BotSettings;

/// How often a chat that shows her typing is shown it again: Telegram lets
/// the mark go after about five seconds.
const TYPING_AGAIN: Duration = Duration::from_secs(4);

/// The messages a text takes, in order, none cutting a character.
fn pieces(text: &str) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut piece = String::new();
    let mut length = 0;

    for character in text.chars() {
        if length + character.len_utf16() > MAX_MESSAGE {
            pieces.push(std::mem::take(&mut piece));
            length = 0;
        }

        length += character.len_utf16();
        piece.push(character);
    }

    if !piece.is_empty() {
        pieces.push(piece);
    }

    pieces
}

/// Where a card goes.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Target {
    EveryPaired,
    /// The chat while it is paired, else every paired one.
    Chat(i64),
}

/// What a bot's rules ask its outbox to write.
#[derive(Debug)]
enum Command {
    /// The text, in as many messages as it takes, stopping at one that
    /// could not be sent; to a paired account's chat when `paired`.
    Say {
        chat: i64,
        text: String,
        paired: bool,
    },
    Typing {
        chat: i64,
    },
    /// Her typing shown in the chat, kept up until another chat or none is
    /// named.
    KeepTyping {
        chat: Option<i64>,
    },
    /// A message of hers, whole, in every paired chat.
    Post {
        text: String,
    },
    Card {
        kind: CardKind,
        key: String,
        text: Box<CardText>,
        to: Target,
    },
    EndCard {
        kind: CardKind,
        key: String,
        ending: String,
    },
    /// Ends every card of the kind but those named, as settled while the
    /// bot was away.
    KeepCards {
        kind: CardKind,
        keys: Vec<String>,
    },
    /// Every card held, where it has not gone; `nothing` when none is.
    Pending {
        chat: i64,
        nothing: &'static str,
    },
    /// The daemon let the account in before the bot's next read of the
    /// settings, which supersedes it.
    Admitted {
        chat: i64,
    },
    /// A message from the chat arrived, so it is written to again.
    HeardFrom {
        chat: i64,
    },
}

/// A bot's outbox, as its rules hold it.
#[derive(Clone, Debug)]
pub(crate) struct Outbox(mpsc::UnboundedSender<Command>);

impl Outbox {
    pub(crate) fn start(
        api: BotApi,
        settings: watch::Receiver<Arc<BotSettings>>,
        held: watch::Receiver<bool>,
        lines: Arc<dyn Lines>,
        stop: CancellationToken,
        tracker: &TaskTracker,
    ) -> Self {
        let (commands, taken) = mpsc::unbounded_channel();
        let read = Arc::clone(&settings.borrow());

        tracker.spawn(
            Writer {
                api,
                settings,
                read,
                held,
                lines,
                stop,
                commands: taken,
                jobs: VecDeque::new(),
                typing: None,
                cards: [
                    Cards::new(CardKind::Confirmation),
                    Cards::new(CardKind::Pairing),
                ],
                admitted: BTreeSet::new(),
                silent: BTreeSet::new(),
            }
            .run(),
        );

        Self(commands)
    }

    fn send(&self, command: Command) {
        // An outbox that stopped writes nothing more.
        let _ = self.0.send(command);
    }

    pub(crate) fn say(&self, chat: i64, text: String) {
        self.send(Command::Say {
            chat,
            text,
            paired: false,
        });
    }

    pub(crate) fn say_to_paired(&self, chat: i64, text: String) {
        self.send(Command::Say {
            chat,
            text,
            paired: true,
        });
    }

    pub(crate) fn typing(&self, chat: i64) {
        self.send(Command::Typing { chat });
    }

    pub(crate) fn keep_typing(&self, chat: Option<i64>) {
        self.send(Command::KeepTyping { chat });
    }

    pub(crate) fn post(&self, text: String) {
        self.send(Command::Post { text });
    }

    pub(crate) fn card(&self, kind: CardKind, key: String, text: CardText, to: Target) {
        self.send(Command::Card {
            kind,
            key,
            text: Box::new(text),
            to,
        });
    }

    pub(crate) fn end_card(&self, kind: CardKind, key: String, ending: &str) {
        self.send(Command::EndCard {
            kind,
            key,
            ending: ending.to_owned(),
        });
    }

    pub(crate) fn keep_cards(&self, kind: CardKind, keys: Vec<String>) {
        self.send(Command::KeepCards { kind, keys });
    }

    pub(crate) fn pending(&self, chat: i64, nothing: &'static str) {
        self.send(Command::Pending { chat, nothing });
    }

    pub(crate) fn admitted(&self, chat: i64) {
        self.send(Command::Admitted { chat });
    }

    pub(crate) fn heard_from(&self, chat: i64) {
        self.send(Command::HeardFrom { chat });
    }
}

/// One call's worth of work, or several made in order: each call is
/// decided as its turn comes, by what the outbox knows then.
#[derive(Debug)]
enum Job {
    Tell {
        chat: i64,
        text: String,
        paired: bool,
    },
    Typing {
        chat: i64,
    },
    Card {
        kind: CardKind,
        key: String,
        chat: i64,
    },
    Revise(Revision),
}

struct Writer {
    api: BotApi,
    settings: watch::Receiver<Arc<BotSettings>>,
    /// The settings the accounts admitted since were judged against: a new
    /// read supersedes them.
    read: Arc<BotSettings>,
    /// Whether the settings are in doubt: being read, or the daemon away.
    held: watch::Receiver<bool>,
    lines: Arc<dyn Lines>,
    stop: CancellationToken,
    commands: mpsc::UnboundedReceiver<Command>,
    jobs: VecDeque<Job>,
    /// The chat that shows her typing, and when it is shown it next.
    typing: Option<(i64, Instant)>,
    cards: [Cards; 2],
    admitted: BTreeSet<i64>,
    silent: BTreeSet<i64>,
}

impl Writer {
    /// Takes every command as it comes, and makes the calls they decided
    /// one at a time, until the stop.
    async fn run(mut self) {
        loop {
            let due = self.typing.map(|(_, due)| due);
            let job = tokio::select! {
                biased;
                () = self.stop.cancelled() => return,
                command = self.commands.recv() => match command {
                    Some(command) => {
                        self.take(command);
                        continue;
                    }
                    None => return,
                },
                () = sleep_until(due.unwrap_or_else(Instant::now)), if due.is_some() => {
                    self.type_again();
                    continue;
                }
                () = std::future::ready(()), if !self.jobs.is_empty() => self.jobs.pop_front(),
            };

            if let Some(job) = job {
                self.work(job).await;
            }
        }
    }

    fn cards(&mut self, kind: CardKind) -> &mut Cards {
        match kind {
            CardKind::Confirmation => &mut self.cards[0],
            CardKind::Pairing => &mut self.cards[1],
        }
    }

    /// Each paired account's chat, by the bot's read of the settings and
    /// the accounts the daemon let in since, but one skipped for a 403. A
    /// private chat's id is its account's, a positive integer, so a key
    /// shaped otherwise names no chat of ours.
    fn paired(&mut self) -> Vec<i64> {
        let settings = Arc::clone(&self.settings.borrow());

        if !Arc::ptr_eq(&settings, &self.read) {
            self.read = settings;
            self.admitted.clear();
        }

        self.read
            .paired
            .iter()
            .filter(|key| !key.starts_with('0') && key.bytes().all(|byte| byte.is_ascii_digit()))
            .filter_map(|key| key.parse::<i64>().ok())
            .chain(self.admitted.iter().copied())
            .filter(|chat| !self.silent.contains(chat))
            .collect::<BTreeSet<i64>>()
            .into_iter()
            .collect()
    }

    fn take(&mut self, command: Command) {
        match command {
            Command::Say { chat, text, paired } => {
                self.jobs.push_back(Job::Tell { chat, text, paired });
            }
            Command::Typing { chat } => self.jobs.push_back(Job::Typing { chat }),
            Command::KeepTyping { chat } => {
                self.typing = chat.map(|chat| (chat, Instant::now()));
            }
            Command::Post { text } => {
                for chat in self.paired() {
                    self.jobs.push_back(Job::Tell {
                        chat,
                        text: text.clone(),
                        paired: true,
                    });
                }
            }
            Command::Card {
                kind,
                key,
                text,
                to,
            } => self.card(kind, &key, *text, to),
            Command::EndCard { kind, key, ending } => {
                let revisions = self.cards(kind).end(&key, &ending);

                self.jobs.extend(revisions.into_iter().map(Job::Revise));
            }
            Command::KeepCards { kind, keys } => {
                let revisions = self.cards(kind).keep(&keys);

                self.jobs.extend(revisions.into_iter().map(Job::Revise));
            }
            Command::Pending { chat, nothing } => self.pending(chat, nothing),
            Command::Admitted { chat } => {
                self.paired();
                self.admitted.insert(chat);
            }
            Command::HeardFrom { chat } => {
                self.silent.remove(&chat);
            }
        }
    }

    /// The chat that shows her typing is shown it again now, and again an
    /// interval later.
    fn type_again(&mut self) {
        if let Some((chat, due)) = &mut self.typing {
            *due = Instant::now() + TYPING_AGAIN;
            self.jobs.push_back(Job::Typing { chat: *chat });
        }
    }

    fn card(&mut self, kind: CardKind, key: &str, text: CardText, to: Target) {
        let paired = self.paired();
        let chats = match to {
            Target::Chat(chat) if paired.contains(&chat) => vec![chat],
            Target::Chat(_) | Target::EveryPaired => paired,
        };

        for chat in self.cards(kind).post(key, text, &chats) {
            self.jobs.push_back(Job::Card {
                kind,
                key: key.to_owned(),
                chat,
            });
        }
    }

    fn pending(&mut self, chat: i64, nothing: &str) {
        let mut held = 0;

        for cards in &mut self.cards {
            held += cards.len();

            for key in cards.post_all(chat) {
                self.jobs.push_back(Job::Card {
                    kind: cards.kind(),
                    key,
                    chat,
                });
            }
        }

        if held == 0 {
            self.jobs.push_back(Job::Tell {
                chat,
                text: nothing.to_owned(),
                paired: true,
            });
        }
    }

    async fn work(&mut self, job: Job) {
        match job {
            Job::Tell { chat, text, paired } => {
                for piece in pieces(&text) {
                    if self.send(chat, piece, None, paired).await.is_none() {
                        break;
                    }
                }
            }
            Job::Typing { chat } => {
                let api = self.api.clone();

                self.made(chat, Some(chat), move || {
                    let api = api.clone();

                    async move { api.send_typing(chat).await }
                })
                .await;
            }
            Job::Card { kind, key, chat } => {
                let Some((text, keyboard)) = self.cards(kind).message(&key) else {
                    return;
                };
                let sent = self.send(chat, text, Some(keyboard), true).await;

                self.cards(kind)
                    .sent(&key, chat, sent.map(|message| message.id));
            }
            Job::Revise((chat, message, text)) => self.edit(chat, message, text).await,
        }
    }

    async fn send(
        &mut self,
        chat: i64,
        text: String,
        keyboard: Option<Keyboard>,
        paired: bool,
    ) -> Option<Message> {
        let api = self.api.clone();

        self.made(chat, paired.then_some(chat), move || {
            let (api, text, keyboard) = (api.clone(), text.clone(), keyboard.clone());

            async move { api.send_message(chat, &text, keyboard.as_ref()).await }
        })
        .await
    }

    /// Edits the message to `text`: one that shows it already is as good as
    /// edited.
    async fn edit(&mut self, chat: i64, message: i64, text: String) {
        let api = self.api.clone();
        let made = self
            .patiently(Some(chat), move || {
                let (api, text) = (api.clone(), text.clone());

                async move { api.edit_message_text(chat, message, &text).await }
            })
            .await;
        let shown = matches!(
            &made,
            Some(Err(failure))
                if failure.code() == Some(400)
                    && failure
                        .description()
                        .starts_with("Bad Request: message is not modified")
        );

        if !shown {
            self.heard(chat, made);
        }
    }

    /// One call, heard: what it gave, or nothing for one not made or
    /// refused.
    async fn made<T, F>(&mut self, chat: i64, to: Option<i64>, call: impl Fn() -> F) -> Option<T>
    where
        F: Future<Output = Result<T, Failure>>,
    {
        let made = self.patiently(to, call).await;

        self.heard(chat, made)
    }

    /// The call, made again after each pause Telegram asks for, the outbox
    /// waiting with it; a call to a paired account's chat, `to`, waits while
    /// the settings are in doubt and is not made, nor made again, once the
    /// account is paired no longer. None for one not made.
    async fn patiently<T, F>(
        &mut self,
        to: Option<i64>,
        call: impl Fn() -> F,
    ) -> Option<Result<T, Failure>>
    where
        F: Future<Output = Result<T, Failure>>,
    {
        loop {
            if let Some(chat) = to {
                tokio::select! {
                    biased;
                    () = self.stop.cancelled() => return None,
                    settled = self.held.wait_for(|held| !held) => settled.ok().map(drop)?,
                }

                if !self.paired().contains(&chat) {
                    return None;
                }
            }

            let outcome = tokio::select! {
                biased;
                () = self.stop.cancelled() => return None,
                outcome = call() => outcome,
            };

            match outcome {
                Err(failure) if failure.retry_after().is_some() => {
                    let pause = failure.retry_after().unwrap_or_default();

                    tokio::select! {
                        biased;
                        () = self.stop.cancelled() => return None,
                        () = sleep(pause) => {}
                    }
                }
                outcome => return Some(outcome),
            }
        }
    }

    /// What a call gave: a refusal is said, and a 403 silences the chat.
    fn heard<T>(&mut self, chat: i64, made: Option<Result<T, Failure>>) -> Option<T> {
        match made? {
            Ok(result) => Some(result),
            Err(failure) if failure.code() == Some(403) => {
                self.silent.insert(chat);
                None
            }
            Err(failure) => {
                self.lines
                    .report(&unwritten(&self.settings.borrow().owner, chat, &failure));
                None
            }
        }
    }
}
