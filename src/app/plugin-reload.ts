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
  characterDataRootForResolvedConfig,
  createRuntimeConfigMutationBase,
  diagnosticsHaveErrors,
  layeredRuntimeConfigFingerprintForScope,
  loadCharacterOverlayForScope,
  loadProject02RuntimeConfig,
  resolveLayeredProject02RuntimeConfig,
  runtimeConfigDiagnosticMatchesPlugin,
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

      // Both authored files back the currency gate: the global config
      // and, when the plan carries a character scope, that character's
      // overlay. Re-read together so an overlay edit between approval
      // and rebuild declines exactly like a global edit.
      const loadAuthoredState = () => {
        const loaded = loadProject02RuntimeConfig({
          ...(pluginConfigControl.configPath === undefined
            ? {}
            : {configPath: pluginConfigControl.configPath}),
          // Omitted env falls back to process.env inside the loader, the
          // same default the inspection/approval path used — forcing {}
          // here would strand $env secrets that approval already resolved.
          ...(pluginConfigControl.env === undefined
            ? {}
            : {env: pluginConfigControl.env}),
          storeRoot: resolvedConfig.project02.storeRoot,
        });

        return {
          loaded,
          overlay:
            pluginConfigControl.characterScope === undefined
              ? undefined
              : loadCharacterOverlayForScope(
                  pluginConfigControl.characterScope,
                ),
        };
      };
      const authoredFingerprintOf = (
        state: ReturnType<typeof loadAuthoredState>,
      ) =>
        layeredRuntimeConfigFingerprintForScope({
          globalConfig: createRuntimeConfigMutationBase({
            loadedConfig: state.loaded,
            ...(pluginConfigControl.configPath === undefined
              ? {}
              : {configPath: pluginConfigControl.configPath}),
            storeRoot: resolvedConfig.project02.storeRoot,
          }),
          characterScope: pluginConfigControl.characterScope,
          overlay: state.overlay,
        });
      const authoredState = loadAuthoredState();
      const authoredFingerprint = authoredFingerprintOf(authoredState);

      if (authoredFingerprint !== reloadOptions.expectedFingerprint) {
        return {
          status: 'declined',
          reason: `the authored config moved past the approved update for plugin "${pluginId}"`,
        };
      }
      const freshResolvedConfig = resolveLayeredProject02RuntimeConfig({
        loadedConfig: authoredState.loaded,
        ...(authoredState.overlay === undefined
          ? {}
          : {overlayConfig: authoredState.overlay}),
        storeRoot: resolvedConfig.project02.storeRoot,
        pluginManifests,
        defaultEnabledPluginIds,
        ...(pluginConfigControl.env === undefined
          ? {}
          : {env: pluginConfigControl.env}),
      });

      // Mirror the update tool's inspection scope: only global diagnostics
      // or errors for THIS plugin block its rebuild. Another plugin's bad
      // config must not strand a valid live target whose update was already
      // promised for the next turn.
      const blockingDiagnostics = freshResolvedConfig.diagnostics.filter(
        diagnostic =>
          diagnostic.scope === 'global' ||
          runtimeConfigDiagnosticMatchesPlugin({diagnostic, pluginId}),
      );

      if (diagnosticsHaveErrors(blockingDiagnostics)) {
        return {
          status: 'declined',
          reason: `the refreshed config for plugin "${pluginId}" has errors`,
        };
      }

      const plugin = await entry.load({
        pluginId: entry.manifest.id,
        manifest: entry.manifest,
        storeRoot: characterDataRootForResolvedConfig(freshResolvedConfig),
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

      // The factory await is a real window: another writer may have moved
      // the authored config while it ran, and swapping in an instance built
      // from the older snapshot would silently serve stale config. Re-check
      // after the load, exactly like the pre-load check.
      if (
        authoredFingerprintOf(loadAuthoredState()) !==
        reloadOptions.expectedFingerprint
      ) {
        return {
          status: 'declined',
          reason: `the authored config for plugin "${pluginId}" moved while the factory was rebuilding`,
          plugin,
        };
      }

      return {status: 'rebuilt', plugin};
    },
  });
}
