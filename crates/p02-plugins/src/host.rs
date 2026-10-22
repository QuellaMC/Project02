use std::fmt;
use std::sync::{Arc, OnceLock, PoisonError, RwLock, Weak};

use p02_contracts::{
    CharacterStorage, DatabaseOpener, Declaration, DuplicateToolError, FactoryInput,
    FileStoreBackend, HOST_PLUGIN, Manifest, MissingConfigValueError, PluginError,
    PluginToolDefinition, PluginToolDefinitions, ProvidedTool, Registration, RegistrationError,
    RuntimePlugin, SessionHistoryFeed, StoreAccess,
};
use p02_shared::Identifier;
use serde_json::{Map, Value};

use crate::boundary::{RecordLabelsError, within_label_allowance};
use crate::config_control::ConfigControl;
use crate::confirmation::Confirmer;
use crate::lifecycle::{HookPhaseReport, Lifecycle};
use crate::management;
use crate::policy;
use crate::turn::Turn;

/// Builds an instance of a plugin from its manifest and resolved config: a
/// plugin's `create`, or any function of its shape.
pub(crate) type Factory =
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
    config_control: Option<Arc<dyn ConfigControl>>,
}

/// A plugin as it is enabled: its manifest, the values its character's
/// settings give it by field name, and its factory.
struct Setup {
    manifest: Manifest,
    authored: Map<String, Value>,
    factory: Box<Factory>,
}

pub(crate) struct Core {
    pub(crate) slots: Vec<Slot>,
    /// The tools the model is offered, by which a call is routed.
    offered: PluginToolDefinitions,
    pub(crate) confirmer: Option<Arc<dyn Confirmer>>,
}

/// One enabled plugin: its manifest, how to build it again, the tools it
/// was activated with, the instance serving now, and the handles its
/// grants reach.
pub(crate) struct Slot {
    pub(crate) manifest: Manifest,
    factory: Box<Factory>,
    /// The tools checked at activation; a rebuilt instance must provide
    /// the same.
    tools: Vec<ProvidedTool>,
    live: RwLock<Serving>,
    pub(crate) capabilities: Capabilities,
}

/// The instance serving now, and the values it was built from.
struct Serving {
    plugin: Arc<dyn RuntimePlugin>,
    authored: Map<String, Value>,
}

pub(crate) struct Capabilities {
    pub(crate) turn_text: bool,
    pub(crate) file_store: Option<(Arc<dyn FileStoreBackend>, StoreAccess)>,
    pub(crate) session_history: Option<Arc<dyn SessionHistoryFeed>>,
    pub(crate) databases: Option<Arc<dyn DatabaseOpener>>,
}

/// A call the host routes: the plugin that offers the tool, the tool, and,
/// for a tool that asks first, who asks the person.
pub(crate) struct Route<'a> {
    pub(crate) slot: &'a Slot,
    pub(crate) tool: &'a ProvidedTool,
    pub(crate) asking: Option<&'a dyn Confirmer>,
}

/// The host its own plugin manages, once the host is built. It is held
/// weakly, since the host holds the plugin.
#[derive(Clone, Debug, Default)]
pub(crate) struct HostLink(Arc<OnceLock<Weak<Core>>>);

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
        source: BuildPluginError,
    },
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
        source: BuildPluginError,
    },
    #[error(
        "plugin \"{0}\" was rebuilt with other tools than the model is offered, so it serves on \
         as it was"
    )]
    ToolsChanged(Identifier),
}

/// Why a plugin gave the host no instance to serve: its settings leave a
/// required field without a value it accepts, its factory failed, or the
/// instance contradicts its manifest.
#[derive(Debug, thiserror::Error)]
pub enum BuildPluginError {
    #[error(transparent)]
    Config(#[from] MissingConfigValueError),
    #[error(transparent)]
    Factory(PluginError),
    #[error(transparent)]
    Registration(#[from] RegistrationError),
}

impl PluginHost {
    #[must_use]
    pub fn builder(storage: Arc<dyn CharacterStorage>) -> PluginHostBuilder {
        PluginHostBuilder {
            storage,
            plugins: Vec::new(),
            confirmer: None,
            config_control: None,
        }
    }

    /// The enabled plugins, in the order their hooks run.
    pub fn plugin_ids(&self) -> impl Iterator<Item = &Identifier> {
        self.core.slots.iter().map(|slot| slot.manifest.id())
    }

    /// The plugin tools the model is offered, each name once.
    #[must_use]
    pub fn tool_definitions(&self) -> &PluginToolDefinitions {
        self.core.offered()
    }

    /// Whether the host serves exactly `plugins`, each built from the values
    /// given beside it: a plugin rebuilt live serves the values it was
    /// rebuilt from.
    pub fn serves<'p>(
        &self,
        plugins: impl IntoIterator<Item = (&'p Identifier, &'p Map<String, Value>)>,
    ) -> bool {
        let mut named = 0;

        for (plugin_id, authored) in plugins {
            named += 1;

            let served = self
                .core
                .slots
                .iter()
                .find(|slot| slot.manifest.id() == plugin_id)
                .is_some_and(|slot| slot.serves(authored));

            if !served {
                return false;
            }
        }

        named == self.core.slots.len()
    }

    /// Builds the plugin again, as activation did, from `authored`, the
    /// values its character's settings now give it, and serves every later
    /// hook with the new instance. Hooks already running finish on the
    /// instance they started with, and nothing waits for them: the old
    /// instance ends when the last of them lets go of it.
    ///
    /// # Errors
    ///
    /// [`ReloadError`] when the plugin is not enabled here, cannot be
    /// built, or would offer other tools than the model was shown.
    pub fn reload(
        &self,
        plugin_id: &Identifier,
        authored: &Map<String, Value>,
    ) -> Result<(), ReloadError> {
        self.core.reload(plugin_id, authored)
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
    /// Enables a plugin, to be built from `manifest` and `authored`, the
    /// values its character's settings give it by field name. Its hooks run
    /// after those of every plugin added before it. The host's own plugin,
    /// `runtime.plugin`, the host builds itself, linked to it, whatever
    /// factory comes with it.
    #[must_use]
    pub fn plugin(
        mut self,
        manifest: Manifest,
        authored: Map<String, Value>,
        factory: impl Fn(&FactoryInput<'_>) -> Result<Arc<dyn RuntimePlugin>, PluginError>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        self.plugins.push(Setup {
            manifest,
            authored,
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

    /// Who reads and changes the settings of the character the host serves,
    /// for the config tools of the host's own plugin.
    #[must_use]
    pub fn config_control(mut self, control: Arc<dyn ConfigControl>) -> Self {
        self.config_control = Some(control);
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
    /// labels than a record has room for, or that cannot be built, or the
    /// first tool name two plugins provide.
    pub fn activate(self) -> Result<PluginHost, ActivationError> {
        let host = HostLink::default();
        let mut slots: Vec<Slot> = Vec::with_capacity(self.plugins.len());
        let mut definitions = Vec::new();

        for Setup {
            manifest,
            authored,
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

            let factory = if plugin_id.as_str() == HOST_PLUGIN {
                management::factory(&host, self.config_control.clone())
            } else {
                factory
            };
            let registration =
                build(&manifest, &authored, &factory).map_err(|source| ActivationError::Build {
                    plugin_id: plugin_id.clone(),
                    source,
                })?;

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
                live: RwLock::new(Serving {
                    plugin: Arc::clone(registration.plugin()),
                    authored,
                }),
            });
        }

        let tools =
            PluginToolDefinitions::new(definitions).map_err(ActivationError::DuplicateTool)?;
        let core = Arc::new(Core {
            slots,
            offered: policy::tools::offered(&tools, self.confirmer.is_some()),
            confirmer: self.confirmer,
        });

        host.attach(&core);
        Ok(PluginHost { core })
    }
}

/// Builds `manifest`'s plugin with its config resolved from `authored`
/// against that manifest, and checks the instance against it: the one way
/// a plugin is built, at activation and at a reload.
fn build(
    manifest: &Manifest,
    authored: &Map<String, Value>,
    factory: &Factory,
) -> Result<Registration, BuildPluginError> {
    let plugin =
        factory(&FactoryInput::new(manifest, authored)?).map_err(BuildPluginError::Factory)?;

    Ok(Registration::new(manifest.clone(), plugin)?)
}

impl Core {
    pub(crate) fn declaring(&self, declaration: Declaration) -> impl Iterator<Item = &Slot> {
        self.slots
            .iter()
            .filter(move |slot| slot.manifest.declares(declaration))
    }

    pub(crate) fn offered(&self) -> &PluginToolDefinitions {
        &self.offered
    }

    /// The tools the model is offered of plugin `plugin_id`.
    pub(crate) fn offered_by<'a>(
        &'a self,
        plugin_id: &'a Identifier,
    ) -> impl Iterator<Item = &'a ProvidedTool> {
        self.offered
            .definitions()
            .iter()
            .filter(move |definition| &definition.plugin_id == plugin_id)
            .map(|definition| &definition.tool)
    }

    /// Where a call of `tool_name` goes. A tool the model is not offered
    /// goes nowhere, whichever plugin provides it, as the turn never
    /// declared it.
    pub(crate) fn route(&self, tool_name: &str) -> Option<Route<'_>> {
        let definition = self.offered.get(tool_name)?;
        let slot = self
            .slots
            .iter()
            .find(|slot| slot.manifest.id() == &definition.plugin_id)?;
        let asking = if definition.tool.is_approval_gated() {
            Some(self.confirmer.as_deref()?)
        } else {
            None
        };

        Some(Route {
            slot,
            tool: &definition.tool,
            asking,
        })
    }

    pub(crate) fn reload(
        &self,
        plugin_id: &Identifier,
        authored: &Map<String, Value>,
    ) -> Result<(), ReloadError> {
        let slot = self
            .slots
            .iter()
            .find(|slot| slot.manifest.id() == plugin_id)
            .ok_or_else(|| ReloadError::NotEnabled(plugin_id.clone()))?;
        let registration = build(&slot.manifest, authored, &slot.factory).map_err(|source| {
            ReloadError::Build {
                plugin_id: plugin_id.clone(),
                source,
            }
        })?;

        if registration.tools() != slot.tools.as_slice() {
            return Err(ReloadError::ToolsChanged(plugin_id.clone()));
        }

        *slot.live.write().unwrap_or_else(PoisonError::into_inner) = Serving {
            plugin: Arc::clone(registration.plugin()),
            authored: authored.clone(),
        };
        Ok(())
    }
}

impl Slot {
    /// The instance serving now.
    pub(crate) fn live(&self) -> Arc<dyn RuntimePlugin> {
        Arc::clone(
            &self
                .live
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .plugin,
        )
    }

    fn serves(&self, authored: &Map<String, Value>) -> bool {
        self.live
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .authored
            == *authored
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

impl HostLink {
    fn attach(&self, core: &Arc<Core>) {
        // A link is attached once, by the activation that made it.
        let _ = self.0.set(Arc::downgrade(core));
    }

    /// The host, while it serves.
    pub(crate) fn core(&self) -> Result<Arc<Core>, PluginError> {
        self.0
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| PluginError::new("the plugin host this plugin manages has stopped"))
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
            .field("config_control", &self.config_control)
            .finish()
    }
}
