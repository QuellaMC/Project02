/**
 * Composition-root implementation of the runtime plugin reloader: after a
 * committed config effect, re-resolves config from the plan's location and
 * re-runs the package factory for one plugin id. The host must not import
 * config resolution or the catalog, so this capability is injected at
 * host construction (same inversion as fileStore and config control).
 */
import {ownJsonRecordValue} from '../shared/json-boundary.ts';
import {
  createRuntimeConfigAuthoredSnapshot,
  diagnosticsHaveErrors,
  layeredRuntimeConfigFingerprintForScope,
  loadProject02RuntimeConfigForLocation,
  readCharacterOverlayForScope,
  resolveLayeredProject02RuntimeConfig,
  runtimeConfigDiagnosticMatchesPlugin,
  type ResolvedProject02RuntimeLocation,
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
    readonly runtimeLocation: ResolvedProject02RuntimeLocation;
    readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  };
}): RuntimePluginReloader {
  const {catalogEntries, pluginConfigControl, runtimeLocation} =
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
        const loaded = loadProject02RuntimeConfigForLocation(runtimeLocation);

        return {
          loaded,
          runtimeLocation,
          // A running host owns one activated character location. Config
          // edits that change the future home or default character take
          // effect only when a fresh host is constructed.
          overlay: readCharacterOverlayForScope(runtimeLocation.characterScope)
            .overlay,
        };
      };
      const authoredFingerprintOf = (
        state: ReturnType<typeof loadAuthoredState>,
      ) =>
        layeredRuntimeConfigFingerprintForScope({
          globalConfig: createRuntimeConfigAuthoredSnapshot(state.loaded)
            .document,
          characterScope: state.runtimeLocation.characterScope,
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
        runtimeLocation: authoredState.runtimeLocation,
        overlayConfig: authoredState.overlay,
        pluginManifests,
        defaultEnabledPluginIds,
        env: pluginConfigControl.configControl.target.env,
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

      const plugin = await entry.load(
        {
          pluginId: entry.manifest.id,
          manifest: entry.manifest,
          storeRoot: authoredState.runtimeLocation.characterScope.dataRoot,
          resolvedConfig:
            ownJsonRecordValue(freshResolvedConfig.pluginConfigs, pluginId) ??
            {},
          redactedConfig:
            ownJsonRecordValue(
              freshResolvedConfig.redactedPluginConfigs,
              pluginId,
            ) ?? {},
        },
        {retainRejectedCandidate: reloadOptions.retainCandidate},
      );

      // The host's retirement lifecycle becomes the sole owner as soon as a
      // package-accepted factory result exists. Any later authored-state read
      // may fail; a successful swap explicitly makes it live again. Package
      // rejection transfers its candidate through the load options above.
      reloadOptions.retainCandidate(plugin);

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
        };
      }

      return {status: 'rebuilt', plugin};
    },
  });
}
