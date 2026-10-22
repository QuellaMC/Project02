//! The cards: messages with Approve and Deny that end. A card is one
//! message, its buttons on it, so a text past Telegram's longest is cut to
//! fit; once what it asks about is settled, each of its messages is revised
//! to its text and how it ended, buttons gone.

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::time::{SystemTime, UNIX_EPOCH};

use p02_app::{
    Answer, CancelReason, ConfirmationAnswer, PairingDecision, PairingRequest, PendingConfirmation,
    Settlement,
};

use crate::bot::{Chat, DAEMON_DOWN};
use crate::bot_api::{Button, Keyboard, MAX_MESSAGE, within};

/// How a card ends when the bot missed the word: the snapshot it came back
/// to no longer carries what it asked about.
pub(crate) const AWAY: &str = "settled while the bot was away";

/// What a card asks about, by the letter its buttons carry before the
/// confirmation's id or the pairing request's code. Telegram takes 1 to
/// 64 bytes of `callback_data`: `c:<uuid>:a` is 40.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CardKind {
    Confirmation,
    Pairing,
}

impl CardKind {
    fn letter(self) -> char {
        match self {
            Self::Confirmation => 'c',
            Self::Pairing => 'p',
        }
    }
}

/// A press of a card's button: what the card asks about, and the answer.
#[derive(Debug)]
pub(crate) struct Press {
    pub(crate) kind: CardKind,
    pub(crate) key: String,
    pub(crate) decision: Answer,
}

impl Press {
    /// The press `data` names; none for data no card carries. A key is a
    /// confirmation's UUID or a pairing code, and the daemon gets it in a
    /// URL path, so nothing else is let through.
    pub(crate) fn parse(data: Option<&str>) -> Option<Self> {
        let mut parts = data?.split(':');
        let (Some(letter), Some(key), Some(answer), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return None;
        };
        let kind = match letter {
            "c" => CardKind::Confirmation,
            "p" => CardKind::Pairing,
            _ => return None,
        };
        let decision = match answer {
            "a" => Answer::Approved,
            "d" => Answer::Denied,
            _ => return None,
        };
        let keyed = (1..=36).contains(&key.len())
            && key
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-');

        keyed.then(|| Self {
            kind,
            key: key.to_owned(),
            decision,
        })
    }
}

/// How an answer went, as a toast or a reply says it.
pub(crate) fn answered(decision: Answer) -> &'static str {
    match decision {
        Answer::Approved => "Approved.",
        Answer::Denied => "Denied.",
    }
}

pub(crate) const EXPIRED: &str = "Too late: it expired.";

pub(crate) const ALREADY_ANSWERED: &str = "Already answered.";

/// What a card says, rendered as it is sent, so a card held back says
/// what a deadline has left as of then, and once more as it ends, without
/// the deadline.
#[derive(Clone, Debug)]
pub(crate) enum CardText {
    /// Who wants what, where it was raised when the card names that, and
    /// the preview when it has one.
    Confirmation {
        pending: PendingConfirmation,
        name: String,
        raised_on: Option<String>,
    },
    Pairing(PairingRequest),
}

impl CardText {
    fn render(&self, ended: bool) -> String {
        match self {
            Self::Confirmation {
                pending,
                name,
                raised_on,
            } => {
                let mut lines = vec![format!("{name} wants to: {}", pending.request.summary)];

                if let Some(surface) = raised_on {
                    let _ = write!(lines[0], " · raised on {surface}");
                }

                if !pending.request.preview.is_empty() {
                    lines.push(
                        serde_json::to_string_pretty(&pending.request.preview).unwrap_or_default(),
                    );
                }

                if !ended {
                    lines.push(format!("Expires in {}", minutes_left(pending.deadline_at)));
                }

                lines.join("\n")
            }
            Self::Pairing(request) => {
                let mut text = format!(
                    "{} wants to pair · code {}",
                    request.subject.label, request.code
                );

                if !ended {
                    let _ = write!(text, " · expires in {}", minutes_left(request.expires_at));
                }

                text
            }
        }
    }
}

/// How a confirmation ended, as its card's last words say it.
pub(crate) fn confirmation_ending(settlement: Settlement) -> &'static str {
    match settlement {
        Settlement::Approved => "approved",
        Settlement::Denied => "denied",
        Settlement::Cancelled {
            reason: CancelReason::Expired,
        } => "expired",
        Settlement::Cancelled {
            reason: CancelReason::Stopped,
        } => "cancelled when the character stopped",
    }
}

pub(crate) fn pairing_ending(decision: PairingDecision) -> &'static str {
    match decision {
        PairingDecision::Approved => "approved",
        PairingDecision::Denied => "denied",
        PairingDecision::Expired => "expired",
    }
}

/// What a deadline has left, in whole minutes and at least one, as a chat
/// says it: a clock time would be this machine's, and the reader may be
/// elsewhere.
pub(crate) fn minutes_left(deadline_ms: i64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        });
    let minutes = (deadline_ms.saturating_sub(now).saturating_add(59_999))
        .div_euclid(60_000)
        .max(1);

    format!(
        "{minutes} {}",
        if minutes == 1 { "minute" } else { "minutes" }
    )
}

/// One card: what it says, the chats it went to, and its message in each
/// it reached.
#[derive(Debug)]
struct Card {
    key: String,
    text: CardText,
    /// Chats it was sent to; one whose send failed is taken off, so the
    /// next post tries it again.
    sent: BTreeSet<i64>,
    messages: Vec<(i64, i64)>,
}

/// The cards of one kind a bot shows, in the order they were raised.
#[derive(Debug)]
pub(crate) struct Cards {
    kind: CardKind,
    cards: Vec<Card>,
}

/// A card's message to revise, and the words it ends with.
pub(crate) type Revision = (i64, i64, String);

impl Cards {
    pub(crate) fn new(kind: CardKind) -> Self {
        Self {
            kind,
            cards: Vec::new(),
        }
    }

    pub(crate) fn kind(&self) -> CardKind {
        self.kind
    }

    /// Holds the card, one already held keeping its text, and answers the
    /// chats of `chats` it is still to go to.
    pub(crate) fn post(&mut self, key: &str, text: CardText, chats: &[i64]) -> Vec<i64> {
        let index = self
            .cards
            .iter()
            .position(|card| card.key == key)
            .unwrap_or_else(|| {
                self.cards.push(Card {
                    key: key.to_owned(),
                    text,
                    sent: BTreeSet::new(),
                    messages: Vec::new(),
                });
                self.cards.len() - 1
            });
        let card = &mut self.cards[index];

        chats
            .iter()
            .copied()
            .filter(|chat| card.sent.insert(*chat))
            .collect()
    }

    /// The keys of every card held that is still to go to `chat`.
    pub(crate) fn post_all(&mut self, chat: i64) -> Vec<String> {
        self.cards
            .iter_mut()
            .filter_map(|card| card.sent.insert(chat).then(|| card.key.clone()))
            .collect()
    }

    pub(crate) fn len(&self) -> usize {
        self.cards.len()
    }

    /// The card's message with its buttons, as it is sent now; none for a
    /// card that ended.
    pub(crate) fn message(&self, key: &str) -> Option<(String, Keyboard)> {
        let card = self.cards.iter().find(|card| card.key == key)?;
        let data = |answer: char| format!("{}:{key}:{answer}", self.kind.letter());

        Some((
            within(MAX_MESSAGE, &card.text.render(false), ""),
            Keyboard::row(vec![
                Button::new("Approve", data('a')),
                Button::new("Deny", data('d')),
            ]),
        ))
    }

    /// The card's message in `chat`, once sent, or the chat taken off so
    /// that the next post tries it again.
    pub(crate) fn sent(&mut self, key: &str, chat: i64, message: Option<i64>) {
        if let Some(card) = self.cards.iter_mut().find(|card| card.key == key) {
            match message {
                Some(message) => card.messages.push((chat, message)),
                None => {
                    card.sent.remove(&chat);
                }
            }
        }
    }

    /// Forgets the card, and answers each of its messages with the words
    /// it ends with.
    pub(crate) fn end(&mut self, key: &str, ending: &str) -> Vec<Revision> {
        let Some(index) = self.cards.iter().position(|card| card.key == key) else {
            return Vec::new();
        };
        let card = self.cards.remove(index);
        let ended = within(
            MAX_MESSAGE,
            &card.text.render(true),
            &format!(" · {ending}"),
        );

        card.messages
            .into_iter()
            .map(|(chat, message)| (chat, message, ended.clone()))
            .collect()
    }

    /// Ends every card but those of `keys`, as settled while the bot was
    /// away.
    pub(crate) fn keep(&mut self, keys: &[String]) -> Vec<Revision> {
        let gone: Vec<String> = self
            .cards
            .iter()
            .filter(|card| !keys.contains(&card.key))
            .map(|card| card.key.clone())
            .collect();

        gone.iter().flat_map(|key| self.end(key, AWAY)).collect()
    }
}

/// Answers the confirmation the press names, and says how that went; none
/// once the bot stopped.
pub(crate) async fn confirm(chat: &Chat, press: &Press) -> Option<String> {
    let Some(daemon) = chat.daemon() else {
        return Some(DAEMON_DOWN.to_owned());
    };
    let answer = chat
        .unless_stopped(daemon.answer_confirmation(&press.key, press.decision))
        .await?;

    Some(
        match answer {
            Ok(ConfirmationAnswer::Answered) => answered(press.decision),
            Ok(ConfirmationAnswer::Expired) => EXPIRED,
            Ok(ConfirmationAnswer::Unknown) => ALREADY_ANSWERED,
            Err(_) => DAEMON_DOWN,
        }
        .to_owned(),
    )
}
