//! The output boundary: what a plugin returns becomes records only once it
//! keeps to the record limits and the JSON limits, stamped with its turn,
//! its plugin and their labels. A breach is the plugin's failure, routed
//! through its failure policy; nothing a plugin returns is cut to fit.

use std::error::Error;

use p02_contracts::{
    Evidence, EvidenceKind, EvidenceNote, EvidenceStatus, Hook, PolicyOutcome, RedactionLabel,
    merged_labels, within_limits,
};
use serde::Serialize;

use crate::host::Slot;
use crate::text::excerpt;
use crate::turn::Turn;

/// The most records of one kind one answer may carry.
pub(crate) const RECORD_LIMIT: usize = 64;

/// How much of a plugin's own text a host record repeats: enough to say
/// what failed, and within the JSON limits whatever the plugin said.
const QUOTED_CHARS: usize = 4_096;

impl Slot {
    pub(crate) fn labels(&self, turn: &Turn) -> Vec<RedactionLabel> {
        merged_labels(
            turn.privacy_labels(),
            self.manifest.runtime_policy().redaction_labels(),
        )
    }

    /// The plugin's notes as records of this turn.
    pub(crate) fn stamp_all(
        &self,
        turn: &Turn,
        notes: Vec<EvidenceNote>,
    ) -> Result<Vec<Evidence>, String> {
        if notes.len() > RECORD_LIMIT {
            return Err(format!("evidence exceeds the {RECORD_LIMIT}-record limit."));
        }

        notes
            .into_iter()
            .map(|note| {
                Evidence::new(
                    turn.identity().event.clone(),
                    self.manifest.id().clone(),
                    note,
                    self.labels(turn),
                )
                .map_err(|error| described(&error))
            })
            .collect()
    }

    /// A record the host writes about the plugin.
    pub(crate) fn record(
        &self,
        turn: &Turn,
        kind: EvidenceKind,
        status: EvidenceStatus,
        summary: &str,
        outcome: Option<PolicyOutcome>,
    ) -> Evidence {
        let note = EvidenceNote::new(kind, status, excerpt(summary, QUOTED_CHARS));
        let note = match outcome {
            Some(outcome) => note.with_policy_outcome(outcome),
            None => note,
        };

        Evidence::new(
            turn.identity().event.clone(),
            self.manifest.id().clone(),
            note,
            self.labels(turn),
        )
        .expect("a host record says something, within the limits once its quote is cut")
    }
}

/// Whether one answer of a hook, all of its records together, keeps to
/// the JSON limits.
pub(crate) fn within_answer_limits(answer: &impl Serialize, hook: Hook) -> Result<(), String> {
    within_limits(answer, &format!("Plugin {} result", hook.name()))
        .map_err(|error| described(&error))
}

/// A refusal of the contracts with its causes, which name a place in the
/// plugin's answer and never a path on disk.
pub(crate) fn described(error: &dyn Error) -> String {
    let mut text = error.to_string();
    let mut cause = error.source();

    while let Some(error) = cause {
        text.push_str(": ");
        text.push_str(&error.to_string());
        cause = error.source();
    }

    text
}
