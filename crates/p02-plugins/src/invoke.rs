//! One hook call under its plugin's budget.
//!
//! Each hook runs as a task of its own, so a hook that blocks its thread
//! holds that worker alone and the host keeps its deadline, and a hook
//! that panics fails through its plugin's policy instead of taking the
//! turn down. A hook of a turn already abandoned is never started. At the
//! deadline the hook's writes end and its token is cancelled, and the host
//! hears it for a second more, so a hook that stops at its token answers
//! with what it gave up; one silent past that is timed out. Whichever way
//! the host stops waiting (an answer, the turn being abandoned, or the
//! caller dropping the wait) the hook's writes end, and a hook that did not
//! answer has its task aborted and its token cancelled, so work it started
//! elsewhere starts nothing more.

use std::any::Any;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use p02_contracts::{Hook, HookContext, PluginError, StoreAccess, WriteHold};
use tokio::task::{AbortHandle, JoinError};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::host::Slot;
use crate::policy;
use crate::turn::Turn;

/// How long the host hears a hook past its deadline, its writes ended and
/// its token cancelled: time for a hook that stops at the token to say
/// what it gave up with, or what it could not finish, on a machine with
/// its mind elsewhere. A hook silent past it timed out.
const LAST_WORD: Duration = Duration::from_secs(1);

/// What the host runs under a plugin's budget: one of its hooks, or the
/// preparation of an approval-gated call, which is part of `handleToolCall`
/// and changes nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Invocation {
    Hook(Hook),
    Preparation,
}

impl Invocation {
    /// The hook the host's records name it by.
    fn hook(self) -> Hook {
        match self {
            Self::Hook(hook) => hook,
            Self::Preparation => Hook::HandleToolCall,
        }
    }
}

impl From<Hook> for Invocation {
    fn from(hook: Hook) -> Self {
        Self::Hook(hook)
    }
}

/// Why a hook gave the host no answer it could use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailureKind {
    /// The hook failed, or what it answered broke the contract.
    Exception,
    /// The deadline passed first.
    Timeout,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HookFailure {
    pub(crate) kind: FailureKind,
    pub(crate) message: String,
}

impl HookFailure {
    pub(crate) fn breach(message: String) -> Self {
        Self {
            kind: FailureKind::Exception,
            message,
        }
    }
}

impl Slot {
    /// Runs `call` under the manifest's `timeoutMs`, its context granting
    /// what the invocation may reach.
    pub(crate) async fn invoke<T, F, Fut>(
        &self,
        invocation: impl Into<Invocation>,
        turn: &Turn,
        call: F,
    ) -> Result<T, HookFailure>
    where
        F: FnOnce(HookContext) -> Fut,
        Fut: Future<Output = Result<T, PluginError>> + Send + 'static,
        T: Send + 'static,
    {
        let invocation = invocation.into();
        let hook = invocation.hook();
        let policy = self.manifest.runtime_policy();
        let failure = |kind, message| HookFailure { kind, message };
        let abandoned = || {
            failure(
                FailureKind::Exception,
                format!(
                    "Plugin \"{}\" {} was stopped: its turn was abandoned.",
                    self.manifest.id(),
                    hook.name()
                ),
            )
        };
        let timed_out = || {
            failure(
                FailureKind::Timeout,
                format!(
                    "Plugin \"{}\" {} timed out after {}ms.",
                    self.manifest.id(),
                    hook.name(),
                    policy.timeout_ms()
                ),
            )
        };

        if turn.cancellation().is_cancelled() {
            return Err(abandoned());
        }

        let deadline = Instant::now() + policy.timeout();
        let cancellation = turn.cancellation().child_token();
        let unanswered = cancellation.clone().drop_guard();
        let (context, writes) = self.context(turn, invocation, deadline, cancellation.clone());
        let mut task = tokio::spawn(call(context));
        let _abort = AbortOnDrop(task.abort_handle());

        let in_time = tokio::select! {
            in_time = tokio::time::timeout_at(deadline, &mut task) => in_time,
            () = turn.cancellation().cancelled() => return Err(abandoned()),
        };
        let settled = match in_time {
            Ok(settled) => settled,
            Err(_elapsed) => {
                drop(writes);
                cancellation.cancel();

                tokio::select! {
                    last_word = tokio::time::timeout(LAST_WORD, &mut task) => match last_word {
                        Ok(settled) => settled,
                        Err(_elapsed) => return Err(timed_out()),
                    },
                    () = turn.cancellation().cancelled() => return Err(abandoned()),
                }
            }
        };

        match settled {
            Ok(answer) => {
                unanswered.disarm();
                answer.map_err(|error| failure(FailureKind::Exception, said(error.to_string())))
            }
            Err(stopped) => Err(failure(FailureKind::Exception, stopped_message(stopped))),
        }
    }

    /// The call's view of its turn, with what the plugin is granted and the
    /// invocation may use. The store's hold stays with the host.
    fn context(
        &self,
        turn: &Turn,
        invocation: Invocation,
        deadline: Instant,
        cancellation: CancellationToken,
    ) -> (HookContext, Option<WriteHold>) {
        let capabilities = &self.capabilities;
        let only_reads = policy::access::only_reads(invocation);
        let mut context = HookContext::new(
            self.manifest.id().clone(),
            turn.shared_identity(),
            deadline,
            cancellation,
        )
        .with_privacy_labels(Arc::clone(turn.privacy_labels()));

        if capabilities.turn_text
            && let Some(text) = turn.shared_text()
        {
            context = context.with_turn_text(text);
        }

        if let Some(feed) = &capabilities.session_history {
            context = context.with_session_history(Arc::clone(feed));
        }

        if let Some(opener) = &capabilities.databases
            && !only_reads
        {
            context = context.with_plugin_database(Arc::clone(opener));
        }

        match &capabilities.file_store {
            Some((backend, granted)) => {
                let access = if only_reads {
                    StoreAccess::ReadOnly
                } else {
                    *granted
                };
                let (context, hold) =
                    context.with_character_file_store(Arc::clone(backend), access);

                (context, Some(hold))
            }
            None => (context, None),
        }
    }
}

/// What a plugin's error says, or that it failed when it says nothing.
fn said(message: String) -> String {
    if message.trim().is_empty() {
        "Plugin hook failed.".to_owned()
    } else {
        message
    }
}

/// Aborts a hook's task once the host stops waiting for it; a task that
/// has ended is left as it is.
struct AbortOnDrop(AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn stopped_message(stopped: JoinError) -> String {
    match stopped.try_into_panic() {
        Ok(payload) => match panic_text(payload.as_ref()) {
            Some(text) => format!("Plugin hook panicked: {text}"),
            None => "Plugin hook panicked.".to_owned(),
        },
        Err(_) => "Plugin hook was cancelled.".to_owned(),
    }
}

fn panic_text(payload: &(dyn Any + Send)) -> Option<&str> {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
}
