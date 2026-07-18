/**
 * Composition-root implementation of the runtime plugin reloader: after a
 * committed config effect, re-resolves config from the plan's location and
 * re-runs the package factory for one plugin id. The host must not import
 * config resolution or the catalog, so this capability is injected at
 * host construction (same inversion as fileStore and config control).
 */
import {ownJsonRecordValue} from '../shared/json-boundary.ts';
import {canonicalJsonValuesEqual} from '../shared/canonical-json.ts';
import {
  createRuntimeConfigFingerprint,
  createRuntimeConfigMutationBase,
  diagnosticsHaveErrors,
  loadProject02RuntimeConfig,
  pluginHasConfigErrors,
  resolveProject02RuntimeConfig,
} from '../runtime/config/index.ts';
import type {
  RuntimePluginCatalogEntry,
  RuntimePluginConfigControlHostState,
  RuntimePluginReloader,
  RuntimePluginReloadResult,
} from '../plugins/index.ts';
import type {ResolvedProject02RuntimeConfig} from '../runtime/config/index.ts';

// Structural slice of PreparedProject02PluginActivationPlan: naming the
// plan type here would put app/activation and this file on a cycle.
export function createConfiguredRuntimePluginReloader(options: {
  readonly activationPlan: {
    readonly catalogEntries: Readonly<
      Record<string, RuntimePluginCatalogEntry>
    >;
    readonly pluginConfigControl: RuntimePluginConfigControlHostState;
    readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  };
}): RuntimePluginReloader {
  const {catalogEntries, pluginConfigControl, resolvedConfig} =
    options.activationPlan;
  const pluginManifests = Object.values(catalogEntries).map(
    entry => entry.manifest,
  );
  const defaultEnabledPluginIds = new Set(
    pluginConfigControl.defaultEnabledPluginIds ?? [],
  );

  return Object.freeze({
    async reload(pluginId, reloadOptions): Promise<RuntimePluginReloadResult> {
      const entry = catalogEntries[pluginId];

      if (entry === undefined || entry.catalogKind !== 'package') {
        return {
          status: 'declined',
          reason: `plugin "${pluginId}" has no reloadable package factory`,
        };
      }

      const loadedConfig = loadProject02RuntimeConfig({
        ...(pluginConfigControl.configPath === undefined
          ? {}
          : {configPath: pluginConfigControl.configPath}),
        env: pluginConfigControl.env ?? {},
        storeRoot: resolvedConfig.project02.storeRoot,
      });
      const authoredFingerprint = createRuntimeConfigFingerprint(
        createRuntimeConfigMutationBase({
          loadedConfig,
          ...(pluginConfigControl.configPath === undefined
            ? {}
            : {configPath: pluginConfigControl.configPath}),
          storeRoot: resolvedConfig.project02.storeRoot,
        }),
      );

      if (authoredFingerprint !== reloadOptions.expectedFingerprint) {
        return {
          status: 'declined',
          reason: `the authored config moved past the approved update for plugin "${pluginId}"`,
        };
      }
      const freshResolvedConfig = resolveProject02RuntimeConfig({
        loadedConfig,
        storeRoot: resolvedConfig.project02.storeRoot,
        pluginManifests,
        defaultEnabledPluginIds,
        ...(pluginConfigControl.env === undefined
          ? {}
          : {env: pluginConfigControl.env}),
      });

      if (
        diagnosticsHaveErrors(freshResolvedConfig.diagnostics) ||
        pluginHasConfigErrors({
          diagnostics: freshResolvedConfig.diagnostics,
          pluginId,
        })
      ) {
        return {
          status: 'declined',
          reason: `the refreshed config for plugin "${pluginId}" has errors`,
        };
      }

      const plugin = await entry.load({
        pluginId: entry.manifest.id,
        manifest: entry.manifest,
        storeRoot: freshResolvedConfig.project02.storeRoot,
        resolvedConfig:
          ownJsonRecordValue(freshResolvedConfig.pluginConfigs, pluginId) ?? {},
        redactedConfig:
          ownJsonRecordValue(
            freshResolvedConfig.redactedPluginConfigs,
            pluginId,
          ) ?? {},
      });

      if (plugin.manifest.id !== entry.manifest.id) {
        // An id-drifted instance cannot be handed back for retirement:
        // terminal dispatch would resolve access by its own (wrong) id.
        // The factory violated the id contract; declining without the
        // instance is the only safe disposal.
        return {
          status: 'declined',
          reason: `the rebuilt plugin "${pluginId}" returned a different plugin id`,
        };
      }

      if (!canonicalJsonValuesEqual(plugin.manifest, entry.manifest)) {
        return {
          status: 'declined',
          reason: `the rebuilt plugin "${pluginId}" no longer matches its declared manifest`,
          // The factory already ran: hand the instance back so the host
          // retires it into the terminal-lifecycle list instead of leaking
          // whatever the factory allocated.
          plugin,
        };
      }

      return {status: 'rebuilt', plugin};
    },
  });
}
