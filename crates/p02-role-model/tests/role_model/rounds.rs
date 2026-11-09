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
    ProviderAnswer, ProviderFailure, ReplyDelta, RoleModelAdapter, ToolCallResult, WrittenCall,
};
use p02_core::{MessageId, SessionId, SpeakerName, VisibleMessage, VisibleMessageRole};
use p02_role_model::{
    DraftEvent, ModelRound, Person, Reply, RoutedToolCall, TurnInput, TurnOutcome, TurnSink,
    run_turn,
};
use serde_json::{Value, json};

use crate::support::{context, event, id, mira, plugin_tool, turn};

/// A round the scripted model plays: what it drafts, then what it answers.
struct Script {
    drafts: Vec<&'static str>,
    answer: ProviderAnswer,
}

/// The model writes `calls`, each a name and an input, and `text` beside
/// them.
fn answer(calls: &[Value], text: Option<&str>) -> Script {
    Script {
        drafts: Vec::new(),
        answer: ProviderAnswer::Answered {
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
        },
    }
}

fn drafting(drafts: Vec<&'static str>, script: Script) -> Script {
    Script { drafts, ..script }
}

fn say(text: &str) -> Script {
    answer(&[reply(text)], None)
}

fn reply(text: &str) -> Value {
    json!({"name": "visible_reply", "input": {"text": text}})
}

/// An answer with neither a call nor a word in it.
fn nothing() -> Script {
    answer(&[], None)
}

fn search(query: &str) -> Value {
    json!({"name": "memory.search", "input": {"query": query}})
}

/// A model that plays its scripts in turn, then the last one forever, and
/// keeps the messages each round was given.
#[derive(Debug, Default)]
struct Scripted {
    scripts: Mutex<VecDeque<(Vec<&'static str>, ProviderAnswer)>>,
    seen: Mutex<Vec<Vec<ChatMessage>>>,
}

impl Scripted {
    fn new(scripts: Vec<Script>) -> Self {
        Self {
            scripts: Mutex::new(
                scripts
                    .into_iter()
                    .map(|script| (script.drafts, script.answer))
                    .collect(),
            ),
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

        let (drafts, answer) = {
            let mut scripts = self.scripts.lock().unwrap();

            if scripts.len() > 1 {
                scripts.pop_front().unwrap()
            } else {
                scripts.front().cloned().unwrap()
            }
        };

        for text in drafts {
            invocation.hear(ReplyDelta {
                reply: 0,
                text: text.to_owned(),
            });
        }

        answer
    }
}

/// A turn that keeps a line for everything the loop asks of it, in order.
#[derive(Debug, Default)]
struct Recording {
    log: Mutex<Vec<String>>,
    rounds: Mutex<Vec<ModelRound>>,
    routed: Mutex<Vec<RoutedToolCall>>,
    commit_failure: Option<&'static str>,
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
        if let Some(failure) = self.commit_failure {
            return Err(failure);
        }

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

                call.finish(ToolCallResult::Accepted { output }).unwrap()
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

async fn run(
    model: &Scripted,
    sink: &Recording,
    persona: &Persona,
    history: &[ConversationTurn],
) -> Result<TurnOutcome, &'static str> {
    run_turn(
        model,
        sink,
        TurnInput {
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
            person: Person::Unnamed,
        },
    )
    .await
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
async fn a_refused_round_goes_back_to_the_model_in_its_next_round_alone() {
    let model = Scripted::new(vec![
        nothing(),
        answer(&[search("tea")], None),
        say("There."),
    ]);
    let sink = Recording::default();
    let outcome = run(&model, &sink, &mira(), &[]).await.unwrap();
    let notes: Vec<Vec<String>> = model
        .seen()
        .iter()
        .map(|messages| {
            messages
                .iter()
                .filter_map(|message| match message {
                    ChatMessage::System { content } if content.starts_with("Your last reply") => {
                        Some(content.clone())
                    }
                    _ => None,
                })
                .collect()
        })
        .collect();

    assert!(matches!(outcome, TurnOutcome::Replied { round: at, .. } if at == round(3)));
    assert_eq!(
        notes,
        [
            Vec::new(),
            vec![
                "Your last reply could not be used. The runtime said: \"Reply with \
                 visible_reply or call a tool.\""
                    .to_owned()
            ],
            Vec::new(),
        ]
    );
    assert_eq!(
        model.seen()[1].last(),
        Some(&ChatMessage::System {
            content: notes[1][0].clone()
        })
    );
    assert_eq!(
        sink.rounds
            .lock()
            .unwrap()
            .iter()
            .map(|recorded| status(&recorded.result))
            .collect::<Vec<_>>(),
        ["rejected", "accepted", "accepted"]
    );
}

#[tokio::test]
async fn the_rounds_run_out_and_a_provider_that_gave_nothing_ends_the_turn_at_once() {
    let persona = mira();
    let stubborn = Scripted::new(vec![nothing()]);
    let sink = Recording::default();
    // Ninety-nine rounds may be spent; the hundredth is the last.
    let last = round(100);

    assert!(matches!(
        run(&stubborn, &sink, &persona, &[]).await.unwrap(),
        TurnOutcome::Refused {
            round: at,
            rejection: DecisionRejection {
                reason: DecisionRejectionReason::MalformedOutput,
                ..
            },
        } if at == last
    ));
    assert_eq!(
        (sink.rounds.lock().unwrap().len(), stubborn.seen().len()),
        (100, 100)
    );

    let failing = Scripted::new(vec![Script {
        drafts: vec!["Half"],
        answer: ProviderAnswer::Failed(ProviderFailure {
            code: "http_error".to_owned(),
            message: "upstream 503".to_owned(),
            status: Some(503),
        }),
    }]);
    let sink = Recording::default();
    let refused = DecisionRejection {
        reason: DecisionRejectionReason::ProviderError,
        details: Some("upstream 503".to_owned()),
    };

    assert_eq!(
        run(&failing, &sink, &persona, &[]).await,
        Ok(TurnOutcome::Refused {
            round: round(1),
            rejection: refused.clone(),
        })
    );
    assert_eq!(sink.log(), ["delta 1.0 Half", "round 1", "withdrawn 1.0"]);
    assert_eq!(
        sink.rounds.lock().unwrap()[0].result,
        DecisionResult::Rejected { rejection: refused }
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

#[tokio::test]
async fn a_draft_is_named_by_its_commit_and_withdrawn_when_nothing_says_it() {
    let persona = mira();
    let model = Scripted::new(vec![
        drafting(vec!["oops"], nothing()),
        drafting(vec!["unnamed"], answer(&[search("tea")], None)),
        drafting(vec!["Hel", "lo."], say("Hello.")),
    ]);
    let sink = Recording::default();

    run(&model, &sink, &persona, &[]).await.unwrap();

    assert_eq!(
        sink.log(),
        [
            "delta 1.0 oops",
            "round 1",
            "withdrawn 1.0",
            "delta 2.0 unnamed",
            "round 2",
            "withdrawn 2.0",
            "tools 2 memory.search",
            "delta 3.0 Hel",
            "delta 3.0 lo.",
            "round 3",
            "reply 3.0 Hello.",
        ]
    );

    let model = Scripted::new(vec![drafting(vec!["Hello."], say("Hello."))]);
    let sink = Recording {
        commit_failure: Some("the disk is full"),
        ..Recording::default()
    };

    assert_eq!(
        run(&model, &sink, &persona, &[]).await,
        Err("the disk is full")
    );
    assert_eq!(sink.log(), ["delta 1.0 Hello.", "round 1", "withdrawn 1.0"]);
}
