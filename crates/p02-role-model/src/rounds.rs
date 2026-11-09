//! A turn's model rounds: one after another until the model replies or the
//! rounds run out, each made with what the character runs on when it
//! starts. Every round is judged once and handed to the turn as soon as it
//! is judged, before anything it decided happens.

mod drafts;

use std::num::NonZeroU32;

use async_trait::async_trait;
use p02_characters::Persona;
use p02_contracts::{
    CharacterDecision, ConversationToolCall, ConversationTurn, DecisionContext, DecisionRejection,
    DecisionRejectionReason, DecisionResult, Invocation, ModelToolCall, PluginToolDefinitions,
    ProviderAnswer, ReplyDelta, RoleModelAdapter, ToolCallId, ToolCallResult, ToolRound,
};
use p02_core::{EventIdentity, VisibleMessage, VisibleText};
use p02_shared::Identifier;
use serde_json::{Map, Value};

use crate::prompt::{InputEnvelope, render, unusable_reply_note};
use drafts::Drafts;
pub use drafts::{DraftEvent, DraftId};

/// How many rounds of tool calls one turn may spend, a refused round
/// counted like any other. The round after the last is the model's to
/// reply in; a call there is never made.
const MAX_TOOL_ROUNDS: u32 = 99;

/// What a turn's rounds are given.
#[derive(Debug)]
pub struct TurnInput<'a> {
    pub event: EventIdentity,
    pub user_message: VisibleText,
    /// What the runtime and the plugins prepared for the model's first
    /// round.
    pub context: DecisionContext,
    pub plugin_tools: PluginToolDefinitions,
    /// The earlier turns to replay, oldest first.
    pub history: &'a [ConversationTurn],
    pub persona: &'a Persona,
}

/// A model round to record before anything it decided happens: what its
/// provider answered and the verdict on it, a call's input as the model
/// sent it, credentials and all.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelRound {
    pub round: NonZeroU32,
    pub answer: ProviderAnswer,
    pub result: DecisionResult,
}

/// A reply the model said, for the turn to commit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reply<'a> {
    pub text: &'a VisibleText,
    /// The draft the reply replaces, whether or not anything of it was
    /// spoken, which names the round it was said in.
    pub draft: DraftId,
}

/// A call a round made, routed to the plugin that offers its tool.
#[derive(Clone, Debug, PartialEq)]
pub struct RoutedToolCall {
    call_id: ToolCallId,
    plugin_id: Identifier,
    tool_name: Identifier,
    input: Map<String, Value>,
}

impl RoutedToolCall {
    /// The runtime's id for the call, `<event>.<trace>.round-<n>.<k>.<tool>`
    /// with the call counted from one among its round's tool calls: the id
    /// the call is recorded, answered and replayed under, never the
    /// provider's.
    #[must_use]
    pub fn call_id(&self) -> &ToolCallId {
        &self.call_id
    }

    /// The plugin that offers the tool, or `undeclared.<tool>` for a tool
    /// the turn never offered.
    #[must_use]
    pub fn plugin_id(&self) -> &Identifier {
        &self.plugin_id
    }

    #[must_use]
    pub fn tool_name(&self) -> &Identifier {
        &self.tool_name
    }

    /// The input as the model sent it, credentials and all: the tool runs
    /// on it.
    #[must_use]
    pub fn input(&self) -> &Map<String, Value> {
        &self.input
    }

    /// The call finished with `result`, as the model is shown it again.
    #[must_use]
    pub fn finish(self, result: ToolCallResult) -> ConversationToolCall {
        ConversationToolCall::new(
            self.call_id,
            self.plugin_id,
            self.tool_name,
            self.input,
            result,
        )
    }
}

/// What a turn does with what its rounds decide: the runtime's side of the
/// loop, over the session log, the plugin host and the turn's stream.
#[async_trait]
pub trait TurnSink: Send + Sync {
    type Error: Send;

    /// Records a round, which comes before anything it decided.
    async fn record_round(&self, round: &ModelRound) -> Result<(), Self::Error>;

    /// Commits a reply, and returns it as the person was shown it.
    async fn commit_reply(&self, reply: Reply<'_>) -> Result<VisibleMessage, Self::Error>;

    /// Runs one round's calls through the plugin host, which decides which
    /// may overlap, and returns each finished call in the order the model
    /// made them. A call that never finished has no place in what the
    /// model is shown again.
    async fn run_tool_calls(
        &self,
        round: NonZeroU32,
        calls: Vec<RoutedToolCall>,
    ) -> Result<Vec<ConversationToolCall>, Self::Error>;

    /// Hears a draft, which is never awaited: the model writes on
    /// meanwhile.
    fn draft(&self, event: DraftEvent);
}

/// How a turn's rounds ended.
#[derive(Clone, Debug, PartialEq)]
pub enum TurnOutcome {
    /// The model replied, and the replies were committed.
    Replied {
        round: NonZeroU32,
        decision: CharacterDecision,
    },
    /// The turn ended without a reply: the provider gave nothing usable, a
    /// last round could not be used, or the rounds ran out.
    Refused {
        round: NonZeroU32,
        rejection: DecisionRejection,
    },
}

/// A turn's rounds, run one at a time by its caller, who makes each round's
/// request with the model the character runs on as it starts, and between
/// two rounds may prepare again what the model is shown and offered. A
/// round whose output is refused goes back to the model as part of its
/// next round, counted like any other; a provider that gave nothing usable
/// ends the turn. The only refusal of the rounds' own is their budget,
/// recorded against the commit while the round stays what the model said.
#[derive(Debug)]
pub struct Rounds<'a> {
    envelope: InputEnvelope,
    history: &'a [ConversationTurn],
    persona: &'a Persona,
    /// What the runtime could not use of the last reply, which the next
    /// round alone carries.
    refusal_note: Option<String>,
    /// Rounds spent against [`MAX_TOOL_ROUNDS`].
    spent: u32,
    /// The round to run next.
    next: NonZeroU32,
}

impl<'a> Rounds<'a> {
    #[must_use]
    pub fn new(input: TurnInput<'a>) -> Self {
        Self {
            envelope: InputEnvelope::new(
                input.event,
                input.user_message,
                input.context,
                input.plugin_tools,
            ),
            history: input.history,
            persona: input.persona,
            refusal_note: None,
            spent: 0,
            next: NonZeroU32::MIN,
        }
    }

    /// What the model is shown and offered from the next round on: what
    /// the runtime and the plugins prepared again.
    pub fn prepared(&mut self, context: DecisionContext, tools: PluginToolDefinitions) {
        self.envelope.decision_context = context;
        self.envelope.plugin_tool_definitions = tools;
    }

    /// Runs the next round, its request made with `adapter`: how the turn
    /// ended, once a round ends it, and none while another round follows.
    ///
    /// # Errors
    ///
    /// The sink's error, as soon as one of its calls fails: what the round
    /// had drafted and not committed is withdrawn first.
    pub async fn run<S: TurnSink>(
        &mut self,
        adapter: &dyn RoleModelAdapter,
        sink: &S,
    ) -> Result<Option<TurnOutcome>, S::Error> {
        // Every draft a round opens ends with it, whichever way it ends.
        let drafts = Drafts::new(self.next, sink);
        let ended = self.round(adapter, sink, &drafts).await;

        drafts.close();
        self.next = self.next.saturating_add(1);
        ended
    }

    async fn round<S: TurnSink>(
        &mut self,
        adapter: &dyn RoleModelAdapter,
        sink: &S,
        drafts: &Drafts<'_, S>,
    ) -> Result<Option<TurnOutcome>, S::Error> {
        let round = drafts.round();
        let note = self.refusal_note.take();
        let prompt = render(&self.envelope, self.history, self.persona, note.as_deref());
        let listener = |delta: ReplyDelta| drafts.speak(delta);
        let invocation = Invocation::new(prompt.messages(), prompt.tools())
            .with_history(self.history)
            .with_reply_listener(&listener);
        let answer = adapter.invoke(&invocation).await;
        let result = DecisionResult::judge(&answer);
        let recorded = ModelRound {
            round,
            answer,
            result,
        };

        sink.record_round(&recorded).await?;

        let decision = match recorded.result {
            DecisionResult::Accepted { decision } => decision,
            DecisionResult::Rejected { rejection }
                if rejection.reason == DecisionRejectionReason::MalformedOutput
                    && self.spent < MAX_TOOL_ROUNDS =>
            {
                let details = rejection
                    .details
                    .as_deref()
                    .unwrap_or(rejection.reason.as_str());

                self.refusal_note = Some(unusable_reply_note(details));
                self.spent += 1;
                return Ok(None);
            }
            DecisionResult::Rejected { rejection } => {
                return Ok(Some(TurnOutcome::Refused { round, rejection }));
            }
        };
        let calls: Vec<(&Identifier, &Map<String, Value>)> = decision
            .tool_calls()
            .iter()
            .filter_map(|call| match call {
                ModelToolCall::Plugin { name, input } => Some((name, input)),
                ModelToolCall::VisibleReply { .. } => None,
            })
            .collect();

        if calls.is_empty() {
            commit_replies(sink, drafts, &decision).await?;
            return Ok(Some(TurnOutcome::Replied { round, decision }));
        }

        if self.spent >= MAX_TOOL_ROUNDS {
            return Ok(Some(TurnOutcome::Refused {
                round,
                rejection: DecisionRejection {
                    reason: DecisionRejectionReason::ToolRoundsExhausted,
                    details: Some(format!(
                        "Role model exceeded maximum executable tool rounds ({MAX_TOOL_ROUNDS})."
                    )),
                },
            }));
        }

        let interim_replies = commit_replies(sink, drafts, &decision).await?;
        let routed = calls
            .into_iter()
            .enumerate()
            .map(|(at, (name, input))| self.route(round, at + 1, name, input))
            .collect();
        let tool_calls = sink.run_tool_calls(round, routed).await?;

        self.spent += 1;
        self.envelope.tool_rounds.push(ToolRound {
            round,
            text: decision.text().map(str::to_owned),
            interim_replies,
            tool_calls,
        });
        Ok(None)
    }

    fn route(
        &self,
        round: NonZeroU32,
        position: usize,
        name: &Identifier,
        input: &Map<String, Value>,
    ) -> RoutedToolCall {
        let event = &self.envelope.event;
        let call_id = ToolCallId::new(&format!(
            "{}.{}.round-{round}.{position}.{name}",
            event.event_id(),
            event.trace_id()
        ))
        .expect("a call id spelled from the event is never empty");
        let plugin_id = self
            .envelope
            .plugin_tool_definitions
            .get(name.as_str())
            .map_or_else(
                || undeclared(name),
                |definition| definition.plugin_id.clone(),
            );

        RoutedToolCall {
            call_id,
            plugin_id,
            tool_name: name.clone(),
            input: input.clone(),
        }
    }
}

/// Who answers a tool the turn never offered: nobody, by a name that says
/// so. A tool name too long to carry the prefix is undeclared all the same.
fn undeclared(tool: &Identifier) -> Identifier {
    Identifier::new(&format!("undeclared.{tool}"))
        .unwrap_or_else(|_| Identifier::new("undeclared").expect("undeclared is an identifier"))
}

/// Commits the round's replies in order, each naming its draft, then
/// withdraws what the round drafted and did not say, before anything else
/// the round decided goes on.
async fn commit_replies<S: TurnSink>(
    sink: &S,
    drafts: &Drafts<'_, S>,
    decision: &CharacterDecision,
) -> Result<Vec<VisibleMessage>, S::Error> {
    let texts = decision.tool_calls().iter().filter_map(|call| match call {
        ModelToolCall::VisibleReply { text } => Some(text),
        ModelToolCall::Plugin { .. } => None,
    });
    let mut committed = Vec::new();

    for (reply, text) in texts.enumerate() {
        committed.push(
            sink.commit_reply(Reply {
                text,
                draft: drafts.id(reply),
            })
            .await?,
        );
        drafts.settle(reply);
    }

    drafts.close();
    Ok(committed)
}
