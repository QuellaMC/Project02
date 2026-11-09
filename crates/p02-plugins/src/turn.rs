use std::sync::Arc;

use p02_contracts::{TurnIdentity, TurnText};
use tokio_util::sync::CancellationToken;

/// What the runtime hands the host for one turn, or for the event that
/// ends the character: who and when, what was said if anything was, and
/// the token that abandons it. Every hook's cancellation is a child of that
/// token.
#[derive(Clone, Debug)]
pub struct Turn {
    identity: Arc<TurnIdentity>,
    text: Option<Arc<TurnText>>,
    cancellation: CancellationToken,
}

impl Turn {
    #[must_use]
    pub fn new(identity: TurnIdentity) -> Self {
        Self {
            identity: Arc::new(identity),
            text: None,
            cancellation: CancellationToken::new(),
        }
    }

    /// What was said, shown to the plugins granted `turn_context: read`.
    #[must_use]
    pub fn with_text(mut self, text: TurnText) -> Self {
        self.text = Some(Arc::new(text));
        self
    }

    #[must_use]
    pub fn identity(&self) -> &TurnIdentity {
        &self.identity
    }

    /// Cancelling it abandons the turn: the host stops waiting on its hooks
    /// and every hook's capabilities refuse their next call.
    #[must_use]
    pub fn cancellation(&self) -> &CancellationToken {
        &self.cancellation
    }

    pub(crate) fn shared_identity(&self) -> Arc<TurnIdentity> {
        Arc::clone(&self.identity)
    }

    pub(crate) fn shared_text(&self) -> Option<Arc<TurnText>> {
        self.text.clone()
    }
}
