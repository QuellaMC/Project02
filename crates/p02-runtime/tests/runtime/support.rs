//! What the tests build a thread from: a canonical temporary home, Mira as
//! her bundled package defines her, a model whose answers are scripted, a
//! plugin whose hooks are, and an ear for what a turn says.

use std::collections::VecDeque;
use std::fmt;
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use p02_characters::discover;
use p02_contracts::{
    BeforeRoleModelCallOutput, CommittedTurn, ConversationTurn, HealthReport, HookContext,
    HookReport, InputEnvelope, Invocation, Manifest, PluginError, ProvidedTool, ProviderAnswer,
    RawOutput, ReplyDelta, RoleModelAdapter, RuntimePlugin, TextCompletion, TextCompletionRequest,
    ToolCall, ToolCallOutcome, ToolInputContract,
};
use p02_core::{ClientStamp, ConversationId, SessionId, SpeakerName};
use p02_plugins::PluginHost;
use p02_runtime::{Character, Conversation, Delivery, Progress, Submission};
use p02_shared::{DanglingLinks, Identifier, canonical_path};
use p02_store::{CharacterData, Home, LogRecord, RecordKind};
use serde_json::{Map, Value, json};
use tempfile::TempDir;

/// A window the tests' turns never outgrow.
pub(crate) const ROOMY: NonZeroU64 = NonZeroU64::new(100_000).unwrap();

pub(crate) fn id(text: &str) -> Identifier {
    Identifier::new(text).unwrap()
}

pub(crate) fn stamp(text: &str) -> ClientStamp {
    ClientStamp::new(text).unwrap()
}

/// Mira as her bundled package defines her.
pub(crate) fn mira() -> Character {
    let empty = TempDir::new().unwrap();
    let definition = discover(empty.path())
        .characters
        .into_iter()
        .find(|character| character.profile.id.as_str() == "mira")
        .unwrap();

    Character {
        character_ref: definition.character_ref(),
        profile: definition.profile,
        persona: definition.persona,
    }
}

/// A model answer that says `replies`, in order.
pub(crate) fn reply(replies: &[&str]) -> String {
    let calls: Vec<Value> = replies
        .iter()
        .map(|text| json!({"name": "visible_reply", "input": {"text": text}}))
        .collect();

    json!({"toolCalls": calls}).to_string()
}

/// A model answer that calls `tool` with `input`.
pub(crate) fn calling(tool: &str, input: &Value) -> String {
    json!({"toolCalls": [{"name": tool, "input": input}]}).to_string()
}

/// A home of the test's own, spelled canonically as the daemon spells its
/// home; the directory goes with it.
pub(crate) struct World {
    _directory: TempDir,
    pub(crate) home: Home,
}

impl World {
    pub(crate) fn new() -> Self {
        let directory = TempDir::new().unwrap();
        let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());

        Self {
            _directory: directory,
            home,
        }
    }

    /// The thread between Sam and Mira, opened as the character's actor
    /// opens it.
    pub(crate) fn open(&self) -> Conversation {
        Conversation::open(&self.home, mira(), SpeakerName::new("Sam").unwrap()).unwrap()
    }

    pub(crate) fn data(&self) -> CharacterData {
        CharacterData::open(&self.home, &id("mira"))
            .unwrap()
            .unwrap()
    }

    /// A host of `plugins` over Mira's storage.
    pub(crate) fn host(&self, plugins: &[Arc<Toy>]) -> PluginHost {
        plugins
            .iter()
            .fold(
                PluginHost::builder(Arc::new(self.data())),
                |builder, toy| {
                    let plugin: Arc<dyn RuntimePlugin> = Arc::clone(toy) as _;

                    builder.plugin(toy.manifest(), Map::new(), move |_| Ok(Arc::clone(&plugin)))
                },
            )
            .activate()
            .unwrap()
    }

    /// The records of segment `segment` of `conversation`, read as every
    /// reader of the log reads them, which skips none of what the runtime
    /// wrote.
    pub(crate) fn records(&self, conversation: &ConversationId, segment: u64) -> Vec<LogRecord> {
        let replay = self
            .data()
            .session_log(
                &self.home.conversation(conversation).unwrap(),
                NonZeroU64::new(segment).unwrap(),
            )
            .unwrap()
            .read()
            .unwrap();

        assert!(
            replay.skipped_lines().is_empty(),
            "{}",
            replay.skipped_lines()
        );
        replay.records().to_vec()
    }

    pub(crate) fn kinds(&self, conversation: &ConversationId, segment: u64) -> Vec<RecordKind> {
        self.records(conversation, segment)
            .iter()
            .map(LogRecord::kind)
            .collect()
    }

    /// Where segment `segment` of `conversation` keeps its log.
    pub(crate) fn log(&self, conversation: &ConversationId, segment: u64) -> PathBuf {
        self.data()
            .root()
            .join("sessions")
            .join(format!("{conversation}.{segment}"))
            .join("raw-events.jsonl")
    }
}

/// An open thread with what answers it and what hears it.
pub(crate) struct Chat {
    pub(crate) world: World,
    /// None only while the thread is closed to be opened again.
    pub(crate) conversation: Option<Conversation>,
    pub(crate) model: Model,
    pub(crate) host: PluginHost,
    pub(crate) heard: Heard,
    pub(crate) window: NonZeroU64,
}

impl Chat {
    /// A fresh thread, its plugins `plugins`, in a window the turns never
    /// outgrow.
    pub(crate) fn new(plugins: &[Arc<Toy>]) -> Self {
        let world = World::new();
        let conversation = world.open();
        let host = world.host(plugins);

        Self {
            world,
            conversation: Some(conversation),
            model: Model::default(),
            host,
            heard: Heard::default(),
            window: ROOMY,
        }
    }

    /// Sam says `line`, submitted from the web page as `client_message_id`.
    pub(crate) async fn say(&mut self, line: &str, client_message_id: &str) -> Delivery {
        self.say_hearing(line, client_message_id, |_| {}).await
    }

    /// Sam says `line` as [`Chat::say`] has it, `hearing` each piece of
    /// what the turn says the moment it is said.
    pub(crate) async fn say_hearing(
        &mut self,
        line: &str,
        client_message_id: &str,
        hearing: impl Fn(&Progress) + Send + Sync,
    ) -> Delivery {
        let heard = &self.heard;

        self.conversation
            .as_mut()
            .unwrap()
            .deliver(
                Submission {
                    line,
                    source: Some(stamp("web")),
                    client_message_id: Some(stamp(client_message_id)),
                },
                &self.model,
                &self.host,
                self.window,
                &|progress| {
                    hearing(&progress);
                    heard.push(progress);
                },
            )
            .await
    }

    /// Closes the thread, saying what failed of its end, and opens it
    /// again, as a restarted character does.
    pub(crate) async fn reopen(&mut self) -> Option<String> {
        let closed = self.conversation.take().unwrap().close(&self.host).await;

        self.conversation = Some(self.world.open());
        closed
    }

    pub(crate) fn id(&self) -> ConversationId {
        self.conversation.as_ref().unwrap().id().clone()
    }

    pub(crate) fn kinds(&self, segment: u64) -> Vec<RecordKind> {
        self.world.kinds(&self.id(), segment)
    }

    pub(crate) fn records(&self, segment: u64) -> Vec<LogRecord> {
        self.world.records(&self.id(), segment)
    }

    pub(crate) fn log(&self, segment: u64) -> PathBuf {
        self.world.log(&self.id(), segment)
    }
}

/// One round of a scripted model: the pieces of a reply it drafts, then its
/// answer, if it ever gives one.
pub(crate) struct Round {
    drafts: Vec<ReplyDelta>,
    answer: Option<ProviderAnswer>,
}

impl Round {
    pub(crate) fn says(text: impl Into<String>) -> Self {
        Self {
            drafts: Vec::new(),
            answer: Some(ProviderAnswer::Text(text.into())),
        }
    }

    /// A provider that gave nothing usable, as `details` says.
    pub(crate) fn fails(details: &str) -> Self {
        Self {
            drafts: Vec::new(),
            answer: Some(ProviderAnswer::Failed {
                details: details.to_owned(),
            }),
        }
    }

    /// A provider that never answers.
    pub(crate) fn hangs() -> Self {
        Self {
            drafts: Vec::new(),
            answer: None,
        }
    }

    /// Drafts its reply `reply`, counted from zero, in `pieces` before it
    /// answers.
    pub(crate) fn drafting(mut self, reply: usize, pieces: &[&str]) -> Self {
        self.drafts = pieces
            .iter()
            .map(|piece| ReplyDelta {
                reply,
                text: (*piece).to_owned(),
            })
            .collect();
        self
    }
}

/// What a model round was asked: its envelope, and the turns it replayed.
#[derive(Debug)]
pub(crate) struct Asked {
    pub(crate) envelope: InputEnvelope,
    pub(crate) history: Vec<ConversationTurn>,
}

/// A model that answers each round, and each plain completion, as scripted,
/// and keeps what it was asked. A round it has no answer for fails.
#[derive(Default)]
pub(crate) struct Model {
    rounds: Mutex<VecDeque<Round>>,
    completions: Mutex<VecDeque<TextCompletion>>,
    pub(crate) asked: Mutex<Vec<Asked>>,
    pub(crate) summarized: Mutex<Vec<TextCompletionRequest>>,
}

impl Model {
    pub(crate) fn script(&self, rounds: impl IntoIterator<Item = Round>) {
        self.rounds.lock().unwrap().extend(rounds);
    }

    pub(crate) fn complete(&self, completion: TextCompletion) {
        self.completions.lock().unwrap().push_back(completion);
    }
}

impl fmt::Debug for Model {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Model")
            .field("rounds", &self.rounds.lock().unwrap().len())
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl RoleModelAdapter for Model {
    async fn invoke(&self, envelope: &InputEnvelope, invocation: &Invocation<'_>) -> RawOutput {
        self.asked.lock().unwrap().push(Asked {
            envelope: envelope.clone(),
            history: invocation.history().to_vec(),
        });

        let Some(round) = self.rounds.lock().unwrap().pop_front() else {
            return RawOutput {
                answer: ProviderAnswer::Failed {
                    details: "No round was scripted.".to_owned(),
                },
                provider_metadata: None,
                provider_exchange: None,
            };
        };

        for delta in round.drafts {
            invocation.hear(delta);
        }

        let Some(answer) = round.answer else {
            return std::future::pending().await;
        };

        RawOutput {
            answer,
            provider_metadata: None,
            provider_exchange: None,
        }
    }

    async fn complete_text(&self, request: &TextCompletionRequest) -> TextCompletion {
        self.summarized.lock().unwrap().push(request.clone());
        self.completions
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(TextCompletion::Unsupported)
    }
}

/// What a turn said, in the order it said it.
#[derive(Debug, Default)]
pub(crate) struct Heard(Mutex<Vec<Progress>>);

impl Heard {
    pub(crate) fn push(&self, progress: Progress) {
        self.0.lock().unwrap().push(progress);
    }

    /// Everything heard since the last take, in plain words.
    pub(crate) fn take(&self) -> Vec<String> {
        told(&std::mem::take(&mut *self.0.lock().unwrap()))
    }
}

/// What a turn said, each piece its kind and then what it names.
pub(crate) fn told(progress: &[Progress]) -> Vec<String> {
    progress
        .iter()
        .map(|progress| match progress {
            Progress::UserMessage { message, .. } => format!("user_message {}", message.text),
            Progress::VisibleReply { message, draft } => {
                format!("visible_reply {draft} {}", message.text)
            }
            Progress::ReplyDelta { draft, text } => format!("reply_delta {draft} {text}"),
            Progress::ReplyWithdrawn { draft } => format!("reply_withdrawn {draft}"),
            Progress::ToolCallsRequested { round, tool_names } => {
                let names: Vec<&str> = tool_names.iter().map(Identifier::as_str).collect();

                format!("tool_calls_requested {round} {}", names.join(" "))
            }
            Progress::ToolCallCompleted {
                round,
                tool_name,
                accepted,
            } => format!(
                "tool_call_completed {round} {tool_name} {}",
                if *accepted { "accepted" } else { "rejected" }
            ),
        })
        .collect()
}

type Hook<T> = Box<dyn Fn(&HookContext) -> Result<T, PluginError> + Send + Sync>;
type Handler = Box<dyn Fn(&ToolCall) -> ToolCallOutcome + Send + Sync>;

/// A plugin whose hooks are what a test scripts, each one it is given
/// declared, with the sessions its end hook ended.
pub(crate) struct Toy {
    id: &'static str,
    access: Value,
    rejects_turn: bool,
    tools: Vec<ProvidedTool>,
    before: Option<Hook<BeforeRoleModelCallOutput>>,
    tool: Option<Handler>,
    health: Option<HealthReport>,
    after: Option<Hook<HookReport>>,
    end: Option<Hook<HookReport>>,
    pub(crate) ended: Mutex<Vec<SessionId>>,
}

impl Toy {
    pub(crate) fn new(id: &'static str) -> Self {
        Self {
            id,
            access: json!({}),
            rejects_turn: false,
            tools: Vec::new(),
            before: None,
            tool: None,
            health: None,
            after: None,
            end: None,
            ended: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn access(mut self, access: Value) -> Self {
        self.access = access;
        self
    }

    /// A failure of its before-call hook or its health rejects the turn,
    /// rather than degrading it.
    pub(crate) fn rejecting_turns(mut self) -> Self {
        self.rejects_turn = true;
        self
    }

    pub(crate) fn before(
        mut self,
        hook: impl Fn(&HookContext) -> Result<BeforeRoleModelCallOutput, PluginError>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        self.before = Some(Box::new(hook));
        self
    }

    /// Offers tool `name`, taking any object, answered by `handler`.
    pub(crate) fn tool(
        mut self,
        name: &str,
        handler: impl Fn(&ToolCall) -> ToolCallOutcome + Send + Sync + 'static,
    ) -> Self {
        self.tools.push(
            ProvidedTool::new(
                id(name),
                "A toy tool.",
                ToolInputContract::new(json!({"type": "object"})).unwrap(),
            )
            .unwrap(),
        );
        self.tool = Some(Box::new(handler));
        self
    }

    pub(crate) fn health(mut self, report: HealthReport) -> Self {
        self.health = Some(report);
        self
    }

    pub(crate) fn after(
        mut self,
        hook: impl Fn(&HookContext) -> Result<HookReport, PluginError> + Send + Sync + 'static,
    ) -> Self {
        self.after = Some(Box::new(hook));
        self
    }

    pub(crate) fn end(
        mut self,
        hook: impl Fn(&HookContext) -> Result<HookReport, PluginError> + Send + Sync + 'static,
    ) -> Self {
        self.end = Some(Box::new(hook));
        self
    }

    fn manifest(&self) -> Manifest {
        let mut declared = Vec::new();

        if self.before.is_some() {
            declared.push("before_role_model_call");
        }

        if self.tool.is_some() {
            declared.extend(["tool_provider", "handle_tool_call"]);
        }

        if self.health.is_some() {
            declared.push("health");
        }

        if self.after.is_some() {
            declared.push("after_turn_committed");
        }

        if self.end.is_some() {
            declared.push("on_session_end");
        }

        let failing = if self.rejects_turn {
            "reject_turn"
        } else {
            "degrade"
        };

        Manifest::from_value(&json!({
            "id": self.id,
            "displayName": self.id,
            "version": "1.0.0",
            "kind": "context_provider",
            "description": "A toy plugin.",
            "contractVersion": "mvp-008.runtime_plugin.v2",
            "compatibility": {"hostContractVersions": ["mvp-008.runtime_plugin.v2"]},
            "declaredPlugins": declared,
            "config": {"scope": "global_with_character_overrides", "fields": []},
            "firstParty": true,
            "runtimePolicy": {
                "timeoutMs": 10_000,
                "redactionLabels": [],
                "failureBehavior": {
                    "beforeRoleModelCall": failing,
                    "handleToolCall": "reject_tool_call",
                    "health": failing,
                },
            },
            "activation": {"defaultEnabled": false, "reasons": ["test"]},
            "requestedAccess": self.access,
        }))
        .unwrap()
    }
}

impl fmt::Debug for Toy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Toy")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

fn unscripted<T>(hook: &str) -> Result<T, PluginError> {
    Err(PluginError::new(format!("{hook} was not scripted")))
}

#[async_trait]
impl RuntimePlugin for Toy {
    fn provided_tools(&self) -> &[ProvidedTool] {
        &self.tools
    }

    async fn before_role_model_call(
        &self,
        context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        self.before
            .as_ref()
            .map_or_else(|| unscripted("beforeRoleModelCall"), |hook| hook(context))
    }

    async fn handle_tool_call(
        &self,
        call: &ToolCall,
        _context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        self.tool
            .as_ref()
            .map_or_else(|| unscripted("handleToolCall"), |handler| Ok(handler(call)))
    }

    async fn after_turn_committed(
        &self,
        _turn: &CommittedTurn,
        context: &HookContext,
    ) -> Result<HookReport, PluginError> {
        self.after
            .as_ref()
            .map_or_else(|| unscripted("afterTurnCommitted"), |hook| hook(context))
    }

    async fn on_session_end(&self, context: &HookContext) -> Result<HookReport, PluginError> {
        self.ended
            .lock()
            .unwrap()
            .push(context.turn().session_id.clone());
        self.end
            .as_ref()
            .map_or_else(|| unscripted("onSessionEnd"), |hook| hook(context))
    }

    async fn health(&self, _context: &HookContext) -> Result<HealthReport, PluginError> {
        self.health.clone().map_or_else(|| unscripted("health"), Ok)
    }
}

/// Makes `path` read-only, handing back what its permissions were.
pub(crate) fn make_read_only(path: &Path) -> std::fs::Permissions {
    let before = std::fs::metadata(path).unwrap().permissions();
    let mut read_only = before.clone();

    read_only.set_readonly(true);
    std::fs::set_permissions(path, read_only).unwrap();
    before
}

pub(crate) fn restore(path: &Path, permissions: std::fs::Permissions) {
    std::fs::set_permissions(path, permissions).unwrap();
}
