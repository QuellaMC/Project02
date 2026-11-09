//! A turn's rounds against a scripted model and a turn that records what
//! the loop asks of it.

use std::collections::VecDeque;
use std::num::{NonZeroU32, NonZeroU64};
use std::sync::Mutex;

use async_trait::async_trait;
use p02_characters::Persona;
use p02_contracts::{
    ChatMessage, ConversationToolCall, ConversationTurn, DecisionRejection,
    DecisionRejectionReason, DecisionResult, Invocation, ModelOutput, PluginToolDefinitions,
    ProviderAnswer, RoleModelAdapter, ToolCallResult, WrittenCall,
};
use p02_core::{MessageId, SessionId, SpeakerName, VisibleMessage, VisibleMessageRole};
use p02_role_model::{
    DraftEvent, ModelRound, Reply, Rounds, RoutedToolCall, TurnInput, TurnOutcome, TurnSink,
};
use serde_json::{Value, json};

use crate::support::{context, event, id, mira, plugin_tool, turn};

/// The model writes `calls`, each a name and an input, and `text` beside
/// them.
fn answer(calls: &[Value], text: Option<&str>) -> ProviderAnswer {
    ProviderAnswer::Answered {
        output: ModelOutput {
            tool_calls: calls
                .iter()
                .map(|call| WrittenCall {
                    name: call["name"].as_str().unwrap().to_owned(),
                    input: call["input"].clone(),
                })
                .collect(),
            text: text.map(str::to_owned),
        },
        finish_reason: None,
        usage: None,
    }
}

fn say(text: &str) -> ProviderAnswer {
    answer(&[reply(text)], None)
}

fn reply(text: &str) -> Value {
    json!({"name": "visible_reply", "input": {"text": text}})
}

fn search(query: &str) -> Value {
    json!({"name": "memory.search", "input": {"query": query}})
}

/// A model that plays its answers in turn, then the last one forever, and
/// keeps the messages each round was given.
#[derive(Debug, Default)]
struct Scripted {
    answers: Mutex<VecDeque<ProviderAnswer>>,
    seen: Mutex<Vec<Vec<ChatMessage>>>,
}

impl Scripted {
    fn new(answers: Vec<ProviderAnswer>) -> Self {
        Self {
            answers: Mutex::new(answers.into()),
            seen: Mutex::default(),
        }
    }

    fn seen(&self) -> Vec<Vec<ChatMessage>> {
        self.seen.lock().unwrap().clone()
    }
}

#[async_trait]
impl RoleModelAdapter for Scripted {
    async fn invoke(&self, invocation: &Invocation<'_>) -> ProviderAnswer {
        self.seen
            .lock()
            .unwrap()
            .push(invocation.messages().to_vec());

        let mut answers = self.answers.lock().unwrap();

        if answers.len() > 1 {
            answers.pop_front().unwrap()
        } else {
            answers.front().cloned().unwrap()
        }
    }
}

/// A turn that keeps a line for everything the loop asks of it, in order.
#[derive(Debug, Default)]
struct Recording {
    log: Mutex<Vec<String>>,
    rounds: Mutex<Vec<ModelRound>>,
    routed: Mutex<Vec<RoutedToolCall>>,
}

impl Recording {
    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    fn note(&self, line: String) {
        self.log.lock().unwrap().push(line);
    }
}

#[async_trait]
impl TurnSink for Recording {
    type Error = &'static str;

    async fn record_round(&self, round: &ModelRound) -> Result<(), Self::Error> {
        self.note(format!("round {}", round.round));
        self.rounds.lock().unwrap().push(round.clone());
        Ok(())
    }

    async fn commit_reply(&self, reply: Reply<'_>) -> Result<VisibleMessage, Self::Error> {
        self.note(format!("reply {} {}", reply.draft, reply.text));

        let number = u64::try_from(self.log.lock().unwrap().len()).unwrap();

        Ok(VisibleMessage {
            id: MessageId::new(
                SessionId::parse("conv_mira.1").unwrap(),
                NonZeroU64::new(number).unwrap(),
            ),
            role: VisibleMessageRole::Character,
            speaker_id: id("mira"),
            speaker_name: SpeakerName::new("Mira").unwrap(),
            text: reply.text.clone(),
        })
    }

    async fn run_tool_calls(
        &self,
        round: NonZeroU32,
        calls: Vec<RoutedToolCall>,
    ) -> Result<Vec<ConversationToolCall>, Self::Error> {
        let names: Vec<String> = calls
            .iter()
            .map(|call| call.tool_name().to_string())
            .collect();

        self.note(format!("tools {round} {}", names.join(" ")));
        self.routed.lock().unwrap().extend(calls.iter().cloned());

        Ok(calls
            .into_iter()
            .map(|call| {
                let output = json!({"found": call.tool_name().to_string()});

                call.finish(ToolCallResult::Accepted { output })
            })
            .collect())
    }

    fn draft(&self, event: DraftEvent) {
        self.note(match event {
            DraftEvent::Delta { draft, text } => format!("delta {draft} {text}"),
            DraftEvent::Withdrawn { draft } => format!("withdrawn {draft}"),
        });
    }
}

/// The turn's rounds, one after another, to their end.
async fn run(
    model: &Scripted,
    sink: &Recording,
    persona: &Persona,
    history: &[ConversationTurn],
) -> Result<TurnOutcome, &'static str> {
    let mut rounds = Rounds::new(TurnInput {
        event: event(),
        user_message: p02_core::UserLine::new("Hello?").unwrap().into(),
        context: context(),
        plugin_tools: PluginToolDefinitions::new(vec![plugin_tool(
            "memory.fixture",
            "memory.search",
        )])
        .unwrap(),
        history,
        persona,
    });

    loop {
        if let Some(outcome) = rounds.run(model, sink).await? {
            return Ok(outcome);
        }
    }
}

fn round(number: u32) -> NonZeroU32 {
    NonZeroU32::new(number).unwrap()
}

fn status(result: &DecisionResult) -> &'static str {
    match result {
        DecisionResult::Accepted { .. } => "accepted",
        DecisionResult::Rejected { .. } => "rejected",
    }
}

#[tokio::test]
async fn every_round_is_recorded_before_anything_it_decided_happens() {
    let history = [turn(1, "Earlier.", "Earlier reply.")];
    let model = Scripted::new(vec![
        answer(&[reply("Looking."), search("tea")], None),
        say("Found it."),
    ]);
    let sink = Recording::default();
    let outcome = run(&model, &sink, &mira(), &history).await.unwrap();

    assert!(matches!(outcome, TurnOutcome::Replied { round: at, .. } if at == round(2)));
    assert_eq!(
        sink.log(),
        [
            "round 1",
            "reply 1.0 Looking.",
            "tools 1 memory.search",
            "round 2",
            "reply 2.0 Found it.",
        ]
    );
}

#[tokio::test]
async fn a_call_past_the_last_round_is_never_made_and_its_round_stays_what_the_model_said() {
    let model = Scripted::new(vec![answer(&[search("again")], None)]);
    let sink = Recording::default();
    let outcome = run(&model, &sink, &mira(), &[]).await.unwrap();
    let ran = sink
        .log()
        .iter()
        .filter(|line| line.starts_with("tools"))
        .count();

    assert_eq!(
        outcome,
        TurnOutcome::Refused {
            round: round(100),
            rejection: DecisionRejection {
                reason: DecisionRejectionReason::ToolRoundsExhausted,
                details: Some(
                    "Role model exceeded maximum executable tool rounds (99).".to_owned()
                ),
            },
        }
    );
    assert_eq!(ran, 99);
    assert_eq!(
        status(&sink.rounds.lock().unwrap().last().unwrap().result),
        "accepted"
    );
}

#[tokio::test]
async fn this_turn_s_round_is_replayed_under_the_runtime_s_ids_and_its_note_is_never_said() {
    let model = Scripted::new(vec![
        answer(
            &[
                json!({"name": "memory.search", "input": {"query": "Mira", "api_key": "secret"}}),
                json!({"name": "memory.forget", "input": {}}),
            ],
            Some("Searching."),
        ),
        say("Done."),
    ]);
    let sink = Recording::default();

    run(&model, &sink, &mira(), &[]).await.unwrap();

    let routed = sink.routed.lock().unwrap().clone();
    let replayed = &model.seen()[1];
    let tail = serde_json::to_value(&replayed[replayed.len() - 3..]).unwrap();

    assert_eq!(
        routed
            .iter()
            .map(|call| (call.call_id().as_str(), call.plugin_id().as_str()))
            .collect::<Vec<_>>(),
        [
            (
                "evt_turn.trace_turn.round-1.1.memory.search",
                "memory.fixture"
            ),
            (
                "evt_turn.trace_turn.round-1.2.memory.forget",
                "undeclared.memory.forget"
            ),
        ]
    );
    // The tool runs on what the model sent; the replay keeps no credential.
    assert_eq!(routed[0].input()["api_key"], json!("secret"));
    assert_eq!(
        tail,
        json!([
            {
                "role": "assistant",
                "content": "Searching.",
                "tool_calls": [
                    {
                        "id": "evt_turn.trace_turn.round-1.1.memory.search",
                        "type": "function",
                        "function": {
                            "name": "memory.search",
                            "arguments": "{\"query\":\"Mira\",\"api_key\":\"[redacted]\"}",
                        },
                    },
                    {
                        "id": "evt_turn.trace_turn.round-1.2.memory.forget",
                        "type": "function",
                        "function": {"name": "memory.forget", "arguments": "{}"},
                    },
                ],
            },
            {
                "role": "tool",
                "content": "{\"status\":\"accepted\",\"pluginId\":\"memory.fixture\",\"toolName\":\"memory.search\",\"output\":{\"found\":\"memory.search\"}}",
                "tool_call_id": "evt_turn.trace_turn.round-1.1.memory.search",
            },
            {
                "role": "tool",
                "content": "{\"status\":\"accepted\",\"pluginId\":\"undeclared.memory.forget\",\"toolName\":\"memory.forget\",\"output\":{\"found\":\"memory.forget\"}}",
                "tool_call_id": "evt_turn.trace_turn.round-1.2.memory.forget",
            },
        ])
    );
    assert_eq!(
        sink.log(),
        [
            "round 1",
            "tools 1 memory.search memory.forget",
            "round 2",
            "reply 2.0 Done."
        ]
    );
}
