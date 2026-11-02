//! The bot table: one bot per configured token, kept from one connection
//! to the next, by the daemon's own judgment of each settings entry; the
//! reading rule that keeps the bots' settings current; and the hold, which
//! keeps every bot from showing or judging anything by settings a change
//! may have left behind.

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use p02_app::{Event, Health, PairingRequest, PendingConfirmation, RunningTurns};
use p02_config::{ConnectorConfigView, ConnectorEntry};
use p02_gateway::Ready;
use p02_shared::{Identifier, error_sentence};
use serde::Deserialize;
use serde_json::{Map, Value};
use tokio::sync::{mpsc, watch};
use tokio::task::AbortHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::bot::{Bot, Inbox, Start};
use crate::bot_api::{BotToken, Transport};
use crate::daemon::Daemon;
use crate::{Lines, Notice, backoff, lenient};

/// What a bot runs on, as its entry in the connector config has it: whose
/// bot it is, and the accounts the home lets in.
#[derive(Debug)]
pub(crate) struct BotSettings {
    pub(crate) owner: Owner,
    /// The keys of `pairedUsers`: each paired account's id.
    pub(crate) paired: BTreeSet<String>,
}

/// Whose a bot is. A bot is one owner's: a token that moves to another
/// starts a bot of its own.
#[derive(Debug)]
pub(crate) enum Owner {
    /// The home's own bot, which knows each character's name by her id.
    Management { names: BTreeMap<Identifier, String> },
    Character {
        id: Identifier,
        /// Her name, as health has it.
        name: String,
        mirror: bool,
    },
}

impl Owner {
    pub(crate) fn same(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Management { .. }, Self::Management { .. }) => true,
            (Self::Character { id, .. }, Self::Character { id: other, .. }) => id == other,
            _ => false,
        }
    }

    /// Who the bot is, as the terminal names it.
    pub(crate) fn name(&self) -> &str {
        match self {
            Self::Management { .. } => "the management bot",
            Self::Character { name, .. } => name,
        }
    }

    /// The bot, as the terminal names it.
    pub(crate) fn bot(&self) -> String {
        match self {
            Self::Management { .. } => "the management bot".to_owned(),
            Self::Character { name, .. } => format!("{name}'s bot"),
        }
    }

    /// Where its token is replaced.
    pub(crate) fn page(&self) -> String {
        match self {
            Self::Management { .. } => "the home's settings page".to_owned(),
            Self::Character { name, .. } => format!("{name}'s settings page"),
        }
    }
}

/// What the daemon said in a `ready`, moved on by every frame since: what
/// it would say in a `ready` now, for a bot that catches up.
#[derive(Clone, Debug)]
pub(crate) struct Snapshot {
    pub(crate) confirmations: Vec<PendingConfirmation>,
    pub(crate) pairings: Vec<PairingRequest>,
    pub(crate) turns: RunningTurns,
}

/// The snapshot as of the frame numbered `seq`, the one a bot that catches
/// up from it skips to.
#[derive(Clone, Debug)]
pub(crate) struct Latest {
    pub(crate) seq: u64,
    pub(crate) snapshot: Snapshot,
}

impl Snapshot {
    /// The turns folded by the contract's one rule; what waits added as it
    /// is raised, announced again or not, and dropped as it is settled.
    fn move_on(&mut self, event: &Event) {
        self.turns.fold(event);

        match event {
            Event::ConfirmationRequested(pending) => {
                self.confirmations
                    .retain(|waiting| waiting.id != pending.id);
                self.confirmations.push(pending.clone());
            }
            Event::ConfirmationSettled { id, .. } => {
                self.confirmations.retain(|waiting| waiting.id != *id);
            }
            Event::PairingRequested(request) => {
                self.pairings.retain(|waiting| waiting.code != request.code);
                self.pairings.push(request.clone());
            }
            Event::PairingSettled { code, .. } => {
                self.pairings.retain(|waiting| waiting.code != *code);
            }
            _ => {}
        }
    }
}

/// The Telegram fields of one entry, as the declaration names them; one
/// that does not read as its type is absent.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Values {
    #[serde(deserialize_with = "lenient")]
    bot_token: Option<String>,
    #[serde(deserialize_with = "lenient")]
    management_bot_token: Option<String>,
    #[serde(deserialize_with = "lenient")]
    mirror: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    paired_users: Option<Map<String, Value>>,
}

impl Values {
    /// The entry's values while it is active; none while it is not.
    fn of(entry: &ConnectorEntry) -> Option<Self> {
        entry
            .values()
            .map(|values| serde_json::from_value(Value::Object(values.clone())).unwrap_or_default())
    }

    fn paired(&self) -> BTreeSet<String> {
        self.paired_users
            .as_ref()
            .map(|paired| paired.keys().cloned().collect())
            .unwrap_or_default()
    }
}

#[derive(Debug)]
struct Running {
    token: BotToken,
    bot: Bot,
}

/// A read's answer, under the ticket it started with.
type Answer = (u64, ConnectorConfigView);

/// The bots running, one per token, the reads of their settings, and what
/// they wait for while a read is under way.
#[derive(Debug)]
pub(crate) struct Table {
    telegram: Arc<dyn Transport>,
    draft_edits: Duration,
    lines: Arc<dyn Lines>,
    stop: CancellationToken,
    bots: Vec<Running>,
    /// Every bot's tasks, so the process ends once each has.
    tracker: TaskTracker,
    /// The daemon followed now, which every bot reaches.
    daemon: watch::Sender<Option<Daemon>>,
    /// Whether the bots wait for a settings read: their updates, their
    /// writes to paired accounts, and the frames since the hold.
    held: watch::Sender<bool>,
    latest: watch::Sender<Option<Latest>>,
    /// Health as last said, whose names the bots go by.
    health: Option<Health>,
    /// The frames counted since the start, each frame's number.
    seq: u64,
    /// A `ready` not handed on yet, as it came.
    unread: Option<(u64, Arc<Snapshot>)>,
    /// The frames since the hold, handed on in order once it ends.
    waiting: Vec<(u64, Arc<Event>)>,
    /// The ticket of the newest read, and the one a hold must be outlived
    /// by: only a read begun after the hold ends it.
    newest: u64,
    hold_after: u64,
    reading: Option<AbortHandle>,
    answers: mpsc::UnboundedReceiver<Answer>,
    answer: mpsc::UnboundedSender<Answer>,
    notice: Notice,
    /// The tokens two entries share, as said last.
    shared: BTreeSet<String>,
}

impl Table {
    pub(crate) fn new(
        telegram: Arc<dyn Transport>,
        draft_edits: Duration,
        lines: Arc<dyn Lines>,
        stop: &CancellationToken,
    ) -> Self {
        let (answer, answers) = mpsc::unbounded_channel();

        Self {
            telegram,
            draft_edits,
            lines,
            stop: stop.clone(),
            bots: Vec::new(),
            tracker: TaskTracker::new(),
            daemon: watch::Sender::new(None),
            held: watch::Sender::new(false),
            latest: watch::Sender::new(None),
            health: None,
            seq: 0,
            unread: None,
            waiting: Vec::new(),
            newest: 0,
            hold_after: 0,
            reading: None,
            answers,
            answer,
            notice: Notice::default(),
            shared: BTreeSet::new(),
        }
    }

    /// Waits for `future`, applying every read's answer meanwhile; none
    /// once the stop came.
    pub(crate) async fn during<T>(
        &mut self,
        future: impl Future<Output = T>,
        stop: &CancellationToken,
    ) -> Option<T> {
        let mut future = std::pin::pin!(future);

        loop {
            tokio::select! {
                biased;
                () = stop.cancelled() => return None,
                Some(answer) = self.answers.recv() => self.answered(answer),
                output = &mut future => return Some(output),
            }
        }
    }

    /// The daemon the bots reach from now on.
    pub(crate) fn follow(&mut self, daemon: Daemon) {
        self.daemon.send_replace(Some(daemon));
    }

    /// A stream that cannot be caught up: its snapshot supersedes every
    /// frame held, and is installed by the bots once its settings are read.
    pub(crate) fn ready(&mut self, ready: Ready) {
        let Ready {
            health,
            confirmations,
            pairings,
            turns,
            ..
        } = ready;
        let snapshot = Snapshot {
            confirmations,
            pairings,
            turns: turns.into_iter().collect(),
        };

        self.seq += 1;
        self.health = Some(health);

        self.latest.send_replace(Some(Latest {
            seq: self.seq,
            snapshot: snapshot.clone(),
        }));
        self.unread = Some((self.seq, Arc::new(snapshot)));
        self.waiting.clear();
        self.read();
    }

    /// A stream the daemon resumed: what waited since the loss is read for.
    pub(crate) fn resumed(&mut self) {
        self.read();
    }

    pub(crate) fn event(&mut self, event: Event) {
        self.seq += 1;

        let seq = self.seq;

        self.latest.send_modify(|latest| {
            if let Some(latest) = latest {
                latest.seq = seq;
                latest.snapshot.move_on(&event);
            }
        });

        let changed = match &event {
            Event::HealthChanged { health } => {
                self.health = Some(health.clone());
                true
            }
            _ => false,
        };
        let event = Arc::new(event);

        if *self.held.borrow() {
            self.waiting.push((seq, event));
        } else {
            for running in &self.bots {
                running.bot.send(Inbox::Frame {
                    seq,
                    event: Arc::clone(&event),
                });
            }
        }

        if changed {
            self.read();
        }
    }

    /// Holds the bots until a read begun from now lands: the stream is
    /// lost, and the settings may change before it is back.
    pub(crate) fn hold(&mut self) {
        self.held.send_replace(true);
        self.hold_after = self.newest;
    }

    /// Reads the settings under a ticket of its own, holding the bots until
    /// it lands; a read that fails is said once and tried again, until it
    /// is answered or a newer one starts.
    fn read(&mut self) {
        self.hold();
        self.newest += 1;

        if let Some(reading) = self.reading.take() {
            reading.abort();
        }

        let Some(daemon) = self.daemon.borrow().clone() else {
            return;
        };
        let ticket = self.newest;
        let answer = self.answer.clone();
        let lines = Arc::clone(&self.lines);

        self.reading = Some(
            tokio::spawn(async move {
                for failures in 0.. {
                    match daemon.connector_config().await {
                        Ok(view) => {
                            let _ = answer.send((ticket, view));
                            return;
                        }
                        Err(error) if failures == 0 => lines.report(&format!(
                            "Telegram connector: the daemon's Telegram settings could not be read \
                             ({}); trying again.",
                            error_sentence(&error)
                        )),
                        Err(_) => {}
                    }

                    tokio::time::sleep(backoff(failures)).await;
                }
            })
            .abort_handle(),
        );
    }

    /// Applies the newest read's answer; one that began after the hold ends
    /// it.
    fn answered(&mut self, (ticket, view): Answer) {
        if ticket != self.newest {
            return;
        }

        self.apply(&view);

        if ticket > self.hold_after {
            self.release();
        }
    }

    /// Makes the running bots the ones the answer asks for: a bot whose
    /// token is wanted for the same owner takes its new settings, any other
    /// is stopped, and each token wanted and not running starts its bot.
    fn apply(&mut self, view: &ConnectorConfigView) {
        let wanted = self.wanted(view);

        for running in std::mem::take(&mut self.bots) {
            let kept = wanted
                .iter()
                .find(|(token, _)| *token == running.token)
                .is_some_and(|(_, settings)| running.bot.same_owner(&settings.owner));

            if kept {
                self.bots.push(running);
            } else {
                running.bot.stop();
            }
        }

        for (token, settings) in wanted {
            if let Some(running) = self.bots.iter().find(|running| running.token == token) {
                running.bot.update(settings);
            } else {
                let bot = Bot::start(
                    Start {
                        telegram: Arc::clone(&self.telegram),
                        token: token.clone(),
                        settings,
                        draft_edits: self.draft_edits,
                        daemon: self.daemon.subscribe(),
                        held: self.held.subscribe(),
                        latest: self.latest.subscribe(),
                        lines: Arc::clone(&self.lines),
                        stop: self.stop.child_token(),
                    },
                    &self.tracker,
                );

                self.bots.push(Running { token, bot });
            }
        }

        match view {
            ConnectorConfigView::Refused { message, .. } => {
                self.notice.report(self.lines.as_ref(), message.clone());
            }
            ConnectorConfigView::Ok { .. } if self.bots.is_empty() => self.notice.say(
                self.lines.as_ref(),
                "Telegram is off, or no token is set; waiting for a change.".to_owned(),
            ),
            ConnectorConfigView::Ok { .. } => self.notice.forget(),
        }
    }

    /// The bots the config asks for, by the daemon's own judgment of each
    /// entry: the management bot while the home's entry is active and holds
    /// its token, then each character's whose entry is active and holds
    /// hers. A token an earlier bot has is not started again, and that is
    /// said once.
    fn wanted(&mut self, view: &ConnectorConfigView) -> Vec<(BotToken, BotSettings)> {
        let ConnectorConfigView::Ok {
            home, characters, ..
        } = view
        else {
            return Vec::new();
        };
        let names: BTreeMap<Identifier, String> = self
            .health
            .iter()
            .flat_map(|health| &health.characters)
            .map(|character| (character.id.clone(), character.display_name.to_string()))
            .collect();
        let home_bot = Values::of(home).and_then(|values| {
            let paired = values.paired();

            values.management_bot_token.map(|token| {
                (
                    token,
                    BotSettings {
                        owner: Owner::Management {
                            names: names.clone(),
                        },
                        paired,
                    },
                )
            })
        });
        let character_bots = characters.iter().filter_map(|entry| {
            let values = Values::of(entry.entry())?;
            let paired = values.paired();
            let id = entry.character_id();

            values.bot_token.map(|token| {
                (
                    token,
                    BotSettings {
                        owner: Owner::Character {
                            id: id.clone(),
                            name: names.get(id).map_or_else(|| id.to_string(), Clone::clone),
                            mirror: values.mirror == Some(true),
                        },
                        paired,
                    },
                )
            })
        });
        let mut wanted: Vec<(BotToken, BotSettings)> = Vec::new();
        let mut shared = BTreeSet::new();

        for (token, settings) in home_bot.into_iter().chain(character_bots) {
            let token = BotToken::new(&token);

            match wanted.iter().find(|(earlier, _)| *earlier == token) {
                Some((_, first)) => {
                    let owner = settings.owner.name();

                    shared.insert(format!(
                        "{owner}'s bot token is also {}'s; {owner}'s bot is not started.",
                        first.owner.name()
                    ));
                }
                None => wanted.push((token, settings)),
            }
        }

        for line in shared.difference(&self.shared) {
            self.lines.report(line);
        }

        self.shared = shared;
        wanted
    }

    /// Ends the hold: the snapshot of a `ready` is handed on first, then
    /// the frames since, in order, and then the bots go on.
    fn release(&mut self) {
        let unread = self.unread.take();
        let waiting = std::mem::take(&mut self.waiting);

        for running in &self.bots {
            if let Some((seq, snapshot)) = &unread {
                running.bot.send(Inbox::Install {
                    seq: *seq,
                    snapshot: Arc::clone(snapshot),
                });
            }

            for (seq, event) in &waiting {
                running.bot.send(Inbox::Frame {
                    seq: *seq,
                    event: Arc::clone(event),
                });
            }
        }

        self.held.send_replace(false);
    }

    /// Stops every bot, and answers once each has ended.
    pub(crate) async fn stop_all(&mut self) {
        if let Some(reading) = self.reading.take() {
            reading.abort();
        }

        for running in self.bots.drain(..) {
            running.bot.stop();
        }

        self.tracker.close();
        self.tracker.wait().await;
    }
}
