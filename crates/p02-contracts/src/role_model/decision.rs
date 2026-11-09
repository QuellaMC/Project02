use p02_core::{CharacterProfile, EventIdentity, SessionId, VisibleText};
use p02_shared::Identifier;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::output::{PluginContextItem, PluginCuratedSection};
use crate::role_model::history::{HistoryWindow, ToolRound};
use crate::role_model::tools::{ModelToolCall, ModelToolDefinition, PluginToolDefinitions};
use crate::vocabulary;

/// The version of the decision contract every accepted decision carries.
pub const DECISION_CONTRACT_VERSION: &str = "mvp-006.tool_calls.v1";

/// The contract a round's answer keeps, recorded by its version alone:
/// what the model was sent is its round's provider exchange.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutputContract {
    version: DecisionVersion,
}

impl OutputContract {
    /// The contract of a [`CharacterDecision`].
    #[must_use]
    pub fn decision() -> Self {
        Self {
            version: DecisionVersion,
        }
    }
}

/// What a model round decided: its calls, in order, and the note it wrote
/// beside them, which is shown to it again and never to the person. A
/// record of it reads back as it was written.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterDecision {
    version: DecisionVersion,
    tool_calls: Vec<ModelToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

/// The decision contract's version, written in its one spelling; a record
/// reads back whatever version it names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DecisionVersion;

impl Serialize for DecisionVersion {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(DECISION_CONTRACT_VERSION)
    }
}

impl<'de> Deserialize<'de> for DecisionVersion {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        serde::de::IgnoredAny::deserialize(deserializer).map(|_| Self)
    }
}

impl CharacterDecision {
    /// A decision of calls the parser judged, which are never none, and a
    /// note it kept only when it said something.
    pub(crate) fn judged(tool_calls: Vec<ModelToolCall>, text: Option<String>) -> Self {
        Self {
            version: DecisionVersion,
            tool_calls,
            text,
        }
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
    /// Who refused a round. The parser owns `malformed_output`, anything
    /// the decision contract does not allow; a provider adapter owns
    /// `provider_error`, when nothing usable arrived; the loop owns
    /// `tool_rounds_exhausted`, recorded against the commit while the
    /// parsed round stays what the model said.
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

/// The judgement of one model round.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DecisionResult {
    Accepted { decision: CharacterDecision },
    Rejected { rejection: DecisionRejection },
}

/// A trusted note for this turn: the runtime's own, or a plugin's. A
/// record of it reads back as it was written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeNote {
    id: Identifier,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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

/// What a model call is told besides the conversation: whose session and
/// character it is, which earlier turns it replays, and what the runtime
/// and the plugins contribute. A record of it reads back as it was written.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionContext {
    session_id: SessionId,
    character_snapshot: CharacterProfile,
    history_window: HistoryWindow,
    /// The condensed earlier conversation a continued session opens with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_summary: Option<String>,
    runtime_notes: Vec<RuntimeNote>,
    plugin_context_items: Vec<PluginContextItem>,
    curated_context_sections: Vec<PluginCuratedSection>,
}

impl DecisionContext {
    #[must_use]
    pub fn new(session_id: SessionId, character: CharacterProfile) -> Self {
        Self {
            session_id,
            character_snapshot: character,
            history_window: HistoryWindow::default(),
            context_summary: None,
            runtime_notes: Vec::new(),
            plugin_context_items: Vec::new(),
            curated_context_sections: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_history_window(mut self, window: HistoryWindow) -> Self {
        self.history_window = window;
        self
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
        self.curated_context_sections = sections;
        self
    }

    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    #[must_use]
    pub fn character(&self) -> &CharacterProfile {
        &self.character_snapshot
    }

    #[must_use]
    pub fn history_window(&self) -> &HistoryWindow {
        &self.history_window
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
        &self.curated_context_sections
    }
}

/// Everything one model call is given: the person's message and the event
/// it came in on, the decision context, the plugin tools, this turn's
/// finished tool rounds, and the contract the answer must keep.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputEnvelope {
    pub event: EventIdentity,
    pub user_message: VisibleText,
    pub decision_context: DecisionContext,
    pub plugin_tool_definitions: PluginToolDefinitions,
    pub tool_rounds: Vec<ToolRound>,
    pub output_contract: OutputContract,
}

impl InputEnvelope {
    /// An envelope for the first round of a turn, under the decision
    /// contract.
    #[must_use]
    pub fn new(
        event: EventIdentity,
        user_message: VisibleText,
        decision_context: DecisionContext,
        plugin_tool_definitions: PluginToolDefinitions,
    ) -> Self {
        Self {
            event,
            user_message,
            decision_context,
            plugin_tool_definitions,
            tool_rounds: Vec::new(),
            output_contract: OutputContract::decision(),
        }
    }

    /// The tools the model is offered: the built-in reply first, then
    /// every plugin tool.
    #[must_use]
    pub fn tool_definitions(&self) -> Vec<ModelToolDefinition> {
        std::iter::once(ModelToolDefinition::visible_reply())
            .chain(
                self.plugin_tool_definitions
                    .definitions()
                    .iter()
                    .map(|definition| ModelToolDefinition::from(&definition.tool)),
            )
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use p02_core::{EventId, SpeakerName, Timestamp, TraceId};
    use serde_json::json;

    use super::*;
    use crate::role_model::tools::{PluginToolDefinition, VISIBLE_REPLY};
    use crate::schema::ToolInputContract;
    use crate::tool::ProvidedTool;

    fn id(text: &str) -> Identifier {
        Identifier::new(text).unwrap()
    }

    fn context() -> DecisionContext {
        DecisionContext::new(
            SessionId::parse("chat.1").unwrap(),
            CharacterProfile {
                id: id("mira"),
                display_name: SpeakerName::new("Mira").unwrap(),
            },
        )
    }

    fn envelope(plugin_tools: PluginToolDefinitions) -> InputEnvelope {
        InputEnvelope::new(
            EventIdentity::new(
                EventId::new("evt_1").unwrap(),
                TraceId::new("trace_1").unwrap(),
                Timestamp::new("2026-06-15T00:00:00.000Z").unwrap(),
            )
            .unwrap(),
            VisibleText::normalize("hello").unwrap(),
            context(),
            plugin_tools,
        )
    }

    #[test]
    fn the_reply_is_offered_first_and_every_plugin_tool_after_it() {
        let tool = |name: &str| PluginToolDefinition {
            plugin_id: id("runtime.plugin"),
            tool: ProvidedTool::new(
                id(name),
                "A tool.",
                ToolInputContract::new(json!({"type": "object"})).unwrap(),
            )
            .unwrap(),
        };
        let envelope = envelope(
            PluginToolDefinitions::new(vec![
                tool("runtime.plugin.list"),
                tool("character_state.patch"),
            ])
            .unwrap(),
        );
        let names: Vec<String> = envelope
            .tool_definitions()
            .into_iter()
            .map(|definition| definition.name)
            .collect();

        assert_eq!(
            names,
            [
                VISIBLE_REPLY,
                "runtime.plugin.list",
                "character_state.patch"
            ]
        );

        let record = serde_json::to_value(&envelope).unwrap();

        assert_eq!(
            serde_json::from_value::<InputEnvelope>(record).unwrap(),
            envelope
        );
    }

    #[test]
    fn notes_and_summaries_say_something() {
        assert!(RuntimeNote::new(id("today"), "Today is Saturday, August 15, 2026.").is_ok());
        assert_eq!(
            RuntimeNote::new(id("today"), " "),
            Err(BlankContextTextError)
        );
        assert_eq!(
            context().with_summary("\n").unwrap_err(),
            BlankContextTextError
        );

        let note = RuntimeNote::new(id("current"), "mood=steady")
            .unwrap()
            .with_plugin(id("character-state"));

        assert_eq!(
            serde_json::to_value(&note).unwrap(),
            json!({"id": "current", "text": "mood=steady", "pluginId": "character-state"})
        );
    }
}
