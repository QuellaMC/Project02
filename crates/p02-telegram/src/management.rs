//! The home's management bot, roster-shaped as the web page is: for a
//! paired account, who is on, what waits, and an answer to a pairing
//! request; and every confirmation and pairing request of the home shown
//! in every paired chat as a card with Approve and Deny, naming the surface
//! a confirmation was raised on and the source a pairing request's account
//! wrote to.

use p02_wire::{Answer, Event, PairingAnswer, PairingRequest, PendingConfirmation, RosterState};

use crate::bot::{Chat, DAEMON_DOWN, Rules};
use crate::bot_api::Message;
use crate::cards::{
    ALREADY_ANSWERED, CardKind, CardText, EXPIRED, Press, answered, confirm, confirmation_ending,
    pairing_ending,
};
use crate::outbox::Target;
use crate::table::{Owner, Snapshot};

const HELP: &str = "This is the home's management bot. /status says who is on; /pending shows \
                    what waits for you; /approve <code> and /deny <code> answer a pairing request.";

#[derive(Debug)]
pub(crate) struct Management;

impl Rules for Management {
    /// A command, by the first word of its text; any other text is answered
    /// with the help.
    async fn message(&mut self, chat: &mut Chat, message: Message) {
        let account = message.chat.id;
        let text = message.text.unwrap_or_default();
        let mut words = text.split_whitespace();
        let said = match (words.next(), words.next()) {
            (Some("/status"), _) => status(chat).await,
            (Some("/pending"), _) => {
                chat.outbox.pending(account, "Nothing waits for you.");
                return;
            }
            (Some(word @ ("/approve" | "/deny")), Some(code)) => {
                let decision = if word == "/approve" {
                    Answer::Approved
                } else {
                    Answer::Denied
                };

                settle(chat, code, decision, "That code is not waiting.").await
            }
            _ => Some(HELP.to_owned()),
        };

        if let Some(said) = said {
            chat.outbox.say_to_paired(account, said);
        }
    }

    async fn press(&mut self, chat: &mut Chat, press: &Press) -> Option<String> {
        match press.kind {
            CardKind::Confirmation => confirm(chat, press).await,
            CardKind::Pairing => settle(chat, &press.key, press.decision, ALREADY_ANSWERED).await,
        }
    }

    /// On a stream the daemon could not resume, a card for what the
    /// snapshot no longer carries is ended, and what still waits has its
    /// card in every paired chat.
    fn install(&mut self, chat: &mut Chat, snapshot: &Snapshot) {
        chat.outbox.keep_cards(
            CardKind::Confirmation,
            snapshot
                .confirmations
                .iter()
                .map(|pending| pending.id.to_string())
                .collect(),
        );
        chat.outbox.keep_cards(
            CardKind::Pairing,
            snapshot
                .pairings
                .iter()
                .map(|request| request.code.clone())
                .collect(),
        );

        for pending in &snapshot.confirmations {
            post_confirmation(chat, pending);
        }

        for request in &snapshot.pairings {
            post_pairing(chat, request);
        }
    }

    fn frame(&mut self, chat: &mut Chat, event: &Event) {
        match event {
            Event::ConfirmationRequested(pending) => post_confirmation(chat, pending),
            Event::ConfirmationSettled { id, settlement, .. } => chat.outbox.end_card(
                CardKind::Confirmation,
                id.to_string(),
                confirmation_ending(*settlement),
            ),
            // Announced again after a failed approval: a chat that holds
            // its card keeps it.
            Event::PairingRequested(request) => post_pairing(chat, request),
            Event::PairingSettled { code, decision, .. } => {
                chat.outbox
                    .end_card(CardKind::Pairing, code.clone(), pairing_ending(*decision));
            }
            _ => {}
        }
    }
}

fn post_confirmation(chat: &Chat, pending: &PendingConfirmation) {
    let settings = chat.settings();
    let name = match &settings.owner {
        Owner::Management { names } => names.get(&pending.character_id).cloned(),
        Owner::Character { .. } => None,
    };

    chat.outbox.card(
        CardKind::Confirmation,
        pending.id.to_string(),
        CardText::Confirmation {
            pending: pending.clone(),
            name: name.unwrap_or_else(|| pending.character_id.to_string()),
            raised_on: pending.turn.as_ref().map(|turn| turn.source.to_string()),
        },
        Target::EveryPaired,
    );
}

fn post_pairing(chat: &Chat, request: &PairingRequest) {
    chat.outbox.card(
        CardKind::Pairing,
        request.code.clone(),
        CardText::Pairing(request.clone()),
        Target::EveryPaired,
    );
}

/// Who is on, as the daemon says it now: each character and her state, or
/// off when she is switched off. Read afresh, since a character's state
/// moves on frames of its own. None once the bot stopped.
async fn status(chat: &Chat) -> Option<String> {
    let Some(daemon) = chat.daemon() else {
        return Some(DAEMON_DOWN.to_owned());
    };
    let Ok(health) = chat.unless_stopped(daemon.health()).await? else {
        return Some(DAEMON_DOWN.to_owned());
    };

    if health.characters.is_empty() {
        return Some("No characters are installed.".to_owned());
    }

    Some(
        health
            .characters
            .iter()
            .map(|character| {
                let state = if character.enabled {
                    words(character.state)
                } else {
                    "off"
                };

                format!("{}: {state}", character.display_name)
            })
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn words(state: RosterState) -> &'static str {
    match state {
        RosterState::NotStarted => "not started",
        RosterState::Starting => "starting",
        RosterState::Ready => "ready",
        RosterState::Stopping => "stopping",
        RosterState::Stopped => "stopped",
        RosterState::Failed => "failed",
    }
}

/// Settles a pairing request by its code, and says how it went: `unknown`
/// for a code nothing waits under. None once the bot stopped.
async fn settle(chat: &Chat, code: &str, decision: Answer, unknown: &str) -> Option<String> {
    // The code goes into the daemon's URL path.
    if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Some(unknown.to_owned());
    }

    let Some(daemon) = chat.daemon() else {
        return Some(DAEMON_DOWN.to_owned());
    };

    Some(
        match chat
            .unless_stopped(daemon.settle_pairing(code, decision))
            .await?
        {
            Ok(PairingAnswer::Settled { decision }) => answered(decision).to_owned(),
            Ok(PairingAnswer::Expired) => EXPIRED.to_owned(),
            Ok(PairingAnswer::Unknown) => unknown.to_owned(),
            Ok(PairingAnswer::Failed { message }) => message,
            Err(_) => DAEMON_DOWN.to_owned(),
        },
    )
}
