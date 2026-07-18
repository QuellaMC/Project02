import type { RuntimeEventIdentity } from '../../core/index.ts';
import {
  createRuntimePluginTurnEvidenceSnapshot,
  runtimePluginContractVersion,
  type RuntimePluginContextItem,
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginHealthSnapshot,
  type RuntimePluginRegistrySnapshot,
  type RuntimePluginToolInvocationSnapshot,
  type RuntimePluginTurnEvidenceSnapshot
} from '../../plugins/api/index.ts';

export function runtimePluginEvidenceOption(
  evidence: readonly RuntimePluginEvidenceSnapshot[] | undefined
): { readonly runtimePluginEvidence?: readonly RuntimePluginEvidenceSnapshot[] } {
  if (evidence === undefined || evidence.length === 0) {
    return {};
  }

  return {
    runtimePluginEvidence: Object.freeze([...evidence])
  };
}

// Structural view of the plugin host limited to what turn evidence needs.
// Importing the host implementation here would re-create the
// runtime <-> plugins import cycle.
type RuntimePluginRegistryView = {
  registrySnapshot(): RuntimePluginRegistrySnapshot;
  enabledPluginIds(): readonly string[];
};

export function runtimePluginTurnEvidenceOption(options: {
  readonly identity: RuntimeEventIdentity;
  readonly pluginHost: RuntimePluginRegistryView | undefined;
  readonly contextItems: readonly RuntimePluginContextItem[];
  readonly toolInvocations: readonly RuntimePluginToolInvocationSnapshot[];
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
  readonly health: readonly RuntimePluginHealthSnapshot[];
}): { readonly runtimePluginTurnEvidence?: RuntimePluginTurnEvidenceSnapshot } {
  if (options.pluginHost === undefined) {
    return {};
  }

  const registry = options.pluginHost.registrySnapshot();
  const enabledPluginIds = new Set(options.pluginHost.enabledPluginIds());
  const healthStatuses = new Map(
    options.health.map((snapshot) => [snapshot.pluginId, snapshot.status])
  );

  return {
    runtimePluginTurnEvidence: createRuntimePluginTurnEvidenceSnapshot({
      ...options.identity,
      kind: 'runtime_plugin_turn_evidence_snapshot',
      contractVersion: runtimePluginContractVersion,
      plugins: registry.plugins.map((registration) => {
        const enabled = enabledPluginIds.has(registration.manifest.id);
        const healthStatus = healthStatuses.get(registration.manifest.id);

        return {
          pluginId: registration.manifest.id,
          manifest: registration.manifest,
          providedTools: registration.providedTools,
          registeredLifecycleHooks: registration.registeredLifecycleHooks,
          installed: true,
          registered: true,
          enabled,
          availableForTurn: enabled,
          redactionLabels: registration.manifest.runtimePolicy.redactionLabels,
          requestedAccess: registration.requestedAccess,
          grantedAccess: registration.grantedAccess,
          ...(healthStatus === undefined ? {} : { healthStatus }),
          ...(registration.manifest.config.fingerprint === undefined
            ? {}
            : { configFingerprint: registration.manifest.config.fingerprint })
        };
      }),
      contextItems: options.contextItems,
      toolInvocations: options.toolInvocations,
      evidence: options.evidence,
      health: options.health
    })
  };
}
