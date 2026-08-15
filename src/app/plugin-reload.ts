/** The host must not import config resolution, so this is injected. */
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
import {
  installedRuntimePluginCatalogEntry,
  type RuntimePluginCatalogEntry,
  type RuntimePluginConfigControlHostState,
  type RuntimePluginReloader,
  type RuntimePluginReloadResult,
} from '../plugins/index.ts';
// Importing the plan type here would cycle with app/activation.
export function createConfiguredRuntimePluginReloader(options: {
  readonly activationPlan: {
    readonly catalogEntries: Readonly<
      Record<string, RuntimePluginCatalogEntry>
    >;
    readonly pluginConfigControl: RuntimePluginConfigControlHostState;
    readonly runtimeLocation: ResolvedProject02RuntimeLocation;
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
      const entry = installedRuntimePluginCatalogEntry(
        catalogEntries,
        pluginId,
      );

      if (entry === undefined || entry.catalogKind !== 'package') {
        return {
          status: 'declined',
          reason: `plugin "${pluginId}" has no reloadable package factory`,
        };
      }

      // Re-read together so an overlay edit declines like a global one.
      const loadAuthoredState = () => {
        const loaded = loadProject02RuntimeConfigForLocation(runtimeLocation);

        return {
          loaded,
          runtimeLocation,
          // A home or character change takes effect only in a fresh host.
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
          pluginManifests,
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

      // Another plugin's bad config must not strand this rebuild.
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
          characterId: authoredState.runtimeLocation.characterScope.characterId,
          userDisplayName: freshResolvedConfig.project02.userDisplayName,
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

      // Hand ownership over now, so a later failure cannot leak the plugin.
      reloadOptions.retainCandidate(plugin);

      // Another writer may have moved the config during the factory await.
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
