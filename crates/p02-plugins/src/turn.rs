use std::sync::Arc;

use p02_contracts::{TurnIdentity, TurnText};
use p02_core::EventIdentity;
use tokio_util::sync::CancellationToken;

/// What the runtime hands the host for one turn: who and when, what was
/// said if anything was, and the token that abandons it; or, for her end,
/// which serves no turn, an event of its own. Every hook's cancellation is
/// a child of that token.
#[derive(Clone, Debug)]
pub struct Turn {
    /// What every record of the hooks is stamped with.
    event: EventIdentity,
    identity: Option<Arc<TurnIdentity>>,
    text: Option<Arc<TurnText>>,
    cancellation: CancellationToken,
}

impl Turn {
    #[must_use]
    pub fn new(identity: TurnIdentity) -> Self {
        Self {
            event: identity.event.clone(),
            identity: Some(Arc::new(identity)),
            text: None,
            cancellation: CancellationToken::new(),
        }
    }

    /// Her end, which serves no turn and which nothing abandons.
    pub(crate) fn end() -> Self {
        Self {
            event: EventIdentity::mint(),
            identity: None,
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

    /// Cancelling it abandons the turn: the host stops waiting on its hooks
    /// and every hook's capabilities refuse their next call.
    #[must_use]
    pub fn cancellation(&self) -> &CancellationToken {
        &self.cancellation
    }

    pub(crate) fn event(&self) -> &EventIdentity {
        &self.event
    }

    pub(crate) fn shared_identity(&self) -> Option<Arc<TurnIdentity>> {
        self.identity.clone()
    }

    pub(crate) fn shared_text(&self) -> Option<Arc<TurnText>> {
        self.text.clone()
    }
}
