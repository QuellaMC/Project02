/**
 * Live-apply seam for committed plugin config effects: after an approved
 * update commits, fields that declared reloadRequired: false get their
 * plugin instance rebuilt by the composition-root reloader and swapped
 * into the running host, so the next turn reflects the change. Reload
 * problems never fail a committed turn; they surface as degraded or
 * failed evidence and the old instance keeps serving.
 */
import {
  createRuntimePluginEvidenceSnapshot,
  registeredRuntimePluginLifecycleHooks,
  runtimePluginId,
} from '../api/index.ts';
import type {
  PreparedRuntimePluginConfigEffect,
  RuntimePlugin,
  RuntimePluginEvidenceSnapshot,
} from '../api/index.ts';
import {canonicalJsonValuesEqual} from '../../shared/canonical-json.ts';
import type {RuntimePluginConfigControlHostState} from '../builtin/plugin-management/index.ts';

export type RuntimePluginReloadResult =
  | {readonly status: 'rebuilt'; readonly plugin: RuntimePlugin}
  | {readonly status: 'declined'; readonly reason: string}
  | {readonly status: 'failed'; readonly message: string};

/**
 * Injected by the composition root (the host must not import config
 * resolution or the package catalog): rebuilds one plugin instance from
 * freshly resolved config, declines ids it cannot rebuild.
 */
export type RuntimePluginReloader = {
  reload(
    pluginId: string,
    options: {
      /** Authored-config fingerprint the approved effect produced; the reloader declines when the file has moved past it. */
      readonly expectedFingerprint: string;
    },
  ): Promise<RuntimePluginReloadResult>;
};

export type RuntimePluginConfigReloadHostResult = {
  readonly outcome: 'live_applied' | 'deferred' | 'failed' | 'not_eligible';
  readonly evidence?: RuntimePluginEvidenceSnapshot;
  readonly failure?: string;
};

export async function reloadRuntimePluginForCommittedConfig(options: {
  readonly effects: readonly PreparedRuntimePluginConfigEffect[];
  readonly reloader: RuntimePluginReloader | undefined;
  readonly pluginConfigControl: RuntimePluginConfigControlHostState | undefined;
  readonly livePlugins: () => readonly RuntimePlugin[];
  readonly swapEnabledPlugin: (
    next: RuntimePlugin,
  ) => RuntimePlugin | undefined;
  /** Retains an instance that will never serve so it still receives terminal lifecycle hooks. */
  readonly retirePlugin: (plugin: RuntimePlugin) => void;
}): Promise<RuntimePluginConfigReloadHostResult> {
  const [firstEffect] = options.effects;

  if (firstEffect === undefined) {
    return {outcome: 'not_eligible'};
  }

  const pluginId = firstEffect.targetPluginId;

  if (options.effects.some(effect => effect.targetPluginId !== pluginId)) {
    throw new TypeError(
      'Runtime plugin config reload requires effects for a single plugin.',
    );
  }

  const manifest = options.pluginConfigControl?.pluginManifests.find(
    candidate => candidate.id === pluginId,
  );
  const liveFieldNames: string[] = [];
  let sessionScopedFieldSeen = false;

  for (const effect of options.effects) {
    const field = manifest?.config.fields.find(
      candidate => candidate.name === effect.fieldName,
    );

    if (field?.reloadRequired === false) {
      liveFieldNames.push(field.name);
    } else {
      sessionScopedFieldSeen = true;
    }
  }

  if (liveFieldNames.length === 0) {
    // Entirely session-scoped: the documented norm, no evidence needed —
    // the update tool already reported appliesTo: future_host_construction.
    return {outcome: 'not_eligible'};
  }

  if (sessionScopedFieldSeen) {
    return deferred(
      options.effects,
      pluginId,
      'the committed effects mix live and reload-required fields',
    );
  }

  if (options.reloader === undefined) {
    return deferred(
      options.effects,
      pluginId,
      'this host has no plugin reloader',
    );
  }

  const previous = options
    .livePlugins()
    .find(plugin => plugin.manifest.id === pluginId);

  if (previous === undefined) {
    return deferred(options.effects, pluginId, 'the plugin is not enabled');
  }

  let reloaded: RuntimePluginReloadResult;

  try {
    const finalEffect = options.effects[options.effects.length - 1];

    reloaded = await options.reloader.reload(pluginId, {
      // Effects arrive in apply order; the file ends at the LAST effect's
      // fingerprint, so grouped updates must verify against that one.
      expectedFingerprint: (finalEffect ?? firstEffect).resultFingerprint,
    });
  } catch (error: unknown) {
    reloaded = {
      status: 'failed',
      message: error instanceof Error ? error.message : 'Plugin reload failed.',
    };
  }

  if (reloaded.status === 'declined') {
    return deferred(options.effects, pluginId, reloaded.reason);
  }

  if (reloaded.status === 'failed') {
    const failure = `Live config reload for plugin "${pluginId}" failed; the previous instance keeps serving: ${reloaded.message}`;

    return {
      outcome: 'failed',
      failure,
      evidence: reloadEvidence(options.effects, 'failed', failure),
    };
  }

  if (rebuiltPluginChangesFrozenSurface(previous, reloaded.plugin)) {
    // The rebuilt instance may already hold factory-allocated resources, so
    // it is retired (not dropped) even though it never serves a dispatch.
    options.retirePlugin(reloaded.plugin);
    return deferred(
      options.effects,
      pluginId,
      'the rebuilt plugin changed its manifest, hook, or tool surface',
    );
  }

  if (options.swapEnabledPlugin(reloaded.plugin) === undefined) {
    options.retirePlugin(reloaded.plugin);
    return deferred(options.effects, pluginId, 'the plugin left the host');
  }

  return {
    outcome: 'live_applied',
    evidence: reloadEvidence(
      options.effects,
      'accepted',
      `Live-applied committed config for plugin "${pluginId}" by rebuilding its instance (fields: ${liveFieldNames.join(', ')}).`,
    ),
  };
}

/**
 * The runtime surface advertised at construction stays frozen across a swap:
 * manifest, provided tools, AND which lifecycle hooks are registered — a
 * rebuild that drops handleToolCall would strand advertised tools, and one
 * that adds hooks would dispatch behavior the host never advertised.
 */
function rebuiltPluginChangesFrozenSurface(
  previous: RuntimePlugin,
  rebuilt: RuntimePlugin,
): boolean {
  return (
    !canonicalJsonValuesEqual(rebuilt.manifest, previous.manifest) ||
    !canonicalJsonValuesEqual(rebuilt.providedTools, previous.providedTools) ||
    !canonicalJsonValuesEqual(
      registeredRuntimePluginLifecycleHooks(rebuilt),
      registeredRuntimePluginLifecycleHooks(previous),
    )
  );
}

function deferred(
  effects: readonly PreparedRuntimePluginConfigEffect[],
  pluginId: string,
  reason: string,
): RuntimePluginConfigReloadHostResult {
  return {
    outcome: 'deferred',
    evidence: reloadEvidence(
      effects,
      'degraded',
      `Committed config for plugin "${pluginId}" applies at the next host construction instead of live: ${reason}.`,
    ),
  };
}

function reloadEvidence(
  effects: readonly PreparedRuntimePluginConfigEffect[],
  status: 'accepted' | 'degraded' | 'failed',
  summary: string,
): RuntimePluginEvidenceSnapshot {
  const [firstEffect] = effects;
  const finalEffect = effects[effects.length - 1];

  if (firstEffect === undefined || finalEffect === undefined) {
    throw new TypeError('Runtime plugin reload evidence requires effects.');
  }

  return createRuntimePluginEvidenceSnapshot({
    eventId: firstEffect.eventId,
    traceId: firstEffect.traceId,
    createdAt: firstEffect.createdAt,
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: runtimePluginId,
    evidenceKind: 'after_turn_committed',
    status,
    summary,
    sourceReferences: effects.map(effect => ({
      kind: 'runtime',
      id: effect.effectId,
    })),
    redactionLabels: [],
    // Effects arrive in apply order, so the authored file the reload saw (or
    // deferred on) is the LAST effect's fingerprint, not the first.
    configFingerprint: finalEffect.resultFingerprint,
  });
}
