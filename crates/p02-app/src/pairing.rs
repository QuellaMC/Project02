//! Pairing: an account a connector does not know, waiting for the person's
//! answer under a code any surface shows and answers by, as a confirmation
//! waits; an approval writes the account into the home's allowlist through
//! the daemon's one change of settings.

use std::sync::{Mutex, MutexGuard, PoisonError};

use p02_config::{Connector, Resolution};
use p02_core::{ClientStamp, SpeakerName, Timestamp};
use p02_shared::Fingerprint;
use p02_wire::{
    Answer, ChangeOutcome, ConfigChange, ConfigTarget, Event, Namespace, Operation, PairingAnswer,
    PairingDecision, PairingOutcome, PairingRefusal, PairingRequest, PairingSubject,
};
use serde_json::{Map, Value};
use tokio::task::AbortHandle;
use tokio::time::Instant;

use crate::daemon::{Daemon, World, blocking};

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
    /// named `label`, which wrote to `source`: an account the home lets in
    /// already is `paired`; otherwise the request waiting for that account,
    /// wherever it wrote this time, or a new one from `source` under a
    /// fresh code until the pairing deadline, which every surface hears of.
    pub async fn request_pairing(
        &self,
        connector: &str,
        id: ClientStamp,
        label: SpeakerName,
        source: ClientStamp,
    ) -> PairingOutcome {
        let connector = match p02_config::connector(connector) {
            Ok(connector) => connector,
            Err(unknown) => {
                return PairingOutcome::Refused {
                    reason: PairingRefusal::UnknownConnector,
                    message: unknown.to_string(),
                };
            }
        };
        let daemon = self.clone();

        blocking(move || daemon.ask(connector, PairingSubject { id, label }, source)).await
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
    /// request waiting with what is left of its time.
    /// The approval runs on the blocking pool to its end, so a caller that
    /// stops waiting leaves nothing of it undone.
    pub async fn settle_pairing(&self, code: &str, answer: Answer) -> PairingAnswer {
        let daemon = self.clone();
        let code = code.to_owned();

        blocking(move || daemon.settle(&code, answer)).await
    }

    fn ask(
        &self,
        connector: &'static Connector,
        subject: PairingSubject,
        source: ClientStamp,
    ) -> PairingOutcome {
        let paired = match allowlist(self.world(), connector) {
            Ok(allowlist) => allowlist.accounts.contains_key(subject.id.as_str()),
            Err(message) => {
                return PairingOutcome::Refused {
                    reason: PairingRefusal::ConfigUnloadable,
                    message,
                };
            }
        };
        if paired {
            return PairingOutcome::Paired;
        }

        let mut waiting = self.pairings().waiting();
        let asked = waiting.iter().position(|entry| {
            entry.request.connector_id == *connector.id() && entry.request.subject.id == subject.id
        });

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
                source,
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
        let written = self.admit(connector, &request.subject);
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

    /// Writes `subject` into `connector`'s allowlist by the daemon's one
    /// change of settings: the whole allowlist as one change of its field,
    /// bound to the fingerprint it was read under. An account the allowlist
    /// holds already keeps the name it has. The sentence saying why the
    /// account is not in, when it is not.
    fn admit(&self, connector: &Connector, subject: &PairingSubject) -> Result<(), String> {
        let Allowlist {
            fingerprint,
            mut accounts,
        } = allowlist(self.world(), connector)?;

        if accounts.contains_key(subject.id.as_str()) {
            return Ok(());
        }

        accounts.insert(subject.id.to_string(), Value::from(subject.label.as_str()));

        let change = ConfigChange {
            target: ConfigTarget::Global,
            expected_fingerprint: fingerprint.as_str().to_owned(),
            operation: Operation::SectionFieldSet {
                namespace: Namespace::Connectors,
                id: connector.id().to_string(),
                field: connector.pairing_field().to_owned(),
                value: Value::Object(accounts),
            },
        };

        match self.change_settings(&change) {
            ChangeOutcome::Applied { .. } => Ok(()),
            ChangeOutcome::Refused { message, .. } | ChangeOutcome::Failed { message } => {
                Err(message)
            }
        }
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
