//! One hook call under its plugin's budget.
//!
//! Each hook runs as a task of its own, so a hook that blocks its thread
//! holds that worker alone and the host keeps its deadline, and a hook
//! that panics fails through its plugin's policy instead of taking the
//! turn down. Whichever
//! way the host stops waiting (an answer, the deadline, the turn being
//! abandoned, or the caller dropping the wait) the hook's writes end, and
//! unless it answered in time its task is aborted and its token cancelled,
//! so work it started elsewhere starts nothing more.

use std::any::Any;
use std::future::Future;
use std::sync::Arc;

use p02_contracts::{Hook, HookContext, PluginError, WriteHold};
use tokio::task::{AbortHandle, JoinError};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::host::Slot;
use crate::policy;
use crate::turn::Turn;

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
        let deadline = Instant::now() + policy.timeout();
        let cancellation = turn.cancellation().child_token();
        let unanswered = cancellation.clone().drop_guard();
        let (context, _writes) = self.context(turn, invocation, deadline, cancellation);
        let mut task = tokio::spawn(call(context));
        let _abort = AbortOnDrop(task.abort_handle());
        let failure = |kind, message| HookFailure { kind, message };
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

        let settled = tokio::select! {
            settled = tokio::time::timeout_at(deadline, &mut task) => settled,
            () = turn.cancellation().cancelled() => {
                return Err(failure(
                    FailureKind::Exception,
                    format!(
                        "Plugin \"{}\" {} was stopped: its turn was abandoned.",
                        self.manifest.id(),
                        hook.name()
                    ),
                ));
            }
        };

        match settled {
            Err(_elapsed) => Err(timed_out()),
            Ok(_late) if Instant::now() >= deadline => Err(timed_out()),
            Ok(Ok(answer)) => {
                unanswered.disarm();
                answer.map_err(|error| failure(FailureKind::Exception, said(error.to_string())))
            }
            Ok(Err(stopped)) => Err(failure(FailureKind::Exception, stopped_message(stopped))),
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

        if let Some(opener) = &capabilities.databases {
            context = context.with_plugin_database(Arc::clone(opener));
        }

        match &capabilities.file_store {
            Some((backend, access)) => {
                let (context, hold) = context.with_character_file_store(
                    Arc::clone(backend),
                    policy::access::store_access(*access, invocation),
                );

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
