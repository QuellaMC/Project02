use p02_core::{CharacterProfile, SpeakerName};
use p02_shared::Identifier;
use serde::{Deserialize, Serialize};

use crate::output::{PluginContextItem, PluginCuratedSection};
use crate::role_model::tools::ModelToolCall;
use crate::vocabulary;

/// What a model round decided: its calls, in order, and the note it wrote
/// beside them, which is shown to it again and never to the person. A
/// record of it reads back as it was written.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterDecision {
    tool_calls: Vec<ModelToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

impl CharacterDecision {
    /// A decision of calls the judge read, which are never none, and a note
    /// it kept only when it said something.
    pub(crate) fn judged(tool_calls: Vec<ModelToolCall>, text: Option<String>) -> Self {
        Self { tool_calls, text }
    }

    #[must_use]
    pub fn tool_calls(&self) -> &[ModelToolCall] {
        &self.tool_calls
    }

    #[must_use]
    pub fn text(&self) -> Option<&str> {
        self.text.as_deref()
    }
}

vocabulary! {
    /// Why a round was refused: `malformed_output`, what the model wrote
    /// that the runtime cannot act on; `provider_error`, when nothing
    /// usable arrived; and `tool_rounds_exhausted`, the loop's own,
    /// recorded against the commit while the round's verdict stays what
    /// the judge said.
    DecisionRejectionReason {
        MalformedOutput = "malformed_output",
        ProviderError = "provider_error",
        ToolRoundsExhausted = "tool_rounds_exhausted",
    }
}

/// A refused round, and in `details` what the model is told about it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionRejection {
    pub reason: DecisionRejectionReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

/// The verdict on one model round.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DecisionResult {
    Accepted { decision: CharacterDecision },
    Rejected { rejection: DecisionRejection },
}

impl DecisionResult {
    /// The verdict as a record keeps it: every credential-named value in a
    /// call's input redacted.
    #[must_use]
    pub fn redacted(&self) -> Self {
        match self {
            Self::Accepted { decision } => Self::Accepted {
                decision: CharacterDecision {
                    tool_calls: decision
                        .tool_calls
                        .iter()
                        .map(ModelToolCall::redacted)
                        .collect(),
                    text: decision.text.clone(),
                },
            },
            Self::Rejected { .. } => self.clone(),
        }
    }
}

/// A trusted note for this turn: the runtime's own, or a plugin's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeNote {
    id: Identifier,
    text: String,
    plugin_id: Option<Identifier>,
}

/// Why a text cannot be a note or a summary of the decision context.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("a runtime note's text and a context summary must not be blank")]
pub struct BlankContextTextError;

impl RuntimeNote {
    /// A note the runtime writes itself.
    ///
    /// # Errors
    ///
    /// [`BlankContextTextError`] when `text` is blank.
    pub fn new(id: Identifier, text: impl Into<String>) -> Result<Self, BlankContextTextError> {
        Ok(Self {
            id,
            text: non_blank(text.into())?,
            plugin_id: None,
        })
    }

    /// The note as a plugin's.
    #[must_use]
    pub fn with_plugin(mut self, plugin_id: Identifier) -> Self {
        self.plugin_id = Some(plugin_id);
        self
    }

    #[must_use]
    pub fn id(&self) -> &Identifier {
        &self.id
    }

    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }

    #[must_use]
    pub fn plugin_id(&self) -> Option<&Identifier> {
        self.plugin_id.as_ref()
    }
}

fn non_blank(text: String) -> Result<String, BlankContextTextError> {
    if text.trim().is_empty() {
        Err(BlankContextTextError)
    } else {
        Ok(text)
    }
}

/// What a model call is told besides the conversation: who the character
/// is, the name the person goes by, and what the runtime and the plugins
/// contribute.
#[derive(Clone, Debug, PartialEq)]
pub struct DecisionContext {
    character: CharacterProfile,
    person: SpeakerName,
    /// The condensed earlier conversation a continued session opens with.
    context_summary: Option<String>,
    runtime_notes: Vec<RuntimeNote>,
    plugin_context_items: Vec<PluginContextItem>,
    curated_sections: Vec<PluginCuratedSection>,
}

impl DecisionContext {
    #[must_use]
    pub fn new(character: CharacterProfile, person: SpeakerName) -> Self {
        Self {
            character,
            person,
            context_summary: None,
            runtime_notes: Vec::new(),
            plugin_context_items: Vec::new(),
            curated_sections: Vec::new(),
        }
    }

    /// # Errors
    ///
    /// [`BlankContextTextError`] when `summary` is blank.
    pub fn with_summary(
        mut self,
        summary: impl Into<String>,
    ) -> Result<Self, BlankContextTextError> {
        self.context_summary = Some(non_blank(summary.into())?);
        Ok(self)
    }

    #[must_use]
    pub fn with_runtime_notes(mut self, notes: Vec<RuntimeNote>) -> Self {
        self.runtime_notes = notes;
        self
    }

    #[must_use]
    pub fn with_plugin_context(
        mut self,
        items: Vec<PluginContextItem>,
        sections: Vec<PluginCuratedSection>,
    ) -> Self {
        self.plugin_context_items = items;
        self.curated_sections = sections;
        self
    }

    #[must_use]
    pub fn character(&self) -> &CharacterProfile {
        &self.character
    }

    #[must_use]
    pub fn person(&self) -> &SpeakerName {
        &self.person
    }

    #[must_use]
    pub fn context_summary(&self) -> Option<&str> {
        self.context_summary.as_deref()
    }

    #[must_use]
    pub fn runtime_notes(&self) -> &[RuntimeNote] {
        &self.runtime_notes
    }

    #[must_use]
    pub fn plugin_context_items(&self) -> &[PluginContextItem] {
        &self.plugin_context_items
    }

    #[must_use]
    pub fn curated_sections(&self) -> &[PluginCuratedSection] {
        &self.curated_sections
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(text: &str) -> Identifier {
        Identifier::new(text).unwrap()
    }

    #[test]
    fn notes_and_summaries_say_something() {
        let context = DecisionContext::new(
            CharacterProfile {
                id: id("mira"),
                display_name: SpeakerName::new("Mira").unwrap(),
            },
            SpeakerName::new("Sam").unwrap(),
        );

        assert!(RuntimeNote::new(id("today"), "Today is Saturday, August 15, 2026.").is_ok());
        assert_eq!(
            RuntimeNote::new(id("today"), " "),
            Err(BlankContextTextError)
        );
        assert_eq!(
            context.with_summary("\n").unwrap_err(),
            BlankContextTextError
        );
    }
}
