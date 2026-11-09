//! Capture behind the turn: each committed turn is queued for its backend
//! to extract while the turn's answer goes out, one capture at a time and
//! each within its bound. A capture has no retry, so why the last one did
//! not complete is kept until one does.

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
    /// Why the last capture to settle did not complete, until one does.
    failure: Mutex<Option<String>>,
}

#[derive(Debug)]
struct Worker {
    jobs: mpsc::UnboundedSender<Job>,
    task: JoinHandle<()>,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            pending: watch::Sender::new(0),
            failure: Mutex::default(),
        }
    }
}

impl Captures {
    /// Queues `job` behind the captures before it.
    pub(super) fn queue(&self, job: Job) {
        self.shared.pending.send_modify(|pending| *pending += 1);

        let mut worker = self.worker.lock().unwrap_or_else(PoisonError::into_inner);

        drop(worker.get_or_insert_with(|| self.start()).jobs.send(job));
    }

    /// Notes a capture that did not complete, and why.
    pub(super) fn lose(&self, why: String) {
        self.shared.settle(Some(why));
    }

    /// Why the last capture to settle did not complete, until one does.
    pub(super) fn failure(&self) -> Option<String> {
        self.shared
            .failure
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Waits until every queued capture is done or `stop` is cancelled,
    /// then abandons what is left, whose outcome nobody will learn; answers
    /// why the last capture did not complete, if it did not.
    pub(super) async fn drain(&self, stop: &CancellationToken) -> Option<String> {
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

            if self.shared.pending.send_replace(0) > 0 {
                self.lose(abandoned());
            }
        }

        self.failure()
    }

    fn start(&self) -> Worker {
        let (jobs, mut queued) = mpsc::unbounded_channel::<Job>();
        let shared = Arc::clone(&self.shared);
        let task = tokio::spawn(async move {
            while let Some(job) = queued.recv().await {
                // A capture that panics is lost like one that failed, so
                // the worker, and the captures queued behind it, go on.
                let failure =
                    match tokio::time::timeout(BOUND, AssertUnwindSafe(job).catch_unwind()).await {
                        Ok(Ok(Ok(_))) => None,
                        Ok(Ok(Err(error))) => Some(error.to_string()),
                        Ok(Err(_)) => {
                            Some("mem0 add panicked; whether it completed is unknown.".to_owned())
                        }
                        Err(_) => Some(abandoned()),
                    };

                shared.settle(failure);
                shared
                    .pending
                    .send_modify(|pending| *pending = pending.saturating_sub(1));
            }
        });

        Worker { jobs, task }
    }
}

impl Shared {
    fn settle(&self, failure: Option<String>) {
        *self.failure.lock().unwrap_or_else(PoisonError::into_inner) = failure;
    }
}

fn abandoned() -> String {
    BackendError::new(Operation::Add, Failure::Abandoned).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_capture_that_panics_is_lost_and_the_captures_behind_it_go_on() {
        let captures = Captures::default();
        let stop = CancellationToken::new();
        let panicking = || -> Job { Box::pin(async { panic!("a capture's own fault") }) };

        captures.queue(panicking());
        captures.queue(Box::pin(async {
            Ok(Written::Stored(vec!["mem-1".to_owned()]))
        }));
        assert_eq!(captures.drain(&stop).await, None);

        captures.queue(panicking());
        assert_eq!(
            captures.drain(&stop).await.as_deref(),
            Some("mem0 add panicked; whether it completed is unknown.")
        );
    }
}
