use p02_core::{CharacterProfile, EventIdentity, SessionId, VisibleText};
use p02_shared::Identifier;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::output::{PluginContextItem, PluginCuratedSection};
use crate::role_model::history::{HistoryWindow, ToolRound};
use crate::role_model::tools::{ModelToolCall, ModelToolDefinition, PluginToolDefinitions};
use crate::vocabulary::vocabulary;

/// The version of the decision contract every accepted decision carries.
pub const DECISION_CONTRACT_VERSION: &str = "mvp-006.tool_calls.v1";

const DECISION_OUTPUT_CONTRACT: &str = "Return exactly one complete valid JSON CharacterDecision object. The only top-level fields \
     are \"toolCalls\" (required, non-empty, in order) and optional \"text\". Do not include a \
     version field; the runtime stamps the internal decision version after validation. Do not \
     copy input envelope fields such as event, decisionContext, historyWindow, toolRounds, \
     pluginContextItems, characterSnapshot, allowedTools, toolDefinitions, responseContract, or \
     runtimeInput. Each toolCalls item must use string field \"name\", not \"tool\" or \"type\", \
     and object field \"input\". visible_reply is how you speak: each visible_reply commits as \
     its own message, in the order listed; any other tool call is executed and fed back as a tool \
     observation; a visible_reply alongside executable calls is interim output, and the turn ends \
     on a response whose calls are all visible_reply. A response must reply or call a tool. \
     \"text\" is your own note next to your calls: it is kept with the decision and shown to you \
     again, never to the person.";

/// What the model is told its answer must be: the decision contract, named
/// by its version, in the words the model was given.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutputContract {
    version: DecisionVersion,
    text: String,
}

impl OutputContract {
    /// The contract of a [`CharacterDecision`].
    #[must_use]
    pub fn decision() -> Self {
        Self {
            version: DecisionVersion,
            text: DECISION_OUTPUT_CONTRACT.to_owned(),
        }
    }

    /// The words the model was given.
    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }
}

/// What a model round decided: its calls, in order, and the note it wrote
/// beside them, which is shown to it again and never to the person.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "UncheckedDecision")]
pub struct CharacterDecision {
    version: DecisionVersion,
    tool_calls: Vec<ModelToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UncheckedDecision {
    version: DecisionVersion,
    tool_calls: Vec<ModelToolCall>,
    text: Option<String>,
}

/// The decision contract's version, which a record cannot name otherwise:
/// it is written in the one spelling and read back only from it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DecisionVersion;

impl Serialize for DecisionVersion {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(DECISION_CONTRACT_VERSION)
    }
}

impl<'de> Deserialize<'de> for DecisionVersion {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let version = String::deserialize(deserializer)?;

        if version == DECISION_CONTRACT_VERSION {
            Ok(Self)
        } else {
            Err(serde::de::Error::invalid_value(
                serde::de::Unexpected::Str(&version),
                &DECISION_CONTRACT_VERSION,
            ))
        }
    }
}

/// Why a recorded decision is not a [`CharacterDecision`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("a decision has at least one call, and no blank note beside them")]
pub struct ParseDecisionError;

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

impl TryFrom<UncheckedDecision> for CharacterDecision {
    type Error = ParseDecisionError;

    fn try_from(unchecked: UncheckedDecision) -> Result<Self, Self::Error> {
        let note_is_blank = unchecked
            .text
            .as_deref()
            .is_some_and(|text| text.trim().is_empty());

        if unchecked.tool_calls.is_empty() || note_is_blank {
            return Err(ParseDecisionError);
        }

        Ok(Self {
            version: unchecked.version,
            tool_calls: unchecked.tool_calls,
            text: unchecked.text,
        })
    }
}

vocabulary! {
    /// Who refused a round. The parser owns `malformed_output`, anything
    /// the decision contract does not allow; a provider adapter owns
    /// `provider_error`, when nothing usable arrived; the loop and the
    /// runtime own the other two, recorded against the commit while the
    /// parsed round stays what the model said.
    DecisionRejectionReason {
        MalformedOutput = "malformed_output",
        ProviderError = "provider_error",
        ToolRoundsExhausted = "tool_rounds_exhausted",
        CommitValidationFailure = "commit_validation_failure",
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

/// A trusted note for this turn: the runtime's own, or a plugin's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "UncheckedRuntimeNote")]
pub struct RuntimeNote {
    id: Identifier,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugin_id: Option<Identifier>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UncheckedRuntimeNote {
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

impl TryFrom<UncheckedRuntimeNote> for RuntimeNote {
    type Error = BlankContextTextError;

    fn try_from(unchecked: UncheckedRuntimeNote) -> Result<Self, Self::Error> {
        let note = Self::new(unchecked.id, unchecked.text)?;

        Ok(match unchecked.plugin_id {
            Some(plugin_id) => note.with_plugin(plugin_id),
            None => note,
        })
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
/// and the plugins contribute.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "UncheckedDecisionContext")]
pub struct DecisionContext {
    session_id: SessionId,
    character_snapshot: CharacterProfile,
    history_window: HistoryWindow,
    /// The condensed earlier conversation a continued session opens with.
    #[serde(skip_serializing_if = "Option::is_none")]
    context_summary: Option<String>,
    runtime_notes: Vec<RuntimeNote>,
    plugin_context_items: Vec<PluginContextItem>,
    curated_context_sections: Vec<PluginCuratedSection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UncheckedDecisionContext {
    session_id: SessionId,
    character_snapshot: CharacterProfile,
    history_window: HistoryWindow,
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

impl TryFrom<UncheckedDecisionContext> for DecisionContext {
    type Error = BlankContextTextError;

    fn try_from(unchecked: UncheckedDecisionContext) -> Result<Self, Self::Error> {
        let context = Self::new(unchecked.session_id, unchecked.character_snapshot)
            .with_history_window(unchecked.history_window)
            .with_runtime_notes(unchecked.runtime_notes)
            .with_plugin_context(
                unchecked.plugin_context_items,
                unchecked.curated_context_sections,
            );

        match unchecked.context_summary {
            Some(summary) => context.with_summary(summary),
            None => Ok(context),
        }
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
            SessionId::new("chat.1").unwrap(),
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
    fn a_record_naming_another_decision_contract_is_refused() {
        let mut envelope =
            serde_json::to_value(envelope(PluginToolDefinitions::default())).unwrap();
        let mut decision = json!({
            "version": DECISION_CONTRACT_VERSION,
            "toolCalls": [{"name": VISIBLE_REPLY, "input": {"text": "Hi."}}],
        });

        assert!(serde_json::from_value::<InputEnvelope>(envelope.clone()).is_ok());
        assert!(serde_json::from_value::<CharacterDecision>(decision.clone()).is_ok());

        envelope["outputContract"]["version"] = json!("mvp-005.tool_calls.v0");
        decision["version"] = json!("mvp-005.tool_calls.v0");

        assert!(serde_json::from_value::<InputEnvelope>(envelope).is_err());
        assert!(serde_json::from_value::<CharacterDecision>(decision).is_err());
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
