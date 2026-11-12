use std::error::Error;
use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use p02_shared::Identifier;
use p02_wire::{AccessLevel, AccessName};
use serde_json::{Map, Value};

use crate::capability::{DatabaseError, SessionHistoryError, StoreError};
use crate::config::ResolvedConfig;
use crate::context::HookContext;
use crate::manifest::Manifest;
use crate::output::{BeforeRoleModelCallOutput, CommittedTurn, HookReport};
use crate::tool::{ProvidedTool, ToolCall, ToolCallOutcome, ToolPreparation};
use crate::vocabulary::Declaration;

/// A plugin compiled into the daemon. Which plugins run is decided by the
/// settings when a character starts, so the host keeps them in one list of
/// `dyn RuntimePlugin`; the hooks are boxed futures for that reason.
///
/// The host calls a hook only when the manifest declares it, under the
/// plugin's one budget and the hook's cancellation (see [`HookContext`]).
/// A hook the manifest declares and the plugin leaves out fails, through
/// the hook's failure policy like any other failure.
#[async_trait]
pub trait RuntimePlugin: Send + Sync + fmt::Debug {
    /// The tools the plugin answers in [`RuntimePlugin::handle_tool_call`],
    /// or, when approval-gated, in [`RuntimePlugin::prepare_tool_call`].
    fn provided_tools(&self) -> &[ProvidedTool] {
        &[]
    }

    /// Contributes model input before the turn's model call.
    async fn before_role_model_call(
        &self,
        context: &HookContext,
    ) -> Result<BeforeRoleModelCallOutput, PluginError> {
        let _ = context;

        Err(PluginError::not_implemented(Hook::BeforeRoleModelCall))
    }

    /// Answers a call of one of the plugin's tools that act without
    /// approval.
    async fn handle_tool_call(
        &self,
        call: &ToolCall,
        context: &HookContext,
    ) -> Result<ToolCallOutcome, PluginError> {
        let _ = (call, context);

        Err(PluginError::not_implemented(Hook::HandleToolCall))
    }

    /// Prepares a call of one of the plugin's approval-gated tools before
    /// the person is asked, and changes nothing, so its context holds
    /// nothing that writes: its store only reads here, and it has no
    /// database. A call the tool refuses is refused without asking, and what
    /// the call does is its effect's, which the host applies only on the
    /// person's yes.
    async fn prepare_tool_call(
        &self,
        call: &ToolCall,
        context: &HookContext,
    ) -> Result<ToolPreparation, PluginError> {
        let _ = (call, context);

        Err(PluginError::new(format!(
            "{} is declared, but the plugin prepares no approval-gated call",
            Hook::HandleToolCall.name()
        )))
    }

    /// Follows a turn that is already durable; it can undo nothing.
    async fn after_turn_committed(
        &self,
        turn: &CommittedTurn,
        context: &HookContext,
    ) -> Result<HookReport, PluginError> {
        let _ = (turn, context);

        Err(PluginError::not_implemented(Hook::AfterTurnCommitted))
    }

    /// Ends the plugin; its stores only read here.
    async fn on_shutdown(&self, context: &HookContext) -> Result<HookReport, PluginError> {
        let _ = context;

        Err(PluginError::not_implemented(Hook::OnShutdown))
    }
}

/// A lifecycle hook.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Hook {
    BeforeRoleModelCall,
    HandleToolCall,
    AfterTurnCommitted,
    OnShutdown,
}

impl Hook {
    /// The hook's name as records and messages spell it.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::BeforeRoleModelCall => "beforeRoleModelCall",
            Self::HandleToolCall => "handleToolCall",
            Self::AfterTurnCommitted => "afterTurnCommitted",
            Self::OnShutdown => "onShutdown",
        }
    }

    /// What a manifest declares for the host to call the hook.
    #[must_use]
    pub const fn declaration(self) -> Declaration {
        match self {
            Self::BeforeRoleModelCall => Declaration::BeforeRoleModelCall,
            Self::HandleToolCall => Declaration::HandleToolCall,
            Self::AfterTurnCommitted => Declaration::AfterTurnCommitted,
            Self::OnShutdown => Declaration::OnShutdown,
        }
    }
}

/// A failure a plugin reports from a hook or its factory. The host records
/// its message and each cause beneath it, so what broke is named with why.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct PluginError {
    message: String,
    #[source]
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl PluginError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            source: None,
        }
    }

    #[must_use]
    pub fn with_source(
        message: impl Into<String>,
        source: impl Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            message: message.into(),
            source: Some(Box::new(source)),
        }
    }

    /// A hook the manifest declares and the plugin does not implement.
    #[must_use]
    pub fn not_implemented(hook: Hook) -> Self {
        Self::new(format!("{} is declared but not implemented", hook.name()))
    }
}

impl From<StoreError> for PluginError {
    fn from(error: StoreError) -> Self {
        Self::with_source("the plugin store call failed", error)
    }
}

impl From<DatabaseError> for PluginError {
    fn from(error: DatabaseError) -> Self {
        Self::with_source("the plugin database did not open", error)
    }
}

impl From<SessionHistoryError> for PluginError {
    fn from(error: SessionHistoryError) -> Self {
        Self::with_source("the session history could not be read", error)
    }
}

/// A plugin paired with the manifest it was built from and the tools it
/// provided then, checked against what the manifest declares and requests.
#[derive(Clone, Debug)]
pub struct Registration {
    manifest: Arc<Manifest>,
    plugin: Arc<dyn RuntimePlugin>,
    tools: Arc<[ProvidedTool]>,
}

/// Why a plugin does not match its manifest.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum RegistrationError {
    #[error(
        "plugin \"{plugin_id}\" provides tools, so its manifest must declare tool_provider and \
         handle_tool_call"
    )]
    UndeclaredTools { plugin_id: Identifier },
    #[error(
        "plugin \"{plugin_id}\" provides tools, which the model is offered, so its manifest must \
         request model_input write"
    )]
    ModelInputRequired { plugin_id: Identifier },
}

impl Registration {
    /// # Errors
    ///
    /// [`RegistrationError`] when the plugin's tools contradict its
    /// manifest.
    pub fn new(
        manifest: Manifest,
        plugin: Arc<dyn RuntimePlugin>,
    ) -> Result<Self, RegistrationError> {
        let tools: Arc<[ProvidedTool]> = plugin.provided_tools().into();
        let plugin_id = || manifest.id().clone();
        let tools_declared = manifest.declares(Declaration::ToolProvider)
            && manifest.declares(Declaration::HandleToolCall);

        if !tools.is_empty() && !tools_declared {
            return Err(RegistrationError::UndeclaredTools {
                plugin_id: plugin_id(),
            });
        }

        if !tools.is_empty()
            && !manifest
                .requested_access()
                .grants(AccessName::ModelInput, AccessLevel::Write)
        {
            return Err(RegistrationError::ModelInputRequired {
                plugin_id: plugin_id(),
            });
        }

        Ok(Self {
            manifest: Arc::new(manifest),
            plugin,
            tools,
        })
    }

    #[must_use]
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    #[must_use]
    pub fn plugin(&self) -> &Arc<dyn RuntimePlugin> {
        &self.plugin
    }

    /// The tools as they were checked when the plugin registered. The
    /// plugin is not asked again, so no later answer escapes the check.
    #[must_use]
    pub fn tools(&self) -> &[ProvidedTool] {
        &self.tools
    }
}

/// What a plugin's factory is given: its manifest, and what that
/// manifest's own config section resolves to.
#[derive(Clone, Debug)]
pub struct FactoryInput<'a> {
    manifest: &'a Manifest,
    config: ResolvedConfig,
}

impl<'a> FactoryInput<'a> {
    /// The input for `manifest`'s plugin, its config resolved against the
    /// manifest's section from `authored`, the values the settings set for
    /// it, so a plugin is never handed another's.
    #[must_use]
    pub fn new(manifest: &'a Manifest, authored: &Map<String, Value>) -> Self {
        Self {
            manifest,
            config: ResolvedConfig::resolve(manifest.config(), authored),
        }
    }

    #[must_use]
    pub fn manifest(&self) -> &'a Manifest {
        self.manifest
    }

    /// The plugin's config with every default applied, so a plugin keeps no
    /// fallback of its own.
    #[must_use]
    pub fn config(&self) -> &ResolvedConfig {
        &self.config
    }
}

/// Builds one instance of a plugin.
pub type PluginFactory = fn(&FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError>;

/// Whether a plugin's config is enough to build it, answered by the code
/// its factory builds it with; while it is not, the sentence says what to
/// fill in, in the words of the settings page.
pub type SetupCheck = fn(&ResolvedConfig) -> Result<(), String>;

#[cfg(test)]
mod tests {
    use std::sync::OnceLock;

    use p02_core::{
        CharacterProfile, EventId, EventIdentity, SessionId, SpeakerName, Timestamp, TraceId,
    };
    use serde_json::json;
    use tokio::time::Instant;
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::context::TurnIdentity;
    use crate::schema::ToolInputContract;
    use crate::tool::ToolCallId;
    use crate::vocabulary::ToolConcurrency;

    #[derive(Debug)]
    struct Toolbox {
        tools: Vec<ProvidedTool>,
    }

    #[async_trait]
    impl RuntimePlugin for Toolbox {
        fn provided_tools(&self) -> &[ProvidedTool] {
            &self.tools
        }
    }

    fn manifest(declared: &Value, requested_access: &Value) -> Manifest {
        Manifest::from_value(&json!({
            "id": "toolbox",
            "displayName": "Toolbox",
            "version": "1.0.0",
            "kind": "tool_provider",
            "description": "A test plugin.",
            "contractVersion": "mvp-008.runtime_plugin.v2",
            "declaredPlugins": declared,
            "config": {"scope": "global_with_character_overrides", "fields": []},
            "runtimePolicy": {
                "timeoutMs": 1000,
                "redactionLabels": [],
                "failureBehavior": {
                    "beforeRoleModelCall": "degrade",
                    "handleToolCall": "reject_tool_call",
                },
            },
            "activation": {"defaultEnabled": false, "reasons": ["test"]},
            "requestedAccess": requested_access,
        }))
        .unwrap()
    }

    fn search_tool() -> ProvidedTool {
        ProvidedTool::new(
            Identifier::new("notes.search").unwrap(),
            "Search notes.",
            ToolInputContract::new(json!({"type": "object"})).unwrap(),
        )
        .unwrap()
        .with_concurrency(ToolConcurrency::Shared)
    }

    fn toolbox(tools: Vec<ProvidedTool>) -> Arc<dyn RuntimePlugin> {
        Arc::new(Toolbox { tools })
    }

    #[test]
    fn a_plugin_is_refused_when_its_tools_contradict_its_manifest() {
        let declared = json!(["tool_provider", "handle_tool_call"]);
        let model_input = json!({"model_input": "write"});
        let toolbox_id = Identifier::new("toolbox").unwrap();
        let cases = [
            (
                manifest(&json!(["handle_tool_call"]), &model_input),
                vec![search_tool()],
                RegistrationError::UndeclaredTools {
                    plugin_id: toolbox_id.clone(),
                },
            ),
            (
                manifest(&json!(["tool_provider"]), &model_input),
                vec![search_tool()],
                RegistrationError::UndeclaredTools {
                    plugin_id: toolbox_id.clone(),
                },
            ),
            (
                manifest(&declared, &json!({})),
                vec![search_tool()],
                RegistrationError::ModelInputRequired {
                    plugin_id: toolbox_id,
                },
            ),
        ];

        for (manifest, tools, refusal) in cases {
            assert_eq!(
                Registration::new(manifest, toolbox(tools)).unwrap_err(),
                refusal
            );
        }
    }

    #[test]
    fn a_plugin_built_by_its_factory_registers_with_its_tools() {
        #[expect(
            clippy::unnecessary_wraps,
            reason = "a factory's signature is the contract's, whether or not it can fail"
        )]
        fn create(input: &FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
            assert_eq!(input.config().value("tone"), None);

            Ok(toolbox(vec![search_tool()]))
        }

        const FACTORY: PluginFactory = create;

        let manifest = manifest(
            &json!(["tool_provider", "handle_tool_call"]),
            &json!({"model_input": "write"}),
        );
        let plugin = FACTORY(&FactoryInput::new(&manifest, &Map::new())).unwrap();
        let registration = Registration::new(manifest, plugin).unwrap();

        assert_eq!(registration.manifest().id().as_str(), "toolbox");
        assert_eq!(registration.tools(), [search_tool()]);
    }

    #[test]
    fn tools_a_plugin_provides_after_it_registered_are_never_offered() {
        #[derive(Debug)]
        struct Lazy {
            tools: OnceLock<Vec<ProvidedTool>>,
        }

        #[async_trait]
        impl RuntimePlugin for Lazy {
            fn provided_tools(&self) -> &[ProvidedTool] {
                self.tools.get().map_or(&[], Vec::as_slice)
            }
        }

        let plugin = Arc::new(Lazy {
            tools: OnceLock::new(),
        });
        let registration = Registration::new(
            manifest(&json!(["on_shutdown"]), &json!({})),
            plugin.clone(),
        )
        .unwrap();

        plugin.tools.set(vec![search_tool()]).unwrap();

        assert_eq!(registration.tools(), []);
    }

    #[tokio::test]
    async fn a_declared_hook_the_plugin_leaves_out_fails() {
        let context = HookContext::new(
            Identifier::new("toolbox").unwrap(),
            Some(Arc::new(TurnIdentity {
                session_id: SessionId::parse("chat.1").unwrap(),
                event: EventIdentity::new(
                    EventId::new("evt_1").unwrap(),
                    TraceId::new("trace_1").unwrap(),
                    Timestamp::new("2026-06-15T00:00:00.000Z").unwrap(),
                )
                .unwrap(),
                character: CharacterProfile {
                    id: Identifier::new("mira").unwrap(),
                    display_name: SpeakerName::new("Mira").unwrap(),
                },
                person: None,
            })),
            Instant::now(),
            CancellationToken::new(),
        );
        let plugin = toolbox(Vec::new());

        assert_eq!(
            plugin
                .before_role_model_call(&context)
                .await
                .unwrap_err()
                .to_string(),
            "beforeRoleModelCall is declared but not implemented"
        );
        assert_eq!(
            plugin.on_shutdown(&context).await.unwrap_err().to_string(),
            "onShutdown is declared but not implemented"
        );

        let call = ToolCall::new(
            ToolCallId::new("call-1").unwrap(),
            &search_tool(),
            Map::new(),
        )
        .unwrap();

        assert_eq!(
            plugin
                .prepare_tool_call(&call, &context)
                .await
                .unwrap_err()
                .to_string(),
            "handleToolCall is declared, but the plugin prepares no approval-gated call"
        );
    }
}
