use p02_core::EventIdentity;
use p02_shared::{BoundJsonError, Identifier};
use serde::{Deserialize, Serialize};

use crate::label::RedactionLabel;
use crate::output::{SourceReference, SourceReferenceError, within_limits};
use crate::vocabulary::{EvidenceKind, EvidenceStatus, PolicyOutcome};

/// What a plugin says about a step it took. The host stamps it with the
/// turn, the plugin and the labels into [`Evidence`], so a plugin cannot
/// write a record about another turn or another plugin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvidenceNote {
    kind: EvidenceKind,
    status: EvidenceStatus,
    summary: String,
    policy_outcome: Option<PolicyOutcome>,
    source_references: Vec<SourceReference>,
}

impl EvidenceNote {
    #[must_use]
    pub fn new(kind: EvidenceKind, status: EvidenceStatus, summary: impl Into<String>) -> Self {
        Self {
            kind,
            status,
            summary: summary.into(),
            policy_outcome: None,
            source_references: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_policy_outcome(mut self, outcome: PolicyOutcome) -> Self {
        self.policy_outcome = Some(outcome);
        self
    }

    #[must_use]
    pub fn with_source(mut self, reference: SourceReference) -> Self {
        self.source_references.push(reference);
        self
    }

    #[must_use]
    pub fn kind(&self) -> EvidenceKind {
        self.kind
    }

    #[must_use]
    pub fn status(&self) -> EvidenceStatus {
        self.status
    }

    #[must_use]
    pub fn summary(&self) -> &str {
        &self.summary
    }

    #[must_use]
    pub fn policy_outcome(&self) -> Option<PolicyOutcome> {
        self.policy_outcome
    }

    /// Whether a tool result carrying this note cannot stand as accepted:
    /// the note itself says the call was refused or failed.
    #[must_use]
    pub fn blocks_tool_invocation(&self) -> bool {
        self.kind == EvidenceKind::ToolInvocation
            && (matches!(
                self.status,
                EvidenceStatus::Rejected | EvidenceStatus::Failed
            ) || matches!(
                self.policy_outcome,
                Some(
                    PolicyOutcome::HandlerRejected
                        | PolicyOutcome::RequiredRejected
                        | PolicyOutcome::DisallowedToolCall
                )
            ))
    }
}

/// One step a plugin, or the host on its behalf, took in a turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "UncheckedEvidence")]
pub struct Evidence {
    #[serde(flatten)]
    identity: EventIdentity,
    plugin_id: Identifier,
    #[serde(rename = "evidenceKind")]
    kind: EvidenceKind,
    status: EvidenceStatus,
    summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    policy_outcome: Option<PolicyOutcome>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    source_references: Vec<SourceReference>,
    redaction_labels: Vec<RedactionLabel>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UncheckedEvidence {
    #[serde(flatten)]
    identity: EventIdentity,
    plugin_id: Identifier,
    evidence_kind: EvidenceKind,
    status: EvidenceStatus,
    summary: String,
    policy_outcome: Option<PolicyOutcome>,
    #[serde(default)]
    source_references: Vec<SourceReference>,
    redaction_labels: Vec<RedactionLabel>,
}

/// Why a note cannot be kept as evidence.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum EvidenceError {
    #[error("plugin evidence is past the JSON limits")]
    TooLarge(#[source] BoundJsonError),
    #[error("a plugin evidence summary must not be blank")]
    BlankSummary,
    #[error("plugin evidence sources are refused")]
    Sources(#[source] SourceReferenceError),
}

impl Evidence {
    /// Stamps a note with the turn it belongs to, the plugin it is about
    /// and the labels it carries.
    ///
    /// # Errors
    ///
    /// [`EvidenceError`] when the summary is blank, a source is refused, or
    /// the record is past the JSON limits.
    pub fn new(
        identity: EventIdentity,
        plugin_id: Identifier,
        note: EvidenceNote,
        redaction_labels: Vec<RedactionLabel>,
    ) -> Result<Self, EvidenceError> {
        let evidence = Self {
            identity,
            plugin_id,
            kind: note.kind,
            status: note.status,
            summary: note.summary,
            policy_outcome: note.policy_outcome,
            source_references: note.source_references,
            redaction_labels,
        };

        within_limits(&evidence, "Plugin evidence snapshot").map_err(EvidenceError::TooLarge)?;

        if evidence.summary.trim().is_empty() {
            return Err(EvidenceError::BlankSummary);
        }

        SourceReference::check_all(&evidence.source_references).map_err(EvidenceError::Sources)?;
        Ok(evidence)
    }

    #[must_use]
    pub fn identity(&self) -> &EventIdentity {
        &self.identity
    }

    #[must_use]
    pub fn plugin_id(&self) -> &Identifier {
        &self.plugin_id
    }

    #[must_use]
    pub fn kind(&self) -> EvidenceKind {
        self.kind
    }

    #[must_use]
    pub fn status(&self) -> EvidenceStatus {
        self.status
    }

    #[must_use]
    pub fn summary(&self) -> &str {
        &self.summary
    }

    #[must_use]
    pub fn policy_outcome(&self) -> Option<PolicyOutcome> {
        self.policy_outcome
    }

    #[must_use]
    pub fn source_references(&self) -> &[SourceReference] {
        &self.source_references
    }

    #[must_use]
    pub fn redaction_labels(&self) -> &[RedactionLabel] {
        &self.redaction_labels
    }
}

impl TryFrom<UncheckedEvidence> for Evidence {
    type Error = EvidenceError;

    fn try_from(unchecked: UncheckedEvidence) -> Result<Self, Self::Error> {
        Self::new(
            unchecked.identity,
            unchecked.plugin_id,
            EvidenceNote {
                kind: unchecked.evidence_kind,
                status: unchecked.status,
                summary: unchecked.summary,
                policy_outcome: unchecked.policy_outcome,
                source_references: unchecked.source_references,
            },
            unchecked.redaction_labels,
        )
    }
}

#[cfg(test)]
mod tests {
    use p02_core::{EventId, Timestamp, TraceId};
    use serde_json::json;

    use super::*;
    use crate::vocabulary::SourceKind;

    #[test]
    fn stamped_evidence_reads_back_as_written() {
        let evidence = Evidence::new(
            EventIdentity::new(
                EventId::new("evt_1").unwrap(),
                TraceId::new("trace_1").unwrap(),
                Timestamp::new("2026-07-11T00:00:00.000Z").unwrap(),
            )
            .unwrap(),
            Identifier::new("memory.fixture").unwrap(),
            EvidenceNote::new(
                EvidenceKind::ToolInvocation,
                EvidenceStatus::Accepted,
                "Memory search completed.",
            )
            .with_source(SourceReference::new(SourceKind::Memory, "1f4e2d3c")),
            vec![RedactionLabel::new("memory").unwrap()],
        )
        .unwrap();
        let record = serde_json::to_value(&evidence).unwrap();

        assert_eq!(
            record,
            json!({
                "eventId": "evt_1",
                "traceId": "trace_1",
                "createdAt": "2026-07-11T00:00:00.000Z",
                "pluginId": "memory.fixture",
                "evidenceKind": "tool_invocation",
                "status": "accepted",
                "summary": "Memory search completed.",
                "sourceReferences": [{"kind": "memory", "id": "1f4e2d3c"}],
                "redactionLabels": ["memory"],
            })
        );
        assert_eq!(
            serde_json::from_value::<Evidence>(record).unwrap(),
            evidence
        );
    }

    #[test]
    fn a_tool_note_blocks_its_result_when_it_says_the_call_failed() {
        let tool = |status| EvidenceNote::new(EvidenceKind::ToolInvocation, status, "Done.");

        assert!(!tool(EvidenceStatus::Accepted).blocks_tool_invocation());
        assert!(!tool(EvidenceStatus::Degraded).blocks_tool_invocation());
        assert!(tool(EvidenceStatus::Rejected).blocks_tool_invocation());
        assert!(tool(EvidenceStatus::Failed).blocks_tool_invocation());
        assert!(
            tool(EvidenceStatus::Accepted)
                .with_policy_outcome(PolicyOutcome::DisallowedToolCall)
                .blocks_tool_invocation()
        );
        assert!(
            !EvidenceNote::new(EvidenceKind::Health, EvidenceStatus::Failed, "Down.")
                .blocks_tool_invocation()
        );
    }
}
