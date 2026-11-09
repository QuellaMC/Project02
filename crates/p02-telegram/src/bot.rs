//! One token's bot: it asks Telegram who it is and says so, long-polls
//! until it is stopped or Telegram refuses its token, and hands each
//! update past the pairing gate to its rules, which follow the daemon's
//! frames too; trouble is said once per change, naming the bot, while the
//! bot keeps trying.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use p02_core::ClientStamp;
use p02_wire::{Event, OpenOutcome};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinSet;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::bot_api::{BotApi, BotToken, CallbackQuery, Failure, Message, Telegram, Update, User};
use crate::cards::Press;
use crate::character::Character;
use crate::daemon::{Daemon, Unanswered};
use crate::gate::Gate;
use crate::management::Management;
use crate::outbox::Outbox;
use crate::table::{BotSettings, Latest, Owner, Snapshot};
use crate::{Lines, backoff};

/// The wait after Telegram says another program polls the token, or after
/// a webhook on it could not be removed.
const CONFLICT_PAUSE: Duration = Duration::from_secs(30);

/// Said in a chat when what it asked could not reach the daemon.
pub(crate) const DAEMON_DOWN: &str =
    "The daemon is not running right now; send that again in a moment.";

/// What the table hands a bot of the daemon's stream, each under its frame's
/// number, so a bot that began from a later snapshot skips it.
#[derive(Debug)]
pub(crate) enum Inbox {
    /// A `ready` the daemon could not resume from, as it came.
    Install {
        seq: u64,
        snapshot: Arc<Snapshot>,
    },
    Frame {
        seq: u64,
        event: Arc<Event>,
    },
}

/// What a bot is started with, beside its settings.
#[derive(Debug)]
pub(crate) struct Start {
    pub(crate) telegram: Arc<Telegram>,
    pub(crate) token: BotToken,
    pub(crate) draft_edits: Duration,
    pub(crate) daemon: watch::Receiver<Option<Daemon>>,
    pub(crate) held: watch::Receiver<bool>,
    pub(crate) latest: watch::Receiver<Option<Latest>>,
    pub(crate) lines: Arc<dyn Lines>,
    pub(crate) stop: CancellationToken,
}

/// The stamp on every line the bot `username` carries and every pairing
/// request it makes.
fn source_of(username: &str) -> ClientStamp {
    ClientStamp::new(&format!("telegram:{username}"))
        .expect("a bot's username is letters, digits and underscores")
}

/// A running bot, as the table holds it.
#[derive(Debug)]
pub(crate) struct Bot {
    settings: watch::Sender<Arc<BotSettings>>,
    inbox: mpsc::UnboundedSender<Inbox>,
    stop: CancellationToken,
}

impl Bot {
    pub(crate) fn start(start: Start, settings: BotSettings, tracker: &TaskTracker) -> Self {
        let (settings, read) = watch::channel(Arc::new(settings));
        let (inbox, frames) = mpsc::unbounded_channel();
        let stop = start.stop.clone();

        tracker.spawn(run(start, read, frames));

        Self {
            settings,
            inbox,
            stop,
        }
    }

    pub(crate) fn same_owner(&self, owner: &Owner) -> bool {
        self.settings.borrow().owner.same(owner)
    }

    /// The settings a later read gave, for the same owner.
    pub(crate) fn update(&self, settings: BotSettings) {
        self.settings.send_replace(Arc::new(settings));
    }

    pub(crate) fn send(&self, message: Inbox) {
        // A bot that ended takes nothing more.
        let _ = self.inbox.send(message);
    }

    pub(crate) fn stop(&self) {
        self.stop.cancel();
    }
}

/// The bot from its start to its stop. Once Telegram said who it is, its
/// rules and its outbox run beside its poll; a token refused ends them and
/// leaves the bot quiet until it is stopped, so the table does not start
/// it again.
async fn run(
    start: Start,
    settings: watch::Receiver<Arc<BotSettings>>,
    frames: mpsc::UnboundedReceiver<Inbox>,
) {
    let Start {
        telegram,
        token,
        draft_edits,
        daemon,
        held,
        latest,
        lines,
        stop,
    } = start;
    let api = BotApi::new(telegram, token);
    let mut problems = Problems::default();
    let Some(me) = identify(&api, &settings, lines.as_ref(), &mut problems, &stop).await else {
        stop.cancelled().await;
        return;
    };
    let username = me.username.unwrap_or_else(|| me.id.to_string());
    let source = source_of(&username);
    let character = match &settings.borrow().owner {
        Owner::Management { .. } => {
            lines.say(&format!("Telegram: management bot @{username} is on."));
            None
        }
        Owner::Character { id, name, .. } => {
            lines.say(&format!("Telegram: @{username} answers for {name}."));
            Some(id.clone())
        }
    };
    let quiet = stop.child_token();
    let tasks = TaskTracker::new();
    let (polled, polls) = mpsc::unbounded_channel();
    let outbox = Outbox::start(
        api.clone(),
        settings.clone(),
        held.clone(),
        draft_edits,
        Arc::clone(&lines),
        quiet.clone(),
        &tasks,
    );
    let chat = Chat {
        api: api.clone(),
        id: me.id,
        source,
        settings: settings.clone(),
        daemon,
        outbox,
        lines: Arc::clone(&lines),
        stop: quiet.clone(),
        work: JoinSet::new(),
    };
    let intake = Intake {
        frames,
        polls,
        held,
        latest,
    };

    match character {
        Some(id) => tasks.spawn(follow(Character::new(id), chat, intake)),
        None => tasks.spawn(follow(Management, chat, intake)),
    };
    tasks.close();

    let ended = poll(
        &api,
        &polled,
        &settings,
        lines.as_ref(),
        &mut problems,
        &stop,
    )
    .await;

    if ended == PollEnd::Refused {
        lines.report(&refused(&settings.borrow().owner));
        quiet.cancel();
        stop.cancelled().await;
    }

    tasks.wait().await;
    lines.say(&format!(
        "Telegram: stopped @{username} ({}).",
        settings.borrow().owner.name()
    ));
}

/// What a write to `chat` that Telegram refused is said as.
pub(crate) fn unwritten(owner: &Owner, chat: i64, failure: &Failure) -> String {
    format!(
        "{} could not write to chat {chat}: {}",
        capitalized(&owner.bot()),
        failure.description()
    )
}

fn refused(owner: &Owner) -> String {
    format!(
        "Telegram refused {} token. Replace it on {}.",
        owner.bot(),
        owner.page()
    )
}

/// Asks Telegram who the bot is until it says, the token is refused, or
/// the stop.
async fn identify(
    api: &BotApi,
    settings: &watch::Receiver<Arc<BotSettings>>,
    lines: &dyn Lines,
    problems: &mut Problems,
    stop: &CancellationToken,
) -> Option<User> {
    for failures in 0.. {
        let outcome = tokio::select! {
            biased;
            () = stop.cancelled() => return None,
            outcome = api.get_me() => outcome,
        };
        let wait = match outcome {
            Ok(me) => return Some(me),
            Err(failure) if failure.token_refused() => {
                lines.report(&refused(&settings.borrow().owner));
                return None;
            }
            Err(failure) => failure.retry_after().unwrap_or_else(|| {
                let bot = settings.borrow().owner.bot();

                problems.change(
                    Some((Problem::Unreachable, failure.description())),
                    &bot,
                    lines,
                );
                backoff(failures)
            }),
        };

        tokio::select! {
            biased;
            () = stop.cancelled() => return None,
            () = sleep(wait) => {}
        }
    }

    None
}

/// What keeps a bot's messages from it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Problem {
    /// Another program polls the token.
    Conflict,
    /// Telegram sends the token's updates to a webhook.
    Webhook,
    Unreachable,
}

/// The problem said last.
#[derive(Debug, Default)]
struct Problems(Option<Problem>);

impl Problems {
    /// Says the problem once it is another than the one said last; and,
    /// once none is left, that the messages come again.
    fn change(&mut self, now: Option<(Problem, &str)>, bot: &str, lines: &dyn Lines) {
        let problem = now.map(|(problem, _)| problem);

        if problem == self.0 {
            return;
        }

        self.0 = problem;
        lines.report(&match now {
            None => format!("Telegram: {bot} gets its messages again."),
            Some((Problem::Conflict, _)) => {
                format!("Another program is polling {bot} (409); this one waits.")
            }
            Some((Problem::Webhook, _)) => format!(
                "Telegram was sending the messages for {bot} to a webhook, another program's; \
                 this connector removed it to poll. If that program should have them, give this \
                 connector a token of its own."
            ),
            Some((Problem::Unreachable, description)) => {
                format!("Telegram cannot be reached for {bot}: {description}")
            }
        });
    }
}

/// An update a poll hands the bot's rules, with the word they send back
/// once they have handled it, which the poll waits for.
type Polled = (Update, oneshot::Sender<()>);

#[derive(Debug, PartialEq, Eq)]
enum PollEnd {
    Stopped,
    Refused,
}

/// Long-polls until the stop or the token refused, handing each update on
/// in order and asking past a batch only once all of it was handed on. A
/// webhook left on the token is removed; another program's polls (409)
/// are waited out; a pause Telegram asks for is kept; anything else is
/// Telegram out of reach, backed off from.
async fn poll(
    api: &BotApi,
    rules: &mpsc::UnboundedSender<Polled>,
    settings: &watch::Receiver<Arc<BotSettings>>,
    lines: &dyn Lines,
    problems: &mut Problems,
    stop: &CancellationToken,
) -> PollEnd {
    let mut offset = 0_i64;
    let mut failures = 0;

    loop {
        let outcome = tokio::select! {
            biased;
            () = stop.cancelled() => return PollEnd::Stopped,
            outcome = api.get_updates(offset) => outcome,
        };
        let bot = settings.borrow().owner.bot();
        let wait = match outcome {
            Ok(updates) => {
                problems.change(None, &bot, lines);
                failures = 0;

                for update in updates {
                    let after = update.id.saturating_add(1);

                    if update.message.is_some() || update.callback_query.is_some() {
                        let (handed, on) = oneshot::channel();

                        if rules.send((update, handed)).is_err() {
                            return PollEnd::Stopped;
                        }

                        tokio::select! {
                            biased;
                            () = stop.cancelled() => return PollEnd::Stopped,
                            _ = on => {}
                        }
                    }

                    offset = offset.max(after);
                }

                continue;
            }
            Err(failure) if failure.token_refused() => return PollEnd::Refused,
            Err(failure)
                if failure.code() == Some(409)
                    && failure.description().to_lowercase().contains("webhook") =>
            {
                problems.change(Some((Problem::Webhook, failure.description())), &bot, lines);

                let removed = tokio::select! {
                    biased;
                    () = stop.cancelled() => return PollEnd::Stopped,
                    removed = api.delete_webhook() => removed,
                };

                if removed.is_ok() {
                    continue;
                }

                CONFLICT_PAUSE
            }
            Err(failure) if failure.code() == Some(409) => {
                problems.change(
                    Some((Problem::Conflict, failure.description())),
                    &bot,
                    lines,
                );
                CONFLICT_PAUSE
            }
            Err(failure) => failure.retry_after().unwrap_or_else(|| {
                problems.change(
                    Some((Problem::Unreachable, failure.description())),
                    &bot,
                    lines,
                );
                failures += 1;
                backoff(failures - 1)
            }),
        };

        tokio::select! {
            biased;
            () = stop.cancelled() => return PollEnd::Stopped,
            () = sleep(wait) => {}
        }
    }
}

/// What a bot's rules start and must see to the end: a call to the daemon
/// or to Telegram, answered while the rules go on.
#[derive(Debug)]
pub(crate) enum Done {
    Toasted,
    Opened(Result<OpenOutcome, Unanswered>),
}

/// What a bot's rules run on: the bot as Telegram knows it, the daemon and
/// the settings as they are at each use, the outbox, and the calls under
/// way.
#[derive(Debug)]
pub(crate) struct Chat {
    pub(crate) api: BotApi,
    /// As Telegram numbers the bot: stable where a username is not.
    pub(crate) id: i64,
    /// The stamp on every line the bot carries and every pairing request
    /// it makes.
    pub(crate) source: ClientStamp,
    settings: watch::Receiver<Arc<BotSettings>>,
    daemon: watch::Receiver<Option<Daemon>>,
    pub(crate) outbox: Outbox,
    lines: Arc<dyn Lines>,
    stop: CancellationToken,
    work: JoinSet<Done>,
}

impl Chat {
    pub(crate) fn settings(&self) -> Arc<BotSettings> {
        Arc::clone(&self.settings.borrow())
    }

    pub(crate) fn daemon(&self) -> Option<Daemon> {
        self.daemon.borrow().clone()
    }

    pub(crate) fn report(&self, line: &str) {
        self.lines.report(line);
    }

    /// `future`'s output, unless the bot stops first.
    pub(crate) async fn unless_stopped<T>(&self, future: impl Future<Output = T>) -> Option<T> {
        tokio::select! {
            biased;
            () = self.stop.cancelled() => None,
            output = future => Some(output),
        }
    }

    /// Starts `work`, whose answer the rules get while they go on.
    pub(crate) fn spawn(&mut self, work: impl Future<Output = Done> + Send + 'static) {
        self.work.spawn(work);
    }

    /// Answers a press at once, with its toast when there is one: it waits
    /// for none of what the bot writes.
    pub(crate) fn toast(&mut self, press: &CallbackQuery, toast: Option<String>) {
        let api = self.api.clone();
        let lines = Arc::clone(&self.lines);
        let settings = self.settings();
        let (id, from) = (press.id.clone(), press.from.id);

        self.spawn(async move {
            if let Err(failure) = api.answer_callback_query(&id, toast.as_deref()).await {
                lines.report(&unwritten(&settings.owner, from, &failure));
            }

            Done::Toasted
        });
    }
}

/// `text` with its first letter a capital, as a sentence starts.
pub(crate) fn capitalized(text: &str) -> String {
    let mut characters = text.chars();

    characters
        .next()
        .map(|first| first.to_uppercase().chain(characters).collect())
        .unwrap_or_default()
}

/// What a bot does with what a paired account sends it, and with the
/// daemon's frames and snapshots: a character's bot, or the home's.
pub(crate) trait Rules: Send {
    /// Runs once, as the rules begin.
    fn started(&mut self, _chat: &mut Chat) {}

    /// Handles a message from a paired account's private chat; its update
    /// is handed on once this answers.
    fn message(&mut self, chat: &mut Chat, message: Message) -> impl Future<Output = ()> + Send;

    /// Answers a paired account's press of a card's button with the toast
    /// that says how it went, if any.
    fn press(
        &mut self,
        chat: &mut Chat,
        press: &Press,
    ) -> impl Future<Output = Option<String>> + Send;

    fn install(&mut self, chat: &mut Chat, snapshot: &Snapshot);

    fn frame(&mut self, chat: &mut Chat, event: &Event);

    fn done(&mut self, _chat: &mut Chat, _done: Done) {}
}

/// What a bot's rules take in.
struct Intake {
    frames: mpsc::UnboundedReceiver<Inbox>,
    polls: mpsc::UnboundedReceiver<Polled>,
    held: watch::Receiver<bool>,
    latest: watch::Receiver<Option<Latest>>,
}

/// Runs a bot's rules until the stop. They act only while no settings
/// read is in doubt, on a frame, an update or an answer, so nothing is
/// shown or judged by settings a change may have left behind. They begin
/// from the latest snapshot, skipping every frame it already holds.
async fn follow(mut rules: impl Rules, mut chat: Chat, intake: Intake) {
    let Intake {
        mut frames,
        mut polls,
        mut held,
        latest,
    } = intake;
    let mut gate = Gate::default();
    let mut installed = false;
    let mut seen = 0;

    rules.started(&mut chat);

    loop {
        let free = !*held.borrow_and_update();

        tokio::select! {
            biased;
            () = chat.stop.cancelled() => return,
            Ok(()) = held.changed() => {}
            () = std::future::ready(()), if free && !installed => {
                installed = true;

                let newest = latest.borrow().clone();

                if let Some(newest) = newest {
                    seen = newest.seq;
                    rules.install(&mut chat, &newest.snapshot);
                }
            }
            Some(message) = frames.recv(), if free => match message {
                Inbox::Install { seq, snapshot } if seq > seen => {
                    seen = seq;
                    rules.install(&mut chat, &snapshot);
                }
                Inbox::Frame { seq, event } if seq > seen => {
                    seen = seq;
                    gate.settled(&chat, &event);
                    rules.frame(&mut chat, &event);
                }
                _ => {}
            },
            Some((update, handed)) = polls.recv(), if free => {
                take(&mut rules, &mut gate, &mut chat, update).await;
                let _ = handed.send(());
            }
            Some(done) = chat.work.join_next(), if free && !chat.work.is_empty() => {
                if let Ok(done) = done {
                    rules.done(&mut chat, done);
                }
            }
        }
    }
}

/// Hands an update to the rules once the gate lets its account in: a
/// press of a card's button, answered at once with how it went, or a
/// message in a private chat. A chat that writes is written to again.
async fn take(rules: &mut impl Rules, gate: &mut Gate, chat: &mut Chat, update: Update) {
    if let Some(press) = update.callback_query {
        chat.outbox.heard_from(press.from.id);

        let mut toast = None;

        if let Some(asked) = Press::parse(press.data.as_deref())
            && gate.admit(chat, press.from.id, &press.from).await
        {
            toast = rules.press(chat, &asked).await;
        }

        chat.toast(&press, toast);
        return;
    }

    let Some(message) = update.message else {
        return;
    };
    let Some(from) = message
        .from
        .as_ref()
        .filter(|_| message.chat.kind == "private")
    else {
        return;
    };
    let account = message.chat.id;

    chat.outbox.heard_from(account);

    if gate.admit(chat, account, from).await {
        rules.message(chat, message).await;
    }
}
