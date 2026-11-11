//! What the tests build a daemon from: a canonical temporary home, the
//! bundled Mira, a model whose rounds are scripted, a plugin built behind
//! a gate that holds a step in flight, and an ear on the events.

use std::collections::VecDeque;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Condvar, Mutex};
use std::task::Poll;
use std::time::Duration;

use async_trait::async_trait;
use p02_app::{Daemon, DaemonSettings, Durations, Message, Plugin};
use p02_contracts::{
    HookContext, HookReport, HookStatus, Invocation, Manifest, ModelOutput, PluginError,
    ProviderAnswer, RoleModelAdapter, RuntimePlugin, WrittenCall,
};
use p02_core::ClientStamp;
use p02_plugins::list;
use p02_shared::{DanglingLinks, canonical_path};
use p02_store::Home;
use p02_wire::{CharacterState, Event, OpenOutcome, TurnProgress};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::{Notify, mpsc};

/// How long a test waits for what it expects before it fails.
const PATIENCE: Duration = Duration::from_secs(120);

/// Lets every task that can run, run, the blocking pool's work included:
/// a paused clock moves only once nothing else can, so this never returns
/// while a gate holds a blocking job.
pub(crate) async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

/// Gives what was sent its chance to be answered, on a clock that runs.
pub(crate) async fn a_while() {
    tokio::time::sleep(Duration::from_millis(200)).await;
}

/// Runs `future` until it first waits, so that what it does before that is
/// done, and hands it back to finish.
pub(crate) async fn begun<F: Future>(future: F) -> Pin<Box<F>> {
    let mut future = Box::pin(future);

    std::future::poll_fn(|context| {
        assert!(future.as_mut().poll(context).is_pending(), "it waits");
        Poll::Ready(())
    })
    .await;
    future
}

/// A home of the test's own, spelled canonically as the daemon spells its
/// home; the directory goes with it.
pub(crate) struct World {
    _directory: TempDir,
    pub(crate) home: Home,
    /// The gate a plugin every character runs is built behind, so a test
    /// that shuts it holds her assembly in flight.
    pub(crate) assembly: Arc<Gate>,
    pub(crate) model: Arc<Model>,
}

impl World {
    pub(crate) fn new() -> Self {
        let directory = TempDir::new().unwrap();
        let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());

        Self {
            _directory: directory,
            home,
            assembly: Arc::default(),
            model: Arc::default(),
        }
    }

    pub(crate) fn path(&self, relative: &str) -> PathBuf {
        relative
            .split('/')
            .fold(self.home.root().to_path_buf(), |path, name| path.join(name))
    }

    /// Writes Mira's own settings as `document` says them.
    pub(crate) fn her_settings(&self, document: Value) {
        let Value::Object(mut fields) = document else {
            panic!("settings are an object");
        };
        let folder = self.path("character-data/mira");

        fields.insert("version".to_owned(), json!("project02.config.v2"));
        create_directories(&folder);
        write(
            &folder.join("config.json"),
            &serde_json::to_string_pretty(&Value::Object(fields)).unwrap(),
        );
    }

    /// Puts a package of character `id` named `name`, who expects no plugin,
    /// in the home's packages: every such package has one persona.
    pub(crate) fn package(&self, id: &str, name: &str) {
        let folder = self.path(&format!("characters/{id}"));

        create_directories(&folder);
        write(
            &folder.join("project02.character.json"),
            &json!({
                "format": "project02.character.v1",
                "identity": {"id": id, "displayName": name},
                "persona": {"system": ["You are a character of a test."]},
                "meta": {"version": "1.0.0"},
            })
            .to_string(),
        );
    }

    /// A daemon on this home whose characters answer through the scripted
    /// model, with the plugins of the daemon's list and the one built behind
    /// the assembly gate.
    pub(crate) async fn daemon(&self) -> Daemon {
        let listed = list::plugins()
            .unwrap()
            .iter()
            .map(|(manifest, check, factory)| Plugin::new(manifest.clone(), *check, *factory));
        let gated = Toy::built_behind("assembly", &self.assembly).plugin();

        Daemon::open(
            self.home.clone(),
            DaemonSettings {
                test_provider: Some(Arc::clone(&self.model) as Arc<dyn RoleModelAdapter>),
                durations: Durations::default(),
                plugins: listed.chain([gated]).collect(),
            },
        )
        .await
        .unwrap()
    }
}

#[expect(
    clippy::disallowed_methods,
    reason = "a test writes a home's files as a person would"
)]
pub(crate) fn write(path: &Path, content: &str) {
    std::fs::write(path, content).unwrap();
}

#[expect(
    clippy::disallowed_methods,
    reason = "a test lays out a home's folders as a person would"
)]
fn create_directories(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
}

/// Mira's thread, opened.
pub(crate) async fn open(daemon: &Daemon) -> String {
    match daemon.open_conversation("mira").await {
        OpenOutcome::Opened {
            conversation_id, ..
        } => conversation_id.to_string(),
        other => panic!("{other:?}"),
    }
}

/// The person's `text` on `conversation`, from the web page, as `id`.
pub(crate) fn line(conversation: &str, text: &str, id: &str) -> Message {
    Message {
        conversation_id: conversation.to_owned(),
        text: text.to_owned(),
        source: ClientStamp::new("web").unwrap(),
        client_message_id: ClientStamp::new(id).unwrap(),
    }
}

/// Sends `line`, which her inbox takes at once, and hears its turn to its
/// end: what it committed, the person's line first.
pub(crate) async fn told(daemon: &Daemon, line: Message) -> Vec<String> {
    let mut ear = Ear::on(daemon);
    let id = line.client_message_id.clone();
    let conversation = line.conversation_id.clone();

    assert_eq!(
        wire(&daemon.deliver(line).await),
        json!({"status": "queued"})
    );
    ear.ended(id.as_str()).await;
    ear.said(&conversation, id.as_str())
}

/// The JSON a client reads of `value`.
pub(crate) fn wire(value: &impl serde::Serialize) -> Value {
    serde_json::to_value(value).unwrap()
}

/// A gate a step stops at while it is shut, to hold it in flight: a
/// blocking job, as a plugin's factory on the blocking pool, or a task.
#[derive(Debug, Default)]
pub(crate) struct Gate {
    shut: Mutex<bool>,
    opened: Condvar,
    opened_async: Notify,
    reached: Notify,
}

impl Gate {
    pub(crate) fn shut(&self) {
        *self.shut.lock().unwrap() = true;
    }

    pub(crate) fn open(&self) {
        *self.shut.lock().unwrap() = false;
        self.opened.notify_all();
        self.opened_async.notify_waiters();
    }

    /// Answered once a step is held here.
    pub(crate) async fn reached(&self) {
        tokio::time::timeout(PATIENCE, self.reached.notified())
            .await
            .expect("a step reaches the gate");
    }

    /// Where a blocking job is held while the gate is shut.
    pub(crate) fn pass(&self) {
        let mut shut = self.shut.lock().unwrap();

        if *shut {
            self.reached.notify_one();
        }

        while *shut {
            shut = self.opened.wait(shut).unwrap();
        }
    }

    /// Where a task is held while the gate is shut.
    pub(crate) async fn pass_async(&self) {
        if *self.shut.lock().unwrap() {
            self.reached.notify_one();
        }

        loop {
            let opened = self.opened_async.notified();

            if !*self.shut.lock().unwrap() {
                return;
            }

            opened.await;
        }
    }
}

/// One round of the scripted model: a gate it waits at, and its replies.
#[derive(Debug)]
pub(crate) struct Round {
    gate: Option<Arc<Gate>>,
    calls: Vec<WrittenCall>,
}

impl Round {
    pub(crate) fn says(replies: &[&str]) -> Self {
        Self {
            gate: None,
            calls: replies
                .iter()
                .map(|text| WrittenCall {
                    name: "visible_reply".to_owned(),
                    input: json!({"text": text}),
                })
                .collect(),
        }
    }

    /// Waits at `gate` before it answers.
    pub(crate) fn held(mut self, gate: &Arc<Gate>) -> Self {
        self.gate = Some(Arc::clone(gate));
        self
    }
}

/// A model that answers each round as scripted, and every other with a
/// greeting.
#[derive(Debug, Default)]
pub(crate) struct Model {
    rounds: Mutex<VecDeque<Round>>,
}

impl Model {
    pub(crate) fn script(&self, rounds: impl IntoIterator<Item = Round>) {
        self.rounds.lock().unwrap().extend(rounds);
    }
}

#[async_trait]
impl RoleModelAdapter for Model {
    async fn invoke(&self, _invocation: &Invocation<'_>) -> ProviderAnswer {
        let round = self
            .rounds
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Round::says(&["Hello."]));

        if let Some(gate) = round.gate {
            gate.pass_async().await;
        }

        ProviderAnswer::Answered {
            output: ModelOutput {
                tool_calls: round.calls,
                text: None,
            },
            finish_reason: Some("stop".to_owned()),
            usage: None,
        }
    }
}

/// A plugin built behind a gate, which holds her assembly in flight while
/// it is shut.
pub(crate) struct Toy {
    id: &'static str,
    gate: Arc<Gate>,
}

impl Toy {
    pub(crate) fn built_behind(id: &'static str, gate: &Arc<Gate>) -> Self {
        Self {
            id,
            gate: Arc::clone(gate),
        }
    }

    pub(crate) fn plugin(self) -> Plugin {
        let manifest = Manifest::from_value(&json!({
            "id": self.id,
            "displayName": self.id,
            "version": "1.0.0",
            "kind": "first_party",
            "description": "A toy plugin.",
            "contractVersion": "mvp-008.runtime_plugin.v2",
            "declaredPlugins": ["on_shutdown"],
            "config": {"scope": "global_with_character_overrides", "fields": []},
            "runtimePolicy": {
                "timeoutMs": 10_000,
                "redactionLabels": [],
                "failureBehavior": {
                    "beforeRoleModelCall": "degrade",
                    "handleToolCall": "reject_tool_call",
                },
            },
            "activation": {"defaultEnabled": true, "reasons": ["test"]},
            "requestedAccess": {},
        }))
        .unwrap();
        let gate = self.gate;

        Plugin::new(
            manifest,
            |_| Ok(()),
            move |_| {
                gate.pass();

                Ok(Arc::new(Ending) as Arc<dyn RuntimePlugin>)
            },
        )
    }
}

/// What a toy runs as: an end that always completes.
#[derive(Debug)]
struct Ending;

#[async_trait]
impl RuntimePlugin for Ending {
    async fn on_shutdown(&self, _context: &HookContext) -> Result<HookReport, PluginError> {
        Ok(HookReport {
            status: HookStatus::Completed,
            evidence: Vec::new(),
        })
    }
}

/// An ear on the daemon's events from the moment it was made.
pub(crate) struct Ear {
    events: mpsc::UnboundedReceiver<Event>,
    pub(crate) heard: Vec<Event>,
}

impl Ear {
    pub(crate) fn on(daemon: &Daemon) -> Self {
        Self {
            events: daemon.events(),
            heard: Vec::new(),
        }
    }

    /// Hears events until one `matches`, and hands it back.
    pub(crate) async fn until(&mut self, matches: impl Fn(&Event) -> bool) -> Event {
        tokio::time::timeout(PATIENCE, async {
            loop {
                let event = self.events.recv().await.unwrap();

                self.heard.push(event.clone());

                if matches(&event) {
                    return event;
                }
            }
        })
        .await
        .expect("the event comes")
    }

    /// Hears events until the turn of the line `id` ends, and hands its
    /// completion back.
    pub(crate) async fn ended(&mut self, id: &str) -> Event {
        self.until(|event| {
            matches!(
                event,
                Event::TurnCompleted { client_message_id: Some(ended), .. } if ended.as_str() == id
            )
        })
        .await
    }

    /// What the turn of the line `id` on `conversation` committed, as
    /// heard: the person's line, then each reply.
    pub(crate) fn said(&self, conversation: &str, id: &str) -> Vec<String> {
        self.heard
            .iter()
            .filter_map(|event| match event {
                Event::TurnProgress {
                    conversation_id,
                    progress,
                    ..
                } if conversation_id.as_str() == conversation => match progress {
                    TurnProgress::UserMessage {
                        text,
                        client_message_id,
                        ..
                    } => Some((Some(client_message_id.as_str()), text)),
                    TurnProgress::VisibleReply { text, .. } => Some((None, text)),
                    _ => None,
                },
                _ => None,
            })
            .skip_while(|(line, _)| *line != Some(id))
            .map(|(_, text)| text.to_string())
            .collect()
    }

    /// Hears every event sent so far.
    pub(crate) fn drain(&mut self) {
        while let Ok(event) = self.events.try_recv() {
            self.heard.push(event);
        }
    }

    /// Hears events until `character` reaches `state`.
    pub(crate) async fn reached(&mut self, character: &str, state: CharacterState) {
        self.until(|event| {
            matches!(
                event,
                Event::StateChanged { character_id, state: reached, .. }
                    if character_id.as_str() == character && *reached == state
            )
        })
        .await;
    }

    /// The states `character` was heard taking, in order.
    pub(crate) fn states(&self, character: &str) -> Vec<CharacterState> {
        self.heard
            .iter()
            .filter_map(|event| match event {
                Event::StateChanged {
                    character_id,
                    state,
                    ..
                } if character_id.as_str() == character => Some(*state),
                _ => None,
            })
            .collect()
    }

    /// Every kind of event heard, in order, as the wire names it.
    pub(crate) fn kinds(&self) -> Vec<String> {
        self.heard
            .iter()
            .map(|event| wire(event)["kind"].as_str().unwrap().to_owned())
            .collect()
    }
}
