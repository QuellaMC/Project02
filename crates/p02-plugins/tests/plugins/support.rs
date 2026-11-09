//! A character's storage for the host to serve, toy plugins, and turns.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt as _;
use p02_contracts::{
    BeforeRoleModelCallOutput, CharacterStorage, CommittedTurn, Confirmation, ContextItem,
    ContextItemKind, EvidenceKind, EvidenceNote, EvidenceStatus, FactoryInput, HookContext,
    HookReport, HookStatus, Manifest, PluginError, PreparedEffect, ProvidedTool, RuntimePlugin,
    StoreAccess, StoreError, ToolCall, ToolCallId, ToolCallOutcome, ToolConcurrency,
    ToolInputContract, ToolPreparation, TurnIdentity, TurnText,
};
use p02_core::{
    CharacterProfile, EventId, EventIdentity, MessageId, SessionId, SpeakerName, Timestamp,
    TraceId, VisibleText,
};
use p02_plugins::{
    ActivationStatus, ConfigControl, ConfirmationDecision, ConfirmationRequest, Confirmer,
    FieldChange, FieldChangeOutcome, PluginHost, PluginHostBuilder, PluginSettings,
    ProposedToolCall, ReadConfigError, ToolCallReport, Turn, list,
};
use p02_shared::Identifier;
use serde_json::{Map, Value, json};
use tokio::sync::{Notify, oneshot};

use crate::storage::Storage;

pub(crate) fn id(text: &str) -> Identifier {
    Identifier::new(text).unwrap()
}

/// A turn of Mira's in session `chat.1`.
pub(crate) fn turn() -> Turn {
    turn_in("chat.1", "evt_1", &["chat.1:message-1"])
}

pub(crate) fn turn_in(session: &str, event: &str, visible: &[&str]) -> Turn {
    Turn::new(TurnIdentity {
        session_id: SessionId::parse(session).unwrap(),
        event: EventIdentity::new(
            EventId::new(event).unwrap(),
            TraceId::new(&format!("trace-{event}")).unwrap(),
            Timestamp::new("2026-10-18T00:00:00.000Z").unwrap(),
        )
        .unwrap(),
        character: CharacterProfile {
            id: id("mira"),
            display_name: SpeakerName::new("Mira").unwrap(),
        },
    })
    .with_text(TurnText {
        current_user_message: VisibleText::normalize("hello").unwrap(),
        recent_visible_message_ids: visible
            .iter()
            .map(|id| MessageId::parse(id).unwrap())
            .collect(),
    })
}

/// One model round's tool calls through `host`, the reports in call order.
pub(crate) async fn run_round(
    host: &PluginHost,
    calls: Vec<ProposedToolCall>,
    turn: &Turn,
) -> Vec<ToolCallReport> {
    let mut landed: Vec<(usize, ToolCallReport)> =
        host.handle_tool_calls(calls, turn).collect().await;

    landed.sort_by_key(|(index, _)| *index);
    landed.into_iter().map(|(_, report)| report).collect()
}

pub(crate) fn call(call_id: &str, tool: &str, input: Value) -> ProposedToolCall {
    let Value::Object(input) = input else {
        panic!("a tool input is an object");
    };

    ProposedToolCall {
        call_id: ToolCallId::new(call_id).unwrap(),
        tool_name: id(tool),
        input,
    }
}

pub(crate) fn tool(name: &str) -> ProvidedTool {
    ProvidedTool::new(
        id(name),
        "A toy tool.",
        ToolInputContract::new(json!({"type": "object"})).unwrap(),
    )
    .unwrap()
}

/// The manifest fields the tests vary; the rest stay valid.
#[derive(Clone, Debug)]
pub(crate) struct Spec {
    pub(crate) id: &'static str,
    pub(crate) declared: Value,
    pub(crate) timeout_ms: u64,
    pub(crate) labels: Value,
    pub(crate) before: &'static str,
    pub(crate) tool: &'static str,
    pub(crate) access: Value,
}

impl Spec {
    pub(crate) fn new(id: &'static str) -> Self {
        Self {
            id,
            declared: json!(["before_role_model_call"]),
            timeout_ms: 1_000,
            labels: json!(["toy"]),
            before: "degrade",
            tool: "reject_tool_call",
            access: json!({"model_input": "write"}),
        }
    }

    /// A plugin with tools and nothing else.
    pub(crate) fn tools(id: &'static str) -> Self {
        Self {
            declared: json!(["tool_provider", "handle_tool_call"]),
            ..Self::new(id)
        }
    }

    pub(crate) fn manifest(&self) -> Manifest {
        Manifest::from_value(&json!({
            "id": self.id,
            "displayName": self.id,
            "version": "1.0.0",
            "kind": "context_provider",
            "description": "A toy plugin.",
            "contractVersion": "mvp-008.runtime_plugin.v2",
            "declaredPlugins": self.declared,
            "config": {"scope": "global_with_character_overrides", "fields": []},
            "runtimePolicy": {
                "timeoutMs": self.timeout_ms,
                "redactionLabels": self.labels,
                "failureBehavior": {
                    "beforeRoleModelCall": self.before,
                    "handleToolCall": self.tool,
                },
            },
            "activation": {"defaultEnabled": false, "reasons": ["test"]},
            "requestedAccess": self.access,
        }))
        .unwrap()
    }
}

/// A factory that serves `plugin` itself every time it is asked.
pub(crate) fn serving(
    plugin: Arc<dyn RuntimePlugin>,
) -> impl Fn(&FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> + Send + Sync + 'static
{
    move |_: &FactoryInput<'_>| Ok(Arc::clone(&plugin))
}

pub(crate) trait Enable {
    #[must_use]
    fn enable(self, spec: &Spec, plugin: Arc<dyn RuntimePlugin>) -> Self;
}

impl Enable for PluginHostBuilder {
    fn enable(self, spec: &Spec, plugin: Arc<dyn RuntimePlugin>) -> Self {
        self.plugin(spec.manifest(), Map::new(), serving(plugin))
    }
}

/// Nobody to ask: every question goes unanswered.
#[derive(Debug)]
pub(crate) struct Nobody;

#[async_trait]
impl Confirmer for Nobody {
    async fn confirm(&self, _request: ConfirmationRequest) -> ConfirmationDecision {
        ConfirmationDecision::Cancelled
    }
}

/// Settings that never load, for a host whose test asks nothing of them.
#[derive(Debug)]
pub(crate) struct NoSettings;

const NO_SETTINGS: &str = "this test keeps no settings";

impl ConfigControl for NoSettings {
    fn inspect(&self, _plugin: &Identifier) -> Result<PluginSettings, ReadConfigError> {
        Err(ReadConfigError {
            sentence: NO_SETTINGS.to_owned(),
        })
    }

    fn check(&self, _change: &FieldChange) -> Result<(), String> {
        Err(NO_SETTINGS.to_owned())
    }

    fn change(&self, _change: &FieldChange) -> FieldChangeOutcome {
        FieldChangeOutcome::Failed {
            message: NO_SETTINGS.to_owned(),
        }
    }

    fn activations(&self) -> Result<Vec<(Identifier, ActivationStatus)>, ReadConfigError> {
        Err(ReadConfigError {
            sentence: NO_SETTINGS.to_owned(),
        })
    }
}

/// A host's builder over `storage`, with nobody to ask and no settings.
pub(crate) fn builder(storage: Arc<dyn CharacterStorage>) -> PluginHostBuilder {
    PluginHost::builder(storage, Arc::new(Nobody), Arc::new(NoSettings))
}

/// A host of the given plugins over a fresh storage.
pub(crate) fn host_of(plugins: Vec<(Spec, Arc<dyn RuntimePlugin>)>) -> PluginHost {
    plugins
        .into_iter()
        .fold(builder(Storage::new()), |builder, (spec, plugin)| {
            builder.enable(&spec, plugin)
        })
        .activate()
        .unwrap()
}

/// Answers every hook with what it was given, and counts its calls.
#[derive(Debug, Default)]
pub(crate) struct Scripted {
    pub(crate) tools: Vec<ProvidedTool>,
    pub(crate) before: BeforeRoleModelCallOutput,
    pub(crate) tool_outcome: Option<ToolCallOutcome>,
    pub(crate) report: Option<HookReport>,
    pub(crate) calls: AtomicUsize,
}

impl Scripted {
    /// One accepted note and `count` items of `kind`.
    pub(crate) fn answering(kind: ContextItemKind, count: usize) -> Self {
        Self {
            before: BeforeRoleModelCallOutput {
                context_items: (0..count)
                    .map(|index| {
                        ContextItem::new(id(&format!("item-{index}")), kind, "hello there")
                    })
                    .collect(),
                curated_sections: Vec::new(),
                evidence: vec![note(EvidenceKind::BeforeRoleModelCall, "Answered.")],
            },
            ..Self::default()
        }
    }

    pub(crate) fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    fn called(&self) {
        self.calls.fetch_add(1, Ordering::SeqCst);
    }
}

pub(crate) fn note(kind: EvidenceKind, summary: &str) -> EvidenceNote {
    EvidenceNote::new(kind, EvidenceStatus::Accepted, summary)
}

#[async_trait]
impl RuntimePlugin for Scripted {
    fn provided_tools(&self) -> &[ProvidedTool] {
        &self.tools
    }

    async fn before_role_model_call(
        &self,
        _context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        self.called();
        Ok(self.before.clone())
    }

    async fn handle_tool_call(
        &self,
        _call: &ToolCall,
        _context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        self.called();
        self.tool_outcome
            .clone()
            .ok_or_else(|| PluginError::new("no tool outcome was scripted"))
    }

    async fn after_turn_committed(
        &self,
        _turn: &CommittedTurn,
        _context: &HookContext,
    ) -> Result<HookReport, PluginError> {
        self.called();
        Ok(self.report.clone().unwrap_or(HookReport {
            status: HookStatus::Completed,
            evidence: Vec::new(),
        }))
    }

    async fn on_shutdown(&self, _context: &HookContext) -> Result<HookReport, PluginError> {
        self.called();
        Ok(HookReport {
            status: HookStatus::Completed,
            evidence: Vec::new(),
        })
    }
}

/// Never answers. Work it starts beside the hook watches the cancellation
/// token; dropping the hook's future is announced too.
#[derive(Debug, Default)]
pub(crate) struct Hanging {
    pub(crate) tools: Vec<ProvidedTool>,
    pub(crate) cancelled: Arc<Notify>,
    pub(crate) dropped: Arc<Notify>,
}

struct AnnounceDrop(Arc<Notify>);

impl Drop for AnnounceDrop {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

impl Hanging {
    async fn hang<T>(&self, context: &HookContext) -> Result<T, PluginError> {
        let token = context.cancellation().clone();
        let cancelled = Arc::clone(&self.cancelled);
        let _announce = AnnounceDrop(Arc::clone(&self.dropped));

        tokio::spawn(async move {
            token.cancelled().await;
            cancelled.notify_one();
        });

        std::future::pending().await
    }
}

#[async_trait]
impl RuntimePlugin for Hanging {
    fn provided_tools(&self) -> &[ProvidedTool] {
        &self.tools
    }

    async fn before_role_model_call(
        &self,
        context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        self.hang(context).await
    }

    async fn handle_tool_call(
        &self,
        _call: &ToolCall,
        context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        self.hang(context).await
    }

    async fn after_turn_committed(
        &self,
        _turn: &CommittedTurn,
        context: &HookContext,
    ) -> Result<HookReport, PluginError> {
        self.hang(context).await
    }
}

/// Fails every hook at once.
#[derive(Debug)]
pub(crate) struct Failing;

#[async_trait]
impl RuntimePlugin for Failing {
    async fn before_role_model_call(
        &self,
        _context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        Err(PluginError::new("backend unreachable"))
    }

    async fn after_turn_committed(
        &self,
        _turn: &CommittedTurn,
        _context: &HookContext,
    ) -> Result<HookReport, PluginError> {
        Err(PluginError::new("backend unreachable"))
    }
}

/// Fails every hook with more words than any record keeps.
#[derive(Debug, Default)]
pub(crate) struct Verbose {
    pub(crate) tools: Vec<ProvidedTool>,
}

impl Verbose {
    fn failure() -> PluginError {
        PluginError::new("x".repeat(20_000))
    }
}

#[async_trait]
impl RuntimePlugin for Verbose {
    fn provided_tools(&self) -> &[ProvidedTool] {
        &self.tools
    }

    async fn before_role_model_call(
        &self,
        _context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        Err(Self::failure())
    }

    async fn handle_tool_call(
        &self,
        _call: &ToolCall,
        _context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        Err(Self::failure())
    }
}

/// Panics inside its hooks.
#[derive(Debug)]
pub(crate) struct Panicking;

#[async_trait]
impl RuntimePlugin for Panicking {
    async fn before_role_model_call(
        &self,
        _context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        panic!("index out of bounds");
    }

    async fn after_turn_committed(
        &self,
        _turn: &CommittedTurn,
        _context: &HookContext,
    ) -> Result<HookReport, PluginError> {
        panic!("index out of bounds");
    }
}

/// Blocks its thread, as synchronous work that never yields would.
#[derive(Debug)]
pub(crate) struct Blocking;

#[async_trait]
impl RuntimePlugin for Blocking {
    async fn before_role_model_call(
        &self,
        _context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        std::thread::sleep(Duration::from_secs(4));
        Ok(BeforeRoleModelCallOutput::default())
    }
}

/// Starts a blocking job in its hook that waits at a gate and then writes
/// to the plugin's store, and waits for the job: the hook overruns, and the
/// job runs on past it. The write's outcome is sent once the job ends.
#[derive(Debug)]
pub(crate) struct Stalling {
    tools: Vec<ProvidedTool>,
    gate: Arc<Gate>,
    late_write: Mutex<Option<oneshot::Sender<Result<(), StoreError>>>>,
}

impl Stalling {
    pub(crate) fn new(
        tools: Vec<ProvidedTool>,
    ) -> (
        Arc<Self>,
        Arc<Gate>,
        oneshot::Receiver<Result<(), StoreError>>,
    ) {
        let gate = Arc::new(Gate::default());
        let (sender, receiver) = oneshot::channel();

        (
            Arc::new(Self {
                tools,
                gate: Arc::clone(&gate),
                late_write: Mutex::new(Some(sender)),
            }),
            gate,
            receiver,
        )
    }

    async fn stall(&self, context: &HookContext) -> Result<(), PluginError> {
        let store = context
            .character_file_store()
            .cloned()
            .ok_or_else(|| PluginError::new("the store was not granted"))?;
        let gate = Arc::clone(&self.gate);
        let report = self.late_write.lock().unwrap().take();

        tokio::task::spawn_blocking(move || {
            gate.wait();

            let written = store.with_lease(|leased| leased.write_json("late.json", &json!("late")));

            if let Some(report) = report {
                drop(report.send(written));
            }
        })
        .await
        .map_err(|error| PluginError::with_source("the blocking job failed", error))
    }
}

#[async_trait]
impl RuntimePlugin for Stalling {
    fn provided_tools(&self) -> &[ProvidedTool] {
        &self.tools
    }

    async fn handle_tool_call(
        &self,
        _call: &ToolCall,
        context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        self.stall(context).await?;
        Ok(ToolCallOutcome::Accepted {
            output: json!("saved"),
            evidence: Vec::new(),
        })
    }

    async fn after_turn_committed(
        &self,
        _turn: &CommittedTurn,
        context: &HookContext,
    ) -> Result<HookReport, PluginError> {
        self.stall(context).await?;
        Ok(HookReport {
            status: HookStatus::Completed,
            evidence: Vec::new(),
        })
    }

    async fn on_shutdown(&self, _context: &HookContext) -> Result<HookReport, PluginError> {
        Ok(HookReport {
            status: HookStatus::Completed,
            evidence: Vec::new(),
        })
    }
}

/// What a hook's context carried: the turn's message, the store and how it
/// may be used, the session history, and the databases.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Seen {
    pub(crate) message: Option<String>,
    pub(crate) store: Option<StoreAccess>,
    pub(crate) history: bool,
    pub(crate) databases: bool,
}

impl Seen {
    /// What `context` carries; how its store may be used is found by
    /// trying to write.
    pub(crate) fn of(context: &HookContext) -> Self {
        let store = context.character_file_store().map(|store| {
            match store.with_lease(|leased| leased.write_json("probe.json", &json!("probed"))) {
                Ok(()) => StoreAccess::ReadWrite,
                Err(StoreError::ReadOnly) => StoreAccess::ReadOnly,
                Err(error) => panic!("the probed store failed: {error}"),
            }
        });

        Self {
            message: context
                .turn_text()
                .map(|text| text.current_user_message.to_string()),
            store,
            history: context.session_history().is_some(),
            databases: context.plugin_database().is_some(),
        }
    }
}

/// Records what its contexts carried, by hook.
#[derive(Debug, Default)]
pub(crate) struct Probe {
    pub(crate) seen: Mutex<BTreeMap<&'static str, Seen>>,
}

impl Probe {
    fn look(&self, hook: &'static str, context: &HookContext) {
        self.seen.lock().unwrap().insert(hook, Seen::of(context));
    }

    pub(crate) fn seen(&self, hook: &str) -> Option<Seen> {
        self.seen.lock().unwrap().get(hook).cloned()
    }
}

#[async_trait]
impl RuntimePlugin for Probe {
    async fn before_role_model_call(
        &self,
        context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        self.look("before", context);
        Ok(BeforeRoleModelCallOutput::default())
    }

    async fn after_turn_committed(
        &self,
        turn: &CommittedTurn,
        context: &HookContext,
    ) -> Result<HookReport, PluginError> {
        self.look("after", context);
        self.seen.lock().unwrap().insert(
            "committed",
            Seen {
                message: turn
                    .messages()
                    .map(|messages| format!("{} message(s)", messages.len())),
                ..Seen::default()
            },
        );
        Ok(HookReport {
            status: HookStatus::Completed,
            evidence: Vec::new(),
        })
    }

    async fn on_shutdown(&self, context: &HookContext) -> Result<HookReport, PluginError> {
        self.look("shutdown", context);
        Ok(HookReport {
            status: HookStatus::Completed,
            evidence: Vec::new(),
        })
    }
}

/// `toy.read` (shared) and `toy.write` (exclusive) each take 100 ms.
#[derive(Debug)]
pub(crate) struct SlowTools {
    tools: Vec<ProvidedTool>,
    pub(crate) log: Mutex<Vec<String>>,
}

impl SlowTools {
    pub(crate) fn new() -> Self {
        Self {
            tools: vec![
                tool("toy.read").with_concurrency(ToolConcurrency::Shared),
                tool("toy.write"),
            ],
            log: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}

#[async_trait]
impl RuntimePlugin for SlowTools {
    fn provided_tools(&self) -> &[ProvidedTool] {
        &self.tools
    }

    async fn handle_tool_call(
        &self,
        call: &ToolCall,
        _context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        self.log
            .lock()
            .unwrap()
            .push(format!("start {}", call.call_id()));
        tokio::time::sleep(Duration::from_millis(100)).await;
        self.log
            .lock()
            .unwrap()
            .push(format!("end {}", call.call_id()));

        Ok(ToolCallOutcome::Accepted {
            output: json!({"call": call.call_id().as_str()}),
            evidence: Vec::new(),
        })
    }
}

/// The document `settings.update` saves.
const SETTINGS: &str = "settings.json";

/// `settings.update` asks the person first. Its preparation refuses a tone
/// it does not know; otherwise it reads the settings saved now and answers
/// with `notes`. Its effect saves the new settings.
#[derive(Debug)]
pub(crate) struct Settings {
    tools: Vec<ProvidedTool>,
    notes: Vec<EvidenceNote>,
}

impl Settings {
    pub(crate) fn noting(notes: Vec<EvidenceNote>) -> Self {
        Self {
            tools: vec![tool("settings.update").with_confirmation(Confirmation::Required)],
            notes,
        }
    }
}

#[async_trait]
impl RuntimePlugin for Settings {
    fn provided_tools(&self) -> &[ProvidedTool] {
        &self.tools
    }

    async fn prepare_tool_call(
        &self,
        call: &ToolCall,
        context: &HookContext,
    ) -> Result<ToolPreparation, PluginError> {
        let tone = call
            .input()
            .get("tone")
            .and_then(Value::as_str)
            .unwrap_or_default();

        if !["warm", "formal"].contains(&tone) {
            return Ok(ToolPreparation::Rejected {
                reason: "unknown_tone".to_owned(),
                message: format!("No tone is called \"{tone}\"."),
                evidence: Vec::new(),
            });
        }

        let store = context
            .character_file_store()
            .ok_or_else(|| PluginError::new("the store was not granted"))?;
        let settings = Value::Object(call.input().clone());
        let saved = store.with_lease(|leased| leased.read_json(SETTINGS))?;

        Ok(ToolPreparation::Prepared {
            preview: [
                ("before".to_owned(), saved.unwrap_or(Value::Null)),
                ("after".to_owned(), settings.clone()),
            ]
            .into_iter()
            .collect(),
            effect: Box::new(SaveSettings(settings)),
            evidence: self.notes.clone(),
        })
    }
}

/// Saves the settings a call prepared.
#[derive(Debug)]
struct SaveSettings(Value);

#[async_trait]
impl PreparedEffect for SaveSettings {
    async fn apply(self: Box<Self>, context: &HookContext) -> Result<ToolCallOutcome, PluginError> {
        let store = context
            .character_file_store()
            .ok_or_else(|| PluginError::new("the store was not granted"))?;

        store.with_lease(|leased| leased.write_json(SETTINGS, &self.0))?;

        Ok(ToolCallOutcome::Accepted {
            output: json!({"status": "applied"}),
            evidence: vec![note(EvidenceKind::ToolInvocation, "Saved the settings.")],
        })
    }
}

/// A gate a blocking job waits at until the test opens it.
#[derive(Debug, Default)]
pub(crate) struct Gate {
    open: Mutex<bool>,
    opened: Condvar,
}

impl Gate {
    pub(crate) fn wait(&self) {
        let mut open = self.open.lock().unwrap();

        while !*open {
            open = self.opened.wait(open).unwrap();
        }
    }

    pub(crate) fn open(&self) {
        *self.open.lock().unwrap() = true;
        self.opened.notify_all();
    }
}

/// The manifest the daemon's list holds for plugin `id`, edited as a test
/// needs it.
pub(crate) fn bundled_manifest(id: &str, edit: impl FnOnce(&mut Map<String, Value>)) -> Manifest {
    let (manifest, _) = list::plugins()
        .unwrap()
        .iter()
        .find(|(manifest, _)| manifest.id().as_str() == id)
        .unwrap();
    let Value::Object(mut fields) = serde_json::to_value(manifest).unwrap() else {
        panic!("a manifest is an object");
    };

    edit(&mut fields);
    Manifest::from_value(&Value::Object(fields)).unwrap()
}
