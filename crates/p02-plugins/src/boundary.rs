//! The output boundary: what a plugin returns becomes records only once it
//! keeps to the record limits and the JSON limits, stamped with its turn,
//! its plugin and their labels. A breach is the plugin's failure, routed
//! through its failure policy; nothing a plugin returns is cut to fit.

use std::borrow::Cow;

use p02_contracts::{
    Evidence, EvidenceKind, EvidenceNote, EvidenceStatus, Hook, PolicyOutcome, RedactionLabel,
    merged_labels, within_limits,
};
use p02_shared::error_chain;
use serde::Serialize;

use crate::host::Slot;
use crate::text::excerpt;
use crate::turn::Turn;

/// The most records of one kind a plugin's answer may carry; the host's
/// own record of the answer, cut to fit, comes on top.
pub(crate) const RECORD_LIMIT: usize = 64;

/// How much of a plugin's own text a host record repeats: enough to say
/// what failed, and within the JSON limits whatever the plugin said.
const QUOTED_CHARS: usize = 4_096;

/// What the host repeats of a plugin's own text, in a record and in the
/// refusal or rejection it reports.
pub(crate) fn quoted(text: &str) -> Cow<'_, str> {
    excerpt(text, QUOTED_CHARS)
}

/// How many labels a turn, or a plugin's manifest, brings to each record,
/// and how long each may be: more than any record needs, and few enough
/// that the labels of both, beside the longest summary the host writes,
/// keep the record within the JSON limits.
const LABEL_LIMIT: usize = 16;
const LABEL_BYTES: usize = 128;

/// Why labels cannot ride a record.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error(
    "a turn or a plugin brings at most {LABEL_LIMIT} labels to each record, each of at most \
     {LABEL_BYTES} bytes"
)]
pub struct RecordLabelsError;

/// Holds labels, where they enter the host, to what a record has room for.
pub(crate) fn within_label_allowance(labels: &[RedactionLabel]) -> Result<(), RecordLabelsError> {
    if labels.len() <= LABEL_LIMIT
        && labels
            .iter()
            .all(|label| label.as_str().len() <= LABEL_BYTES)
    {
        Ok(())
    } else {
        Err(RecordLabelsError)
    }
}

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
                .map_err(|error| error_chain(&error))
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
        let note = EvidenceNote::new(kind, status, quoted(summary));
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
        .expect(
            "a host record says something, within the limits once its quote is cut and its \
             labels were held where they entered",
        )
    }
}

/// Whether one answer of a hook, all of its records together, keeps to
/// the JSON limits.
pub(crate) fn within_answer_limits(answer: &impl Serialize, hook: Hook) -> Result<(), String> {
    within_limits(answer, &format!("Plugin {} result", hook.name()))
        .map_err(|error| error_chain(&error))
}
