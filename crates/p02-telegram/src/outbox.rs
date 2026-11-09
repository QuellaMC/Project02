//! What a bot writes in its chats. Its calls to Telegram go one at a time
//! in the order they were decided, so no edit overtakes a commit nor a
//! reply the line shown before it, and none once the bot has stopped; one
//! Telegram asks to wait on is made again after the pause. A write to a
//! paired account's chat waits while the settings are in doubt and is made
//! only while the account is paired, each checked as the call's turn
//! comes. A chat that answers 403 never opened the bot, and is skipped
//! until it writes.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep, sleep_until};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::Lines;
use crate::bot::capitalized;
use crate::bot_api::{BotApi, Failure, Keyboard, MAX_MESSAGE, Message};
use crate::cards::{CardKind, CardText, Cards, Revision};
use crate::table::BotSettings;

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
    /// A turn shown begins: in every paired chat, its line when it is
    /// another surface's, and the bot typing.
    Started {
        mirrored: Option<String>,
    },
    /// A draft's text so far: a new one is posted in every paired chat
    /// when `post` and it has words, and one already posted is edited at
    /// most once an interval.
    Draft {
        id: String,
        text: String,
        post: bool,
    },
    /// The committed text replaces its draft; with none posted, `post`
    /// sends it whole.
    Commit {
        id: String,
        text: String,
        post: bool,
    },
    Withdraw {
        id: String,
    },
    /// Withdraws every draft but those named.
    WithdrawExcept {
        kept: Vec<String>,
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
        draft_edits: Duration,
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
                draft_edits,
                lines,
                stop,
                commands: taken,
                jobs: VecDeque::new(),
                drafts: HashMap::new(),
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

    pub(crate) fn started(&self, mirrored: Option<String>) {
        self.send(Command::Started { mirrored });
    }

    pub(crate) fn draft(&self, id: &str, text: String, post: bool) {
        self.send(Command::Draft {
            id: id.to_owned(),
            text,
            post,
        });
    }

    pub(crate) fn commit(&self, id: &str, text: String, post: bool) {
        self.send(Command::Commit {
            id: id.to_owned(),
            text,
            post,
        });
    }

    pub(crate) fn withdraw(&self, id: &str) {
        self.send(Command::Withdraw { id: id.to_owned() });
    }

    pub(crate) fn withdraw_except(&self, kept: Vec<String>) {
        self.send(Command::WithdrawExcept { kept });
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
    /// A draft brought to its words while it is written.
    Render {
        id: String,
    },
    /// A draft ended as its committed text, which it holds.
    Commit(Box<Draft>),
    /// A withdrawn draft's messages, deleted.
    Delete(BTreeMap<i64, (i64, String)>),
    Card {
        kind: CardKind,
        key: String,
        chat: i64,
    },
    Revise(Revision),
}

/// A reply as the chats show it while it is written. Its commit or its
/// withdrawal takes it from the drafts at once, since the next reply's
/// draft may come under the same id.
#[derive(Debug)]
struct Draft {
    /// The text so far, for the next edit; its committed text once it is.
    text: String,
    /// Each chat's message of it, and the words it shows.
    messages: BTreeMap<i64, (i64, String)>,
    edit_due: Option<Instant>,
}

impl Draft {
    fn new(text: String) -> Self {
        Self {
            text,
            messages: BTreeMap::new(),
            edit_due: None,
        }
    }
}

struct Writer {
    api: BotApi,
    settings: watch::Receiver<Arc<BotSettings>>,
    /// The settings the accounts admitted since were judged against: a new
    /// read supersedes them.
    read: Arc<BotSettings>,
    /// Whether the settings are in doubt: being read, or the daemon away.
    held: watch::Receiver<bool>,
    draft_edits: Duration,
    lines: Arc<dyn Lines>,
    stop: CancellationToken,
    commands: mpsc::UnboundedReceiver<Command>,
    jobs: VecDeque<Job>,
    drafts: HashMap<String, Draft>,
    cards: [Cards; 2],
    admitted: BTreeSet<i64>,
    silent: BTreeSet<i64>,
}

impl Writer {
    /// Takes every command as it comes, and makes the calls they decided
    /// one at a time, until the stop.
    async fn run(mut self) {
        loop {
            let due = self
                .drafts
                .values()
                .filter_map(|draft| draft.edit_due)
                .min();
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
                    self.edits_due();
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
            .filter(|chat| *chat > 0 && !self.silent.contains(chat))
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
            Command::Started { mirrored } => {
                for chat in self.paired() {
                    if let Some(line) = &mirrored {
                        self.jobs.push_back(Job::Tell {
                            chat,
                            text: line.clone(),
                            paired: true,
                        });
                    }

                    self.jobs.push_back(Job::Typing { chat });
                }
            }
            Command::Draft { id, text, post } => self.drafted(id, text, post),
            Command::Commit { id, text, post } => self.committed(&id, text, post),
            Command::Withdraw { id } => self.withdraw(&id),
            Command::WithdrawExcept { kept } => {
                let gone: Vec<String> = self
                    .drafts
                    .keys()
                    .filter(|id| !kept.contains(id))
                    .cloned()
                    .collect();

                for id in gone {
                    self.withdraw(&id);
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

    fn drafted(&mut self, id: String, text: String, post: bool) {
        match self.drafts.get_mut(&id) {
            Some(draft) => {
                draft.text = text;
                draft
                    .edit_due
                    .get_or_insert(Instant::now() + self.draft_edits);
            }
            None if post && !text.trim().is_empty() => {
                self.drafts.insert(id.clone(), Draft::new(text));
                self.jobs.push_back(Job::Render { id });
            }
            None => {}
        }
    }

    fn committed(&mut self, id: &str, text: String, post: bool) {
        let draft = match self.drafts.remove(id) {
            Some(draft) => Some(draft),
            None => post.then(|| Draft::new(String::new())),
        };

        if let Some(mut draft) = draft {
            draft.text = text;
            self.jobs.push_back(Job::Commit(Box::new(draft)));
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

    fn withdraw(&mut self, id: &str) {
        if let Some(draft) = self.drafts.remove(id) {
            self.jobs.push_back(Job::Delete(draft.messages));
        }
    }

    /// Each draft whose interval is over is brought to its words.
    fn edits_due(&mut self) {
        let now = Instant::now();

        for (id, draft) in &mut self.drafts {
            if draft.edit_due.is_some_and(|due| due <= now) {
                draft.edit_due = None;
                self.jobs.push_back(Job::Render { id: id.clone() });
            }
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
            Job::Render { id } => {
                // Nothing else of the outbox moves while a job runs, so the
                // draft is back before the next command is taken.
                if let Some(mut draft) = self.drafts.remove(&id) {
                    self.render(&mut draft, false).await;
                    self.drafts.insert(id, draft);
                }
            }
            Job::Commit(mut draft) => self.render(&mut draft, true).await,
            Job::Delete(messages) => {
                for (chat, (message, _)) in messages {
                    let api = self.api.clone();

                    self.made(chat, None, move || {
                        let api = api.clone();

                        async move { api.delete_message(chat, message).await }
                    })
                    .await;
                }
            }
            Job::Card { kind, key, chat } => {
                let Some((text, keyboard)) = self.cards(kind).message(&key) else {
                    return;
                };
                let sent = self.send(chat, text, Some(keyboard), true).await;

                self.cards(kind)
                    .sent(&key, chat, sent.map(|message| message.id));
            }
            Job::Revise((chat, message, text)) => {
                self.edit(chat, message, text).await;
            }
        }
    }

    /// Brings the draft's message in every paired chat to its text: sent
    /// where it has none, edited where it shows other words, an edit that
    /// failed leaving the words for the next to try again; a chat paired no
    /// longer gets no more of it. A draft shows what fits one message; its
    /// commit sends the rest after, and only after.
    async fn render(&mut self, draft: &mut Draft, commit: bool) {
        let mut pieces = pieces(&draft.text).into_iter();
        let first = pieces.next().unwrap_or_default();
        let rest: Vec<String> = pieces.collect();

        for chat in self.paired() {
            match draft.messages.get(&chat).cloned() {
                None => {
                    if let Some(sent) = self.send(chat, first.clone(), None, true).await {
                        draft.messages.insert(chat, (sent.id, first.clone()));
                    }
                }
                Some((message, words)) if words != first => {
                    if self.edit(chat, message, first.clone()).await {
                        draft.messages.insert(chat, (message, first.clone()));
                    }
                }
                Some(_) => {}
            }

            let whole = draft
                .messages
                .get(&chat)
                .is_some_and(|(_, words)| *words == first);

            if commit && whole {
                for piece in &rest {
                    if self.send(chat, piece.clone(), None, true).await.is_none() {
                        break;
                    }
                }
            }
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

    /// Whether the message shows `text` now: one that showed it already is
    /// as good as edited.
    async fn edit(&mut self, chat: i64, message: i64, text: String) -> bool {
        let api = self.api.clone();
        let made = self
            .patiently(Some(chat), move || {
                let (api, text) = (api.clone(), text.clone());

                async move { api.edit_message_text(chat, message, &text).await }
            })
            .await;

        match made {
            Some(Err(failure))
                if failure.code() == Some(400)
                    && failure
                        .description()
                        .starts_with("Bad Request: message is not modified") =>
            {
                true
            }
            made => self.heard(chat, made).is_some(),
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
                self.lines.report(&format!(
                    "{} could not write to chat {chat}: {}",
                    capitalized(&self.settings.borrow().owner.bot()),
                    failure.description()
                ));
                None
            }
        }
    }
}
