use std::fmt;
use std::sync::{Arc, PoisonError, RwLock};

use p02_contracts::{
    CharacterStorage, DatabaseOpener, Declaration, DuplicateToolError, FactoryInput,
    FileStoreBackend, Manifest, PluginError, PluginToolDefinition, PluginToolDefinitions,
    ProvidedTool, Registration, RegistrationError, ResolvedConfig, RuntimePlugin,
    SessionHistoryFeed, StoreAccess,
};
use p02_shared::Identifier;

use crate::boundary::{RecordLabelsError, within_label_allowance};
use crate::confirmation::Confirmer;
use crate::lifecycle::{HookPhaseReport, Lifecycle};
use crate::policy;
use crate::turn::Turn;

/// Builds an instance of a plugin from its manifest and resolved config: a
/// plugin's `create`, or any function of its shape.
type Factory =
    dyn Fn(&FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError> + Send + Sync;

/// Runs the plugins one character enables, in the order they were given:
/// each hook under its plugin's budget and failure policy, each tool call
/// by its tool's concurrency, and everything a plugin returns through the
/// output boundary before the model or the log sees it. A plugin its
/// character leaves disabled is never given to the host.
pub struct PluginHost {
    core: Arc<Core>,
}

/// The plugins a character enables, and what the host serves them with.
pub struct PluginHostBuilder {
    storage: Arc<dyn CharacterStorage>,
    plugins: Vec<Setup>,
    confirmer: Option<Arc<dyn Confirmer>>,
}

struct Setup {
    manifest: Manifest,
    config: ResolvedConfig,
    factory: Box<Factory>,
}

pub(crate) struct Core {
    pub(crate) slots: Vec<Slot>,
    /// Every tool of every enabled plugin, by which a call is routed.
    tools: PluginToolDefinitions,
    offered: PluginToolDefinitions,
    pub(crate) confirmer: Option<Arc<dyn Confirmer>>,
}

/// One enabled plugin: its manifest, how to build it again, the tools it
/// was activated with, the instance serving now, and the handles its
/// grants reach.
pub(crate) struct Slot {
    pub(crate) manifest: Manifest,
    factory: Box<Factory>,
    /// The tools checked at activation, which the model is offered; a
    /// rebuilt instance must provide the same.
    tools: Vec<ProvidedTool>,
    live: RwLock<Arc<dyn RuntimePlugin>>,
    pub(crate) capabilities: Capabilities,
}

pub(crate) struct Capabilities {
    pub(crate) turn_text: bool,
    pub(crate) file_store: Option<(Arc<dyn FileStoreBackend>, StoreAccess)>,
    pub(crate) session_history: Option<Arc<dyn SessionHistoryFeed>>,
    pub(crate) databases: Option<Arc<dyn DatabaseOpener>>,
}

/// Why a set of plugins was refused at activation.
#[derive(Debug, thiserror::Error)]
pub enum ActivationError {
    #[error("plugin \"{0}\" is enabled twice")]
    DuplicatePlugin(Identifier),
    #[error("plugin \"{plugin_id}\" has redaction labels its records cannot carry")]
    RedactionLabels {
        plugin_id: Identifier,
        #[source]
        source: RecordLabelsError,
    },
    #[error("plugin \"{plugin_id}\" could not be built")]
    Build {
        plugin_id: Identifier,
        #[source]
        source: PluginError,
    },
    #[error(transparent)]
    Registration(RegistrationError),
    #[error(transparent)]
    DuplicateTool(DuplicateToolError),
}

/// Why a plugin was not rebuilt; the instance serving before serves on.
#[derive(Debug, thiserror::Error)]
pub enum ReloadError {
    #[error("plugin \"{0}\" is not enabled in this host")]
    NotEnabled(Identifier),
    #[error("plugin \"{plugin_id}\" could not be rebuilt")]
    Build {
        plugin_id: Identifier,
        #[source]
        source: PluginError,
    },
    #[error(transparent)]
    Registration(RegistrationError),
    #[error(
        "plugin \"{0}\" was rebuilt with other tools than the model is offered, so it serves on \
         as it was"
    )]
    ToolsChanged(Identifier),
}

impl PluginHost {
    #[must_use]
    pub fn builder(storage: Arc<dyn CharacterStorage>) -> PluginHostBuilder {
        PluginHostBuilder {
            storage,
            plugins: Vec::new(),
            confirmer: None,
        }
    }

    /// The enabled plugins, in the order their hooks run.
    pub fn plugin_ids(&self) -> impl Iterator<Item = &Identifier> {
        self.core.slots.iter().map(|slot| slot.manifest.id())
    }

    /// The plugin tools the model is offered, each name once.
    #[must_use]
    pub fn tool_definitions(&self) -> &PluginToolDefinitions {
        &self.core.offered
    }

    /// Builds the plugin again from its factory with `config`, and serves
    /// every later hook with the new instance. Hooks already running finish
    /// on the instance they started with, and nothing waits for them: the
    /// old instance ends when the last of them lets go of it.
    ///
    /// # Errors
    ///
    /// [`ReloadError`] when the plugin is not enabled here, its factory
    /// fails, the new instance contradicts its manifest, or it would offer
    /// other tools than the model was shown.
    pub fn reload(
        &self,
        plugin_id: &Identifier,
        config: &ResolvedConfig,
    ) -> Result<(), ReloadError> {
        let slot = self
            .core
            .slots
            .iter()
            .find(|slot| slot.manifest.id() == plugin_id)
            .ok_or_else(|| ReloadError::NotEnabled(plugin_id.clone()))?;
        let plugin =
            (slot.factory)(&FactoryInput::new(&slot.manifest, config)).map_err(|source| {
                ReloadError::Build {
                    plugin_id: plugin_id.clone(),
                    source,
                }
            })?;
        let registration =
            Registration::new(slot.manifest.clone(), plugin).map_err(ReloadError::Registration)?;

        if registration.tools() != slot.tools.as_slice() {
            return Err(ReloadError::ToolsChanged(plugin_id.clone()));
        }

        *slot.live.write().unwrap_or_else(PoisonError::into_inner) =
            Arc::clone(registration.plugin());
        Ok(())
    }

    /// Ends every plugin: each `onShutdown` runs only reading, its store
    /// read-only and no database open to it, and what failed is reported.
    /// Work a hook left running is not waited for; the host is gone
    /// afterwards, so nothing runs a hook again.
    pub async fn shutdown(self, turn: &Turn) -> HookPhaseReport {
        self.core.run_lifecycle(&Lifecycle::Shutdown, turn).await
    }

    pub(crate) fn core(&self) -> &Arc<Core> {
        &self.core
    }
}

impl PluginHostBuilder {
    /// Enables a plugin. Its hooks run after those of every plugin added
    /// before it.
    #[must_use]
    pub fn plugin(
        mut self,
        manifest: Manifest,
        config: ResolvedConfig,
        factory: impl Fn(&FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        self.plugins.push(Setup {
            manifest,
            config,
            factory: Box::new(factory),
        });
        self
    }

    /// Who asks the person before an approval-gated call takes effect.
    #[must_use]
    pub fn confirmer(mut self, confirmer: Arc<dyn Confirmer>) -> Self {
        self.confirmer = Some(confirmer);
        self
    }

    /// Builds every plugin and holds the set to the host's rules: one
    /// instance per plugin, each matching its manifest and with labels its
    /// records can carry, and each tool name offered to the model by one
    /// plugin alone.
    ///
    /// # Errors
    ///
    /// [`ActivationError`] for the first plugin enabled twice, with more
    /// labels than a record has room for, built in vain, or contradicting
    /// its manifest, or the first tool name two plugins provide.
    pub fn activate(self) -> Result<PluginHost, ActivationError> {
        let mut slots: Vec<Slot> = Vec::with_capacity(self.plugins.len());
        let mut definitions = Vec::new();

        for Setup {
            manifest,
            config,
            factory,
        } in self.plugins
        {
            let plugin_id = manifest.id().clone();

            if slots.iter().any(|slot| slot.manifest.id() == &plugin_id) {
                return Err(ActivationError::DuplicatePlugin(plugin_id));
            }

            within_label_allowance(manifest.runtime_policy().redaction_labels()).map_err(
                |source| ActivationError::RedactionLabels {
                    plugin_id: plugin_id.clone(),
                    source,
                },
            )?;

            let plugin = factory(&FactoryInput::new(&manifest, &config)).map_err(|source| {
                ActivationError::Build {
                    plugin_id: plugin_id.clone(),
                    source,
                }
            })?;
            let registration = Registration::new(manifest.clone(), plugin)
                .map_err(ActivationError::Registration)?;

            definitions.extend(
                registration
                    .tools()
                    .iter()
                    .map(|tool| PluginToolDefinition {
                        plugin_id: plugin_id.clone(),
                        tool: tool.clone(),
                    }),
            );
            slots.push(Slot {
                capabilities: Capabilities::reached(&manifest, self.storage.as_ref()),
                manifest,
                factory,
                tools: registration.tools().to_vec(),
                live: RwLock::new(Arc::clone(registration.plugin())),
            });
        }

        let tools =
            PluginToolDefinitions::new(definitions).map_err(ActivationError::DuplicateTool)?;
        let offered = policy::tools::offered(&tools, self.confirmer.is_some());

        Ok(PluginHost {
            core: Arc::new(Core {
                slots,
                tools,
                offered,
                confirmer: self.confirmer,
            }),
        })
    }
}

impl Core {
    pub(crate) fn declaring(&self, declaration: Declaration) -> impl Iterator<Item = &Slot> {
        self.slots
            .iter()
            .filter(move |slot| slot.manifest.declares(declaration))
    }

    /// The enabled plugin that provides the tool, and the tool.
    pub(crate) fn route(&self, tool_name: &str) -> Option<(&Slot, &ProvidedTool)> {
        let definition = self.tools.get(tool_name)?;
        let slot = self
            .slots
            .iter()
            .find(|slot| slot.manifest.id() == &definition.plugin_id)?;

        Some((slot, &definition.tool))
    }
}

impl Slot {
    /// The instance serving now.
    pub(crate) fn live(&self) -> Arc<dyn RuntimePlugin> {
        Arc::clone(&self.live.read().unwrap_or_else(PoisonError::into_inner))
    }
}

impl Capabilities {
    fn reached(manifest: &Manifest, storage: &dyn CharacterStorage) -> Self {
        let grants = policy::access::grants(manifest.requested_access());
        let plugin_id = manifest.id();

        Self {
            turn_text: grants.turn_text,
            file_store: grants
                .file_store
                .map(|access| (storage.file_store(plugin_id), access)),
            session_history: grants.session_history.then(|| storage.session_history()),
            databases: grants.databases.then(|| storage.databases(plugin_id)),
        }
    }
}

impl fmt::Debug for PluginHost {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PluginHost")
            .field("plugins", &self.plugin_ids().collect::<Vec<_>>())
            .field("confirmer", &self.core.confirmer)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for PluginHostBuilder {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PluginHostBuilder")
            .field(
                "plugins",
                &self
                    .plugins
                    .iter()
                    .map(|setup| setup.manifest.id())
                    .collect::<Vec<_>>(),
            )
            .field("storage", &self.storage)
            .field("confirmer", &self.confirmer)
            .finish()
    }
}
