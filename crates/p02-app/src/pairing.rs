//! Pairing: an account a connector does not know, waiting for the person's
//! answer under a code any surface shows and answers by, as a confirmation
//! waits; an approval writes the account into the home's allowlist through
//! the daemon's one change of settings.

use std::sync::{Mutex, MutexGuard, PoisonError};

use p02_config::{
    ChangeOutcome, ChangeRefusal, ConfigChange, ConfigTarget, Connector, Namespace, Operation,
    Resolution, connectors,
};
use p02_core::{ClientStamp, SpeakerName, Timestamp};
use p02_shared::Fingerprint;
use serde_json::{Map, Value};
use tokio::task::AbortHandle;
use tokio::time::Instant;

use crate::confirmation::Answer;
use crate::daemon::{Daemon, World, blocking};
use crate::outcome::{
    Event, PairingAnswer, PairingDecision, PairingOutcome, PairingRefusal, PairingRequest,
    PairingSubject,
};

/// Writes in all for one approval while other writes keep moving the
/// home's document.
const WRITE_ATTEMPTS: usize = 3;

const INVALID_SUBJECT: &str = "A pairing names the account by its id, one token of letters, \
     digits and any of \":._-\" at most 64 characters, and by a name of one line, at most 128 \
     characters.";

/// The requests waiting, oldest first. None outlives the daemon's run.
#[derive(Debug, Default)]
pub(crate) struct Pairings {
    waiting: Mutex<Vec<Waiting>>,
}

#[derive(Debug)]
struct Waiting {
    request: PairingRequest,
    connector: &'static Connector,
    deadline: Instant,
    /// Its approval is being written: it takes no second answer meanwhile,
    /// and its deadline is not watched.
    writing: bool,
    timer: Option<AbortHandle>,
}

impl Waiting {
    fn disarm(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
    }
}

impl Pairings {
    /// Its deadlines are watched no more: the daemon stops.
    pub(crate) fn stop(&self) {
        for waiting in self.waiting().iter_mut() {
            waiting.disarm();
        }
    }

    fn waiting(&self) -> MutexGuard<'_, Vec<Waiting>> {
        self.waiting.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Daemon {
    /// Asks the person to let in the account `id` of connector `connector`,
    /// named `label`: an account the home lets in already is `paired`, and a
    /// request waiting for that account settles approved with it, unless
    /// its approval is being written; otherwise the request waiting for it,
    /// or a new one under a fresh code until the pairing deadline, which
    /// every surface hears of.
    pub async fn request_pairing(
        &self,
        connector: &str,
        id: ClientStamp,
        label: &str,
    ) -> PairingOutcome {
        let Some(connector) = connectors()
            .iter()
            .find(|known| known.id().as_str() == connector)
        else {
            let pairing: Vec<&str> = connectors()
                .iter()
                .map(|known| known.id().as_str())
                .collect();

            return PairingOutcome::Refused {
                reason: PairingRefusal::UnknownConnector,
                message: format!(
                    "Connector \"{connector}\" does not pair. Connectors that pair: {}.",
                    pairing.join(", ")
                ),
            };
        };
        let Ok(label) = SpeakerName::new(label) else {
            return PairingOutcome::Refused {
                reason: PairingRefusal::InvalidSubject,
                message: INVALID_SUBJECT.to_owned(),
            };
        };
        let daemon = self.clone();

        blocking(move || daemon.ask(connector, PairingSubject { id, label })).await
    }

    /// The requests waiting, oldest first.
    #[must_use]
    pub fn pending_pairings(&self) -> Vec<PairingRequest> {
        self.pairings()
            .waiting()
            .iter()
            .map(|waiting| waiting.request.clone())
            .collect()
    }

    /// Answers the request `code`. The daemon judges its deadline: one the
    /// clock has passed is settled expired, whatever its timer, on a clock
    /// of its own, has done. An approval stays waiting while it is written,
    /// taking no second answer, and one that cannot be written leaves the
    /// request waiting with what is left of its time, announced again.
    /// The approval runs on the blocking pool to its end, so a caller that
    /// stops waiting leaves nothing of it undone.
    pub async fn settle_pairing(&self, code: &str, answer: Answer) -> PairingAnswer {
        let daemon = self.clone();
        let code = code.to_owned();

        blocking(move || daemon.settle(&code, answer)).await
    }

    fn ask(&self, connector: &'static Connector, subject: PairingSubject) -> PairingOutcome {
        let paired = match allowlist(self.world(), connector) {
            Ok(allowlist) => allowlist.accounts.contains_key(subject.id.as_str()),
            Err(message) => {
                return PairingOutcome::Refused {
                    reason: PairingRefusal::ConfigUnloadable,
                    message,
                };
            }
        };
        let mut waiting = self.pairings().waiting();
        let asked = waiting.iter().position(|entry| {
            entry.request.connector_id == *connector.id() && entry.request.subject.id == subject.id
        });

        if paired {
            if let Some(index) = asked.filter(|index| !waiting[*index].writing) {
                let mut settled = waiting.remove(index);

                settled.disarm();
                self.announce_settled(&settled.request, PairingDecision::Approved);
            }

            return PairingOutcome::Paired;
        }

        if let Some(index) = asked {
            return PairingOutcome::Pending {
                request: waiting[index].request.clone(),
            };
        }

        let wait = self.durations().pairing;
        let requested_at = Timestamp::now();
        let mut asked = Waiting {
            request: PairingRequest {
                connector_id: connector.id().clone(),
                code: fresh_code(&waiting),
                subject,
                expires_at: requested_at
                    .unix_millis()
                    .saturating_add(i64::try_from(wait.as_millis()).unwrap_or(i64::MAX)),
                requested_at,
            },
            connector,
            deadline: Instant::now() + wait,
            writing: false,
            timer: None,
        };
        let request = asked.request.clone();

        self.arm(&mut asked);
        self.world()
            .events
            .emit(Event::PairingRequested(request.clone()));
        waiting.push(asked);
        PairingOutcome::Pending { request }
    }

    fn settle(&self, code: &str, answer: Answer) -> PairingAnswer {
        let (connector, request) = {
            let mut waiting = self.pairings().waiting();
            let Some(index) = waiting
                .iter()
                .position(|entry| entry.request.code == code && !entry.writing)
            else {
                return PairingAnswer::Unknown;
            };

            if Timestamp::now().unix_millis() >= waiting[index].request.expires_at {
                let mut expired = waiting.remove(index);

                expired.disarm();
                self.announce_settled(&expired.request, PairingDecision::Expired);
                return PairingAnswer::Expired;
            }

            if answer == Answer::Denied {
                let mut denied = waiting.remove(index);

                denied.disarm();
                self.announce_settled(&denied.request, PairingDecision::Denied);
                return PairingAnswer::Settled { decision: answer };
            }

            let approved = &mut waiting[index];

            approved.writing = true;
            approved.disarm();
            (approved.connector, approved.request.clone())
        };
        let written = admit(self.world(), connector, &request.subject, |change| {
            self.change_settings(change)
        });
        let mut waiting = self.pairings().waiting();
        let index = waiting
            .iter()
            .position(|entry| entry.request.code == request.code);

        match written {
            Ok(()) => {
                if let Some(index) = index {
                    waiting.remove(index);
                }

                self.announce_settled(&request, PairingDecision::Approved);
                PairingAnswer::Settled { decision: answer }
            }
            Err(message) => {
                if let Some(index) = index {
                    let unwritten = &mut waiting[index];

                    unwritten.writing = false;
                    self.arm(unwritten);
                }

                // Again, so a surface that came meanwhile shows it too, and
                // one that has it keeps one card.
                self.world().events.emit(Event::PairingRequested(request));
                PairingAnswer::Failed { message }
            }
        }
    }

    /// Settles the request `code` expired at its deadline, unless an
    /// answer settled it first or its approval is being written.
    fn expire(&self, code: &str) {
        let mut waiting = self.pairings().waiting();

        if let Some(index) = waiting
            .iter()
            .position(|entry| entry.request.code == code && !entry.writing)
        {
            let expired = waiting.remove(index);

            self.announce_settled(&expired.request, PairingDecision::Expired);
        }
    }

    /// Watches `waiting`'s deadline, on tokio's clock, without keeping the
    /// daemon alive for it.
    fn arm(&self, waiting: &mut Waiting) {
        let daemon = self.downgrade();
        let code = waiting.request.code.clone();
        let deadline = waiting.deadline;

        waiting.timer = Some(
            tokio::spawn(async move {
                tokio::time::sleep_until(deadline).await;

                if let Some(daemon) = daemon.upgrade() {
                    daemon.expire(&code);
                }
            })
            .abort_handle(),
        );
    }

    fn announce_settled(&self, request: &PairingRequest, decision: PairingDecision) {
        self.world().events.emit(Event::PairingSettled {
            connector_id: request.connector_id.clone(),
            code: request.code.clone(),
            subject: request.subject.clone(),
            decision,
        });
    }
}

/// The accounts a connector's allowlist holds in the home's document, in
/// the clear, since an approval writes them back, and the fingerprint that
/// write is bound to.
struct Allowlist {
    fingerprint: Fingerprint,
    accounts: Map<String, Value>,
}

/// `connector`'s allowlist as the home's settings hold it now; a value its
/// field refuses holds no account. The sentence saying why the home's
/// settings cannot be read, when they cannot.
fn allowlist(world: &World, connector: &Connector) -> Result<Allowlist, String> {
    let resolution =
        Resolution::home(&world.home, &world.sections).map_err(|error| error.sentence())?;
    let accounts = resolution
        .section_value(
            Namespace::Connectors,
            connector.id().as_str(),
            connector.pairing_field(),
        )
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    Ok(Allowlist {
        fingerprint: resolution.fingerprint().clone(),
        accounts,
    })
}

/// Writes `subject` into `connector`'s allowlist by `apply`, the daemon's
/// one change of settings: the whole allowlist as one change of its field,
/// bound to the fingerprint it was read under, and while other writes move
/// the document meanwhile, read again and merged with the accounts paired
/// since, up to three writes in all. An account another hand paired
/// meanwhile keeps the name that hand gave it. The sentence saying why the
/// account is not in, when it is not.
fn admit(
    world: &World,
    connector: &Connector,
    subject: &PairingSubject,
    mut apply: impl FnMut(&ConfigChange) -> ChangeOutcome,
) -> Result<(), String> {
    let mut attempts = 1;

    loop {
        let Allowlist {
            fingerprint,
            mut accounts,
        } = allowlist(world, connector)?;

        if accounts.contains_key(subject.id.as_str()) {
            return Ok(());
        }

        accounts.insert(subject.id.to_string(), Value::from(subject.label.as_str()));

        match apply(&ConfigChange {
            target: ConfigTarget::Global,
            expected_fingerprint: fingerprint.as_str().to_owned(),
            operation: Operation::SectionFieldSet {
                namespace: Namespace::Connectors,
                id: connector.id().to_string(),
                field: connector.pairing_field().to_owned(),
                value: Value::Object(accounts),
            },
        }) {
            ChangeOutcome::Applied { .. } => return Ok(()),
            ChangeOutcome::Refused {
                reason: ChangeRefusal::Conflict,
                ..
            } if attempts < WRITE_ATTEMPTS => attempts += 1,
            ChangeOutcome::Refused { message, .. } | ChangeOutcome::Failed { message } => {
                return Err(message);
            }
        }
    }
}

/// Six digits a person reads off one screen and finds on another, drawn
/// uniformly and unlike any waiting.
fn fresh_code(waiting: &[Waiting]) -> String {
    loop {
        let code = rand::random_range(100_000..1_000_000_u32).to_string();

        if waiting.iter().all(|entry| entry.request.code != code) {
            return code;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use p02_characters::discover;
    use p02_config::{Sections, apply_change};
    use p02_shared::{DanglingLinks, canonical_path};
    use p02_store::Home;
    use serde_json::json;

    use super::*;
    use crate::daemon::Durations;

    fn world(home: Home) -> World {
        World {
            home,
            sections: Sections::new(Vec::new()),
            plugins: Vec::new(),
            durations: Durations::default(),
            test_provider: None,
            events: Arc::default(),
        }
    }

    fn pairing(world: &World, id: &str, label: &str) -> ConfigChange {
        let Allowlist {
            fingerprint,
            mut accounts,
        } = allowlist(world, &connectors()[0]).unwrap();

        accounts.insert(id.to_owned(), json!(label));
        serde_json::from_value(json!({
            "target": {"scope": "global"},
            "expectedFingerprint": fingerprint.as_str(),
            "operation": {
                "kind": "section_field_set",
                "namespace": "connectors",
                "id": "telegram",
                "field": "pairedUsers",
                "value": accounts,
            },
        }))
        .unwrap()
    }

    /// pairing.approve-retries-conflict: An approval whose write meets a concurrently moved config document is written again from a fresh read, merging with accounts already paired.
    #[test]
    fn an_approval_whose_write_meets_a_moved_document_is_written_again_from_a_fresh_read() {
        let directory = tempfile::tempdir().unwrap();
        let world = world(Home::new(
            canonical_path(directory.path(), DanglingLinks::Keep).unwrap(),
        ));
        let telegram = &connectors()[0];
        let wait = Duration::from_secs(10);
        let apply = |change: &ConfigChange| {
            apply_change(
                &world.home,
                &world.sections,
                &discover(world.home.root()),
                change,
                wait,
            )
        };
        let alice = PairingSubject {
            id: ClientStamp::new("381940562").unwrap(),
            label: SpeakerName::new("Alice").unwrap(),
        };
        let mut written: Vec<ConfigChange> = Vec::new();

        admit(&world, telegram, &alice, |change| {
            if written.is_empty() {
                // Another window pairs Bob between the approval's read and
                // its write.
                assert!(matches!(
                    apply(&pairing(&world, "987654321", "Bob")),
                    ChangeOutcome::Applied { .. }
                ));
            }

            written.push(change.clone());
            apply(change)
        })
        .unwrap();

        let fingerprints: Vec<&str> = written
            .iter()
            .map(|change| change.expected_fingerprint.as_str())
            .collect();
        let paired = json!({"987654321": "Bob", "381940562": "Alice"});

        assert_eq!(fingerprints.len(), 2);
        assert_ne!(fingerprints[0], fingerprints[1]);
        assert_eq!(
            allowlist(&world, telegram).unwrap().accounts,
            *paired.as_object().unwrap()
        );
    }
}
