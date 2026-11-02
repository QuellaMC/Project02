//! Capture behind the turn: each committed turn is queued for its backend
//! to extract while the turn's answer goes out, one capture at a time and
//! each within its bound. What did not complete is counted for the
//! plugin's life, since a capture has no retry and no later success brings
//! the lost turn back.

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futures_util::FutureExt as _;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::backend::{BackendError, Failure, Operation, Written};

/// How many turns may wait on extraction at once: deep enough to ride out
/// a slow local model, shallow enough that a session cannot grow a queue
/// it will never finish.
const BACKLOG: usize = 8;

/// How long one capture may take. A local model can take tens of seconds
/// to extract; past a minute the request is stuck, and settling it is what
/// lets the queue move on.
const BOUND: Duration = Duration::from_secs(60);

/// One capture's work: the backend's write of a turn.
pub(super) type Job = Pin<Box<dyn Future<Output = Result<Written, BackendError>> + Send>>;

#[derive(Debug, Default)]
pub(super) struct Captures {
    shared: Arc<Shared>,
    worker: Mutex<Option<Worker>>,
}

#[derive(Debug)]
struct Shared {
    /// Captures queued or running.
    pending: watch::Sender<usize>,
    record: Mutex<Record>,
}

/// What the captures that settled came to.
#[derive(Clone, Debug, Default)]
struct Record {
    incomplete: u64,
    loss: Option<String>,
    last: Option<String>,
}

/// What the captures came to so far.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Outcomes {
    pub(super) pending: usize,
    pub(super) incomplete: u64,
    /// The most recent loss, said with the count of every loss.
    pub(super) loss: Option<String>,
    /// What the last capture that completed came to.
    pub(super) last: Option<String>,
}

#[derive(Debug)]
struct Worker {
    jobs: mpsc::UnboundedSender<Job>,
    task: JoinHandle<()>,
}

/// Whether a turn was queued.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Queued {
    Accepted { earlier_losses: u64 },
    Refused,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            pending: watch::Sender::new(0),
            record: Mutex::default(),
        }
    }
}

impl Captures {
    /// Queues `job` behind the captures before it, or refuses it, as a
    /// loss, when the backlog is full.
    pub(super) fn queue(&self, job: Job) -> Queued {
        let accepted = self.shared.pending.send_if_modified(|pending| {
            let room = *pending < BACKLOG;

            if room {
                *pending += 1;
            }

            room
        });

        if !accepted {
            self.lose(&format!(
                "extraction backlog is full ({BACKLOG} queued), so the turn was never sent."
            ));
            return Queued::Refused;
        }

        let mut worker = self.worker.lock().unwrap_or_else(PoisonError::into_inner);

        drop(worker.get_or_insert_with(|| self.start()).jobs.send(job));
        drop(worker);

        Queued::Accepted {
            earlier_losses: self.outcomes().incomplete,
        }
    }

    /// Counts a capture that did not complete, and why.
    pub(super) fn lose(&self, why: &str) {
        self.shared.lose(1, why);
    }

    pub(super) fn outcomes(&self) -> Outcomes {
        let pending = *self.shared.pending.borrow();
        let Record {
            incomplete,
            loss,
            last,
        } = self
            .shared
            .record
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();

        Outcomes {
            pending,
            incomplete,
            loss,
            last,
        }
    }

    /// Waits until every queued capture is done or `stop` is cancelled;
    /// then abandons what is left, whose outcome nobody will learn.
    pub(super) async fn drain(&self, stop: &CancellationToken) -> Outcomes {
        let mut pending = self.shared.pending.subscribe();
        let drained = tokio::select! {
            biased;
            drained = pending.wait_for(|&left| left == 0) => drained.is_ok(),
            () = stop.cancelled() => false,
        };

        if !drained {
            let worker = self
                .worker
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();

            if let Some(worker) = worker {
                worker.task.abort();
                drop(worker.task.await);
            }

            let left = self.shared.pending.send_replace(0);

            if left > 0 {
                self.shared.lose(
                    u64::try_from(left).unwrap_or(u64::MAX),
                    &BackendError::new(Operation::Add, Failure::Abandoned).to_string(),
                );
            }
        }

        self.outcomes()
    }

    fn start(&self) -> Worker {
        let (jobs, mut queued) = mpsc::unbounded_channel::<Job>();
        let shared = Arc::clone(&self.shared);
        let task = tokio::spawn(async move {
            while let Some(job) = queued.recv().await {
                // A capture that panics is lost like one that failed, so
                // the worker, and the captures queued behind it, go on.
                match tokio::time::timeout(BOUND, AssertUnwindSafe(job).catch_unwind()).await {
                    Ok(Ok(Ok(written))) => shared.completed(&written),
                    Ok(Ok(Err(error))) => shared.lose(1, &error.to_string()),
                    Ok(Err(_)) => {
                        shared.lose(1, "mem0 add panicked; whether it completed is unknown.");
                    }
                    Err(_) => shared.lose(
                        1,
                        &BackendError::new(Operation::Add, Failure::Abandoned).to_string(),
                    ),
                }

                shared
                    .pending
                    .send_modify(|pending| *pending = pending.saturating_sub(1));
            }
        });

        Worker { jobs, task }
    }
}

impl Shared {
    fn lose(&self, count: u64, why: &str) {
        let mut record = self.record.lock().unwrap_or_else(PoisonError::into_inner);

        record.incomplete = record.incomplete.saturating_add(count);
        record.loss = Some(format!(
            "{} capture(s) did not complete; most recent: {why}",
            record.incomplete
        ));
    }

    fn completed(&self, written: &Written) {
        let last = match written {
            Written::Stored(stored) if stored.is_empty() => {
                "No memory extracted from the last captured turn.".to_owned()
            }
            Written::Stored(stored) => format!(
                "Stored {} memory item(s) from the last captured turn.",
                stored.len()
            ),
            Written::Queued(_) => "Queued the last captured turn with the backend.".to_owned(),
        };

        self.record
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .last = Some(last);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_capture_that_panics_is_lost_and_the_captures_behind_it_go_on() {
        let captures = Captures::default();

        captures.queue(Box::pin(async { panic!("a capture's own fault") }));
        captures.queue(Box::pin(async {
            Ok(Written::Stored(vec!["mem-1".to_owned()]))
        }));

        assert_eq!(
            captures.drain(&CancellationToken::new()).await,
            Outcomes {
                pending: 0,
                incomplete: 1,
                loss: Some(
                    "1 capture(s) did not complete; most recent: mem0 add panicked; whether it \
                     completed is unknown."
                        .to_owned()
                ),
                last: Some("Stored 1 memory item(s) from the last captured turn.".to_owned()),
            }
        );
    }
}
