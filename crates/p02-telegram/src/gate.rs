//! The pairing gate a bot keeps on everything an account sends it: an
//! account the bot's read of the settings does not hold is asked for, and
//! told its code, and nothing of what it sent is carried. The daemon's
//! allowlist is the gate and the settings this bot's read of it, so an
//! account the daemon let in since is let in before the next read lands.

use std::collections::HashMap;

use p02_app::{Event, PairingDecision, PairingOutcome};
use p02_core::{ClientStamp, SpeakerName};
use p02_gateway::{PairingSubjectBody, Short};

use crate::bot::{Chat, DAEMON_DOWN, capitalized};
use crate::bot_api::User;
use crate::cards::minutes_left;
use crate::daemon::CONNECTOR;
use crate::table::Owner;

const REFUSED: &str =
    "This bot is private, and cannot take a pairing request right now; try again later.";

/// The codes this bot gave, by account, until each request is settled.
#[derive(Debug, Default)]
pub(crate) struct Gate {
    strangers: HashMap<String, String>,
}

impl Gate {
    /// Whether the account is let in. One the settings do not hold is asked
    /// for, and told its code, what its request has left, or why it cannot
    /// be asked for.
    pub(crate) async fn admit(&mut self, chat: &Chat, chat_id: i64, from: &User) -> bool {
        let settings = chat.settings();
        let account = from.id.to_string();

        if settings.paired.contains(&account) {
            return true;
        }

        let label = label_of(from);
        let (Ok(id), Ok(short)) = (ClientStamp::new(&account), Short::new(&label)) else {
            chat.outbox.say(chat_id, REFUSED.to_owned());
            return false;
        };
        let asked = match chat.daemon() {
            Some(daemon) => {
                let subject = PairingSubjectBody { id, label: short };

                match chat.unless_stopped(daemon.request_pairing(subject)).await {
                    Some(asked) => asked.ok(),
                    None => return false,
                }
            }
            None => None,
        };

        match asked {
            Some(PairingOutcome::Pending { request }) => {
                chat.outbox.say(
                    chat_id,
                    format!(
                        "This bot is private. Your pairing code is {}, good for {}. Approve it on \
                         the web page{}",
                        request.code,
                        minutes_left(request.expires_at),
                        match settings.owner {
                            Owner::Management { .. } => ".",
                            Owner::Character { .. } => ", or send it to the management bot.",
                        }
                    ),
                );
                self.strangers.insert(account, request.code);
                false
            }
            Some(PairingOutcome::Paired) => {
                chat.outbox.admitted(chat_id);
                true
            }
            Some(PairingOutcome::Refused { message, .. }) => {
                chat.outbox.say(chat_id, REFUSED.to_owned());
                chat.report(&format!(
                    "{} could not ask to pair {label}: {message}",
                    capitalized(&settings.owner.bot())
                ));
                false
            }
            None => {
                chat.outbox.say(chat_id, DAEMON_DOWN.to_owned());
                false
            }
        }
    }

    /// Tells an account this bot gave a code how that request ended; an
    /// earlier code's ending is not this one's.
    pub(crate) fn settled(&mut self, chat: &Chat, event: &Event) {
        let Event::PairingSettled {
            connector_id,
            code,
            subject,
            decision,
        } = event
        else {
            return;
        };

        if connector_id.as_str() != CONNECTOR
            || self.strangers.get(subject.id.as_str()) != Some(code)
        {
            return;
        }

        self.strangers.remove(subject.id.as_str());

        let Ok(account) = subject.id.as_str().parse() else {
            return;
        };
        let settings = chat.settings();
        let listener = match &settings.owner {
            Owner::Management { .. } => "The management bot",
            Owner::Character { name, .. } => name,
        };

        chat.outbox.say(
            account,
            match decision {
                PairingDecision::Approved => format!("Paired. {listener} is listening."),
                PairingDecision::Denied => "The owner declined.".to_owned(),
                PairingDecision::Expired => {
                    "Your pairing code expired; write again for a new one.".to_owned()
                }
            },
        );
    }
}

/// The name the owner sees: one line, no longer than a speaker's name, and
/// the account's id for one that would say nothing.
fn label_of(user: &User) -> String {
    let name = [
        Some(user.first_name.clone()),
        user.last_name.clone(),
        user.username
            .as_ref()
            .map(|username| format!("(@{username})")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");
    let one_line = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let label: String = one_line.chars().take(SpeakerName::MAX_CHARS).collect();
    let label = label.trim_end();

    if label.is_empty() {
        user.id.to_string()
    } else {
        label.to_owned()
    }
}
