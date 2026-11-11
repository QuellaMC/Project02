//! Her phone's rings as her actor keeps them: the rings set on her phone,
//! read when she is built and again after every turn of hers, since a turn
//! is the only thing that sets or clears one, and the rings a moment told
//! that did not leave her phone, which wait for a turn of hers that
//! completes.

use std::sync::Arc;
use std::time::{Duration, Instant};

use p02_contracts::{FileStoreBackend, Rang};
use p02_core::Timestamp;
use p02_phone::{Now, Phone, SetRing};
use p02_shared::{error_chain, sentence};

use crate::daemon::blocking;

/// How long her actor waits for her phone's store, which a call of her
/// phone's tools holds a moment at most.
const LEASE: Duration = Duration::from_secs(10);

/// A ring is due by the wall clock, and a sleep counts the machine's own
/// clock, which stands still while the machine sleeps and goes on when the
/// wall clock is set: so her actor sleeps toward a ring half a minute at a
/// stretch at most and then reads the wall clock again, and a ring comes
/// late rather than never, and never early.
const LOOK_AGAIN: Duration = Duration::from_secs(30);

/// Her phone's rings, as her actor last read them.
#[derive(Debug, Default)]
pub(crate) struct Rings {
    /// Every ring set on her phone, soonest first.
    set: Vec<SetRing>,
    /// The rings a moment told that did not leave her phone, since the
    /// moment did not complete or her phone could not let them go: none
    /// of them rings again until a turn of hers completes.
    held: Vec<SetRing>,
}

/// What her phone said, read under one lease of its store.
struct Looked {
    /// The rings set on it; none when they could not be read.
    set: Vec<SetRing>,
    /// Whether the rings told left it, but those their apps set anew.
    let_go: bool,
    /// What failed, a sentence each.
    failures: Vec<String>,
}

impl Rings {
    /// How long until her next ring is due by the wall clock, which reads
    /// `now`: half a minute at most, after which it is read again.
    pub(crate) fn wait(&self, now: &Timestamp) -> Option<Duration> {
        let next = self.ringing().next()?.ring.at();
        let left = u64::try_from(next.unix_millis() - now.unix_millis()).unwrap_or(0);

        Some(Duration::from_millis(left).min(LOOK_AGAIN))
    }

    /// Every ring due by `now`, soonest first, but those held.
    pub(crate) fn due(&self, now: &Timestamp) -> Vec<SetRing> {
        self.ringing()
            .take_while(|ring| ring.ring.at() <= now)
            .cloned()
            .collect()
    }

    /// Holds `told`, which a moment that never began would have told.
    pub(crate) fn hold(&mut self, told: Vec<SetRing>) {
        self.held.extend(told);
    }

    /// Reads the rings set on her phone from `phone`, its store, none while
    /// she runs no phone. What failed, a sentence each.
    pub(crate) async fn read(&mut self, phone: Option<Arc<dyn FileStoreBackend>>) -> Vec<String> {
        self.look(phone, Vec::new()).await.1
    }

    /// After a turn of hers that told `told`, and `completed` or not: when
    /// it completed, the rings held ring again and those it told are handed
    /// to their apps, and the ones that did not leave her phone are held,
    /// as are all it told when it did not complete. Then the rings set are
    /// read anew. What failed, a sentence each.
    pub(crate) async fn after_turn(
        &mut self,
        phone: Option<Arc<dyn FileStoreBackend>>,
        told: Vec<SetRing>,
        completed: bool,
    ) -> Vec<String> {
        if !completed {
            self.held.extend(told);
            return self.read(phone).await;
        }

        self.held.clear();

        let (let_go, failures) = self.look(phone, told.clone()).await;

        if !let_go {
            self.held.extend(told);
        }

        failures
    }

    /// Hands `told` to their apps on her phone, when there are any, then
    /// reads the rings set on it, all under one lease of `phone`, its store,
    /// on the blocking pool: whether the rings told left it, and what
    /// failed, a sentence each. She who runs no phone has no rings.
    async fn look(
        &mut self,
        phone: Option<Arc<dyn FileStoreBackend>>,
        told: Vec<SetRing>,
    ) -> (bool, Vec<String>) {
        let Some(store) = phone else {
            self.set.clear();
            return (told.is_empty(), Vec::new());
        };
        let looked = blocking(move || look(store.as_ref(), &told)).await;

        self.set = looked.set;
        (looked.let_go, looked.failures)
    }

    /// The rings set, soonest first, but those held.
    fn ringing(&self) -> impl Iterator<Item = &SetRing> {
        self.set.iter().filter(|ring| !self.held.contains(ring))
    }
}

/// What `rings` tell her, as a moment of hers carries it.
pub(crate) fn rang(rings: &[SetRing]) -> Vec<Rang> {
    rings
        .iter()
        .map(|set| Rang {
            app: set.app_name.clone(),
            title: set.ring.title().to_owned(),
            body: set.ring.body().map(str::to_owned),
            at: set.ring.at().clone(),
        })
        .collect()
}

/// Her phone under one lease of `store`: `told` handed to their apps, when
/// there are any, then the rings set on it.
fn look(store: &dyn FileStoreBackend, told: &[SetRing]) -> Looked {
    let unread = |why: String| Looked {
        set: Vec::new(),
        let_go: told.is_empty(),
        failures: vec![sentence(&format!(
            "her phone could not be read, and nothing on it rings until her next turn ends: {why}"
        ))],
    };
    let phone = match Phone::bundled() {
        Ok(phone) => phone,
        Err(error) => return unread(error_chain(error)),
    };
    let mut files = match store.lease(Instant::now() + LEASE) {
        Ok(files) => files,
        Err(error) => return unread(error_chain(&error)),
    };
    let mut failures = Vec::new();
    let let_go = told.is_empty()
        || match phone.told(files.as_mut(), told, &Now::system()) {
            Ok(rang) => {
                failures.extend(
                    rang.iter()
                        .map(|failure| sentence(&format!("after it rang, {failure}"))),
                );
                true
            }
            Err(error) => {
                failures.push(sentence(&format!(
                    "what rang on her phone could not be put away, and rings again after her \
                     next turn: {}",
                    error_chain(&error)
                )));
                false
            }
        };
    let set = phone.rings(files.as_ref()).unwrap_or_else(|error| {
        failures.push(sentence(&format!(
            "her phone could not be read, and nothing on it rings until her next turn ends: {}",
            error_chain(&error)
        )));
        Vec::new()
    });

    Looked {
        set,
        let_go,
        failures,
    }
}

#[cfg(test)]
mod tests {
    use p02_shared::Identifier;
    use serde_json::json;

    use super::*;

    /// No client can make a machine sleep through a ring: her actor sleeps
    /// toward one half a minute at most before it reads the wall clock
    /// again, and a ring past due is due at once.
    #[test]
    fn her_actor_reads_the_wall_clock_again_within_half_a_minute() {
        let rings = Rings {
            set: vec![SetRing {
                app: Identifier::new("clock").unwrap(),
                app_name: "Clock".to_owned(),
                ring: serde_json::from_value(json!({
                    "id": "a1",
                    "at": "2026-11-12T07:00:00.000Z",
                    "title": "Alarm",
                }))
                .unwrap(),
            }],
            held: Vec::new(),
        };
        let waited = |now: &str| rings.wait(&Timestamp::new(now).unwrap());

        assert_eq!(waited("2026-11-11T23:00:00.000Z"), Some(LOOK_AGAIN));
        assert_eq!(
            waited("2026-11-12T06:59:55.500Z"),
            Some(Duration::from_millis(4_500))
        );
        assert_eq!(waited("2026-11-12T07:00:01.000Z"), Some(Duration::ZERO));
    }
}
