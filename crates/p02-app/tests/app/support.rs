//! What the tests build a daemon from: a canonical temporary home, the
//! bundled Mira, a model whose rounds are scripted, plugins whose parts are,
//! a gate that holds a step in flight, and an ear on the events.

use std::collections::VecDeque;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::task::Poll;
use std::time::Duration;

use async_trait::async_trait;
use p02_app::{
    CharacterState, Daemon, DaemonSettings, Durations, Event, Message, OpenOutcome, Plugin,
    RunningTurn, RunningTurns, TurnOutcome,
};
use p02_config::ChangeOutcome;
use p02_contracts::{
    CommittedTurn, Confirmation, EvidenceKind, EvidenceNote, EvidenceStatus, HookContext,
    HookReport, HookStatus, InputEnvelope, Invocation, Manifest, PluginError, PreparedEffect,
    ProvidedTool, RawOutput, ReplyDelta, RoleModelAdapter, RuntimePlugin, ToolCall,
    ToolCallOutcome, ToolInputContract, ToolPreparation,
};
use p02_plugins::list;
use p02_shared::{DanglingLinks, Identifier, canonical_path};
use p02_store::Home;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::{Notify, mpsc};

/// How long a test waits for what it expects before it fails.
const PATIENCE: Duration = Duration::from_secs(120);

pub(crate) fn id(text: &str) -> Identifier {
    Identifier::new(text).unwrap()
}

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

    /// Writes the home's settings as `document` says them.
    pub(crate) fn settings(&self, document: Value) {
        let Value::Object(mut fields) = document else {
            panic!("settings are an object");
        };

        fields.insert("version".to_owned(), json!("project02.config.v2"));
        write(
            &self.path("config.json"),
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
    /// model, with the plugins of the daemon's list, the one built behind
    /// the assembly gate, and `plugins`.
    pub(crate) async fn daemon(&self, plugins: Vec<Plugin>) -> Daemon {
        self.daemon_answering(Some(Arc::clone(&self.model) as _), plugins)
            .await
    }

    /// A daemon on this home whose characters answer through `model`, or
    /// as their settings choose.
    pub(crate) async fn daemon_answering(
        &self,
        model: Option<Arc<dyn RoleModelAdapter>>,
        plugins: Vec<Plugin>,
    ) -> Daemon {
        let listed = list::plugins()
            .unwrap()
            .iter()
            .map(|(manifest, factory)| Plugin::new(manifest.clone(), *factory));
        let gated = Toy::new("assembly").built_behind(&self.assembly).plugin();

        Daemon::open(
            self.home.clone(),
            DaemonSettings {
                test_provider: model,
                durations: Durations::default(),
                plugins: listed.chain([gated]).chain(plugins).collect(),
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
        sender_id: "local-user".to_owned(),
        text: text.to_owned(),
        source: "web".to_owned(),
        client_message_id: id.to_owned(),
    }
}

/// What the person and the character said in a completed turn.
pub(crate) fn said(outcome: &TurnOutcome) -> Vec<String> {
    match outcome {
        TurnOutcome::Completed { messages, .. } => messages
            .iter()
            .map(|message| message.text.to_string())
            .collect(),
        other => panic!("{other:?}"),
    }
}

/// The JSON a client reads of `value`.
pub(crate) fn wire(value: &impl serde::Serialize) -> Value {
    serde_json::to_value(value).unwrap()
}

/// Makes `operation` on the settings of `target` as a settings screen
/// does, bound to the fingerprint its view shows, and expects it applied.
pub(crate) async fn change(daemon: &Daemon, target: Value, operation: Value) {
    let view = daemon
        .config_view(serde_json::from_value(target.clone()).unwrap())
        .await;
    let outcome = daemon
        .apply_change(
            serde_json::from_value(json!({
                "target": target,
                "expectedFingerprint": wire(&view)["fingerprint"],
                "operation": operation,
            }))
            .unwrap(),
        )
        .await;

    assert!(
        matches!(outcome, ChangeOutcome::Applied { .. }),
        "{outcome:?}"
    );
}

/// The home's settings, as a change targets them.
pub(crate) fn home() -> Value {
    json!({"scope": "global"})
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

/// One round of the scripted model: the pieces it drafts of its reply, a
/// gate it waits at, and its answer.
pub(crate) struct Round {
    drafts: Vec<String>,
    gate: Option<Arc<Gate>>,
    answer: String,
}

impl Round {
    pub(crate) fn says(replies: &[&str]) -> Self {
        let calls: Vec<Value> = replies
            .iter()
            .map(|text| json!({"name": "visible_reply", "input": {"text": text}}))
            .collect();

        Self::answering(&json!({"toolCalls": calls}))
    }

    pub(crate) fn calls(tool: &str, input: &Value) -> Self {
        Self::answering(&json!({"toolCalls": [{"name": tool, "input": input}]}))
    }

    fn answering(answer: &Value) -> Self {
        Self {
            drafts: Vec::new(),
            gate: None,
            answer: answer.to_string(),
        }
    }

    /// Drafts its first reply in `pieces` before anything else.
    pub(crate) fn drafting(mut self, pieces: &[&str]) -> Self {
        self.drafts = pieces.iter().map(|piece| (*piece).to_owned()).collect();
        self
    }

    /// Waits at `gate` once it drafted.
    pub(crate) fn held(mut self, gate: &Arc<Gate>) -> Self {
        self.gate = Some(Arc::clone(gate));
        self
    }
}

/// A model that answers each round as scripted, and every other with a
/// greeting, counting how often it was asked.
#[derive(Default)]
pub(crate) struct Model {
    rounds: Mutex<VecDeque<Round>>,
    asked: AtomicUsize,
}

impl Model {
    pub(crate) fn script(&self, rounds: impl IntoIterator<Item = Round>) {
        self.rounds.lock().unwrap().extend(rounds);
    }

    pub(crate) fn asked(&self) -> usize {
        self.asked.load(Ordering::SeqCst)
    }
}

impl std::fmt::Debug for Model {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Model")
            .field("asked", &self.asked())
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl RoleModelAdapter for Model {
    async fn invoke(&self, _envelope: &InputEnvelope, invocation: &Invocation<'_>) -> RawOutput {
        self.asked.fetch_add(1, Ordering::SeqCst);

        let round = self
            .rounds
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Round::says(&["Hello."]));

        for text in round.drafts {
            invocation.hear(ReplyDelta { reply: 0, text });
        }

        if let Some(gate) = round.gate {
            gate.pass_async().await;
        }

        RawOutput::text(round.answer)
    }
}

/// A plugin whose parts a test scripts: a gate its factory is built
/// behind, an approval-gated tool, settings fields, and work after every
/// committed turn that fails.
pub(crate) struct Toy {
    id: &'static str,
    gate: Option<Arc<Gate>>,
    gated_tool: Option<&'static str>,
    fields: Vec<Value>,
    failing_after_turns: bool,
}

impl Toy {
    pub(crate) fn new(id: &'static str) -> Self {
        Self {
            id,
            gate: None,
            gated_tool: None,
            fields: Vec::new(),
            failing_after_turns: false,
        }
    }

    /// Fails its work after every committed turn: "The diary is full."
    pub(crate) fn failing_after_turns(mut self) -> Self {
        self.failing_after_turns = true;
        self
    }

    pub(crate) fn built_behind(mut self, gate: &Arc<Gate>) -> Self {
        self.gate = Some(Arc::clone(gate));
        self
    }

    /// Offers tool `name`, which saves a note only on the person's yes.
    pub(crate) fn asking(mut self, name: &'static str) -> Self {
        self.gated_tool = Some(name);
        self
    }

    /// Declares a text setting `name`.
    pub(crate) fn setting(mut self, name: &str) -> Self {
        self.fields.push(json!({
            "name": name,
            "description": "A toy setting.",
            "required": false,
            "secret": false,
            "valueType": "string",
            "redactionLabels": [],
        }));
        self
    }

    pub(crate) fn plugin(self) -> Plugin {
        let mut declared = vec!["on_shutdown"];

        if self.gated_tool.is_some() {
            declared.extend(["tool_provider", "handle_tool_call"]);
        }

        if self.failing_after_turns {
            declared.push("after_turn_committed");
        }

        let manifest = Manifest::from_value(&json!({
            "id": self.id,
            "displayName": self.id,
            "version": "1.0.0",
            "kind": "first_party",
            "description": "A toy plugin.",
            "contractVersion": "mvp-008.runtime_plugin.v2",
            "compatibility": {"hostContractVersions": ["mvp-008.runtime_plugin.v2"]},
            "declaredPlugins": declared,
            "config": {"scope": "global_with_character_overrides", "fields": self.fields},
            "firstParty": true,
            "runtimePolicy": {
                "timeoutMs": 10_000,
                "redactionLabels": [],
                "failureBehavior": {
                    "beforeRoleModelCall": "degrade",
                    "handleToolCall": "reject_tool_call",
                    "health": "degrade",
                },
            },
            "activation": {"defaultEnabled": true, "reasons": ["test"]},
            "requestedAccess": if self.gated_tool.is_some() {
                json!({"model_input": "write"})
            } else {
                json!({})
            },
        }))
        .unwrap();
        let (gate, gated_tool) = (self.gate, self.gated_tool);

        Plugin::new(manifest, move |_| {
            if let Some(gate) = &gate {
                gate.pass();
            }

            let tools = gated_tool
                .map(|name| {
                    ProvidedTool::new(
                        id(name),
                        "Saves a note the person approves.",
                        ToolInputContract::new(json!({"type": "object"})).unwrap(),
                    )
                    .unwrap()
                    .with_confirmation(Confirmation::Required)
                })
                .into_iter()
                .collect();

            Ok(Arc::new(Notes { tools }) as Arc<dyn RuntimePlugin>)
        })
    }
}

/// What a toy runs as: an end that always completes, an approval-gated
/// tool, if it offers one, whose call shows the note it would save and
/// saves it on a yes, and work after a committed turn, if it declares any,
/// that fails.
#[derive(Debug)]
struct Notes {
    tools: Vec<ProvidedTool>,
}

#[async_trait]
impl RuntimePlugin for Notes {
    fn provided_tools(&self) -> &[ProvidedTool] {
        &self.tools
    }

    async fn prepare_tool_call(
        &self,
        call: &ToolCall,
        _context: &HookContext,
    ) -> Result<ToolPreparation, PluginError> {
        Ok(ToolPreparation::Prepared {
            preview: call.input().clone(),
            effect: Box::new(Save),
            evidence: Vec::new(),
        })
    }

    async fn after_turn_committed(
        &self,
        _turn: &CommittedTurn,
        _context: &HookContext,
    ) -> Result<HookReport, PluginError> {
        Err(PluginError::new("The diary is full."))
    }

    async fn on_shutdown(&self, _context: &HookContext) -> Result<HookReport, PluginError> {
        Ok(HookReport {
            status: HookStatus::Completed,
            evidence: Vec::new(),
        })
    }
}

#[derive(Debug)]
struct Save;

#[async_trait]
impl PreparedEffect for Save {
    async fn apply(
        self: Box<Self>,
        _context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        Ok(ToolCallOutcome::Accepted {
            output: json!({"saved": true}),
            evidence: vec![EvidenceNote::new(
                EvidenceKind::ToolInvocation,
                EvidenceStatus::Accepted,
                "Saved the note.",
            )],
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

    /// The turns running by what was heard.
    pub(crate) fn running(&self) -> Vec<RunningTurn> {
        let mut running = RunningTurns::default();

        for event in &self.heard {
            running.fold(event);
        }

        running.turns()
    }

    /// Every kind of event heard, in order, as the wire names it.
    pub(crate) fn kinds(&self) -> Vec<String> {
        self.heard
            .iter()
            .map(|event| wire(event)["kind"].as_str().unwrap().to_owned())
            .collect()
    }
}
