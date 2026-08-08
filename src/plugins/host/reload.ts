/** Reload problems never fail a committed turn; the old instance stays live. */
import {
  createRuntimePluginEvidenceSnapshot,
  registeredRuntimePluginLifecycleHooks,
  runtimePluginId,
} from '../api/index.ts';
import type {
  PreparedRuntimePluginConfigEffect,
  RuntimePlugin,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginManifest,
} from '../api/index.ts';
import {
  runtimeEventIdentityKey,
  type RuntimeEventIdentity,
} from '../../core/index.ts';
import {canonicalJsonValuesEqual} from '../../shared/canonical-json.ts';
import type {RuntimePluginConfigControlHostState} from '../builtin/plugin-management/index.ts';

export type RuntimePluginReloadResult =
  | {readonly status: 'rebuilt'; readonly plugin: RuntimePlugin}
  | {readonly status: 'declined'; readonly reason: string}
  | {readonly status: 'failed'; readonly message: string};

/** Injected: the host cannot import config resolution or package catalog. */
export type RuntimePluginReloader = {
  reload(
    pluginId: string,
    options: {
      /** The reloader declines when the authored file has moved past this. */
      readonly expectedFingerprint: string;
      /** Hands the factory result to the host before anything that can fail. */
      readonly retainCandidate: (plugin: RuntimePlugin) => void;
    },
  ): Promise<RuntimePluginReloadResult>;
};

export type RuntimePluginConfigReloadHostResult = {
  readonly outcome: 'live_applied' | 'deferred' | 'failed' | 'not_eligible';
  readonly evidence?: RuntimePluginEvidenceSnapshot;
  readonly failure?: string;
};

export type ConfirmedRuntimePluginConfigUpdateLog = {
  readonly note: (result: {
    readonly status: string;
    readonly preparedConfigEffect?: PreparedRuntimePluginConfigEffect;
  }) => void;
  readonly sessionScopedConfirmed: (
    identity: RuntimeEventIdentity,
    pluginId: string,
  ) => boolean;
};

/** One record so the appliesTo promise and commit-time reload policy agree. */
export function createConfirmedRuntimePluginConfigUpdateLog(options: {
  readonly pluginManifests: readonly RuntimePluginManifest[];
}): ConfirmedRuntimePluginConfigUpdateLog {
  let turnKey: string | undefined;
  const sessionScopedPluginIds = new Set<string>();

  return {
    note: result => {
      const effect = result.preparedConfigEffect;

      if (result.status !== 'accepted' || effect === undefined) {
        return;
      }

      const key = runtimeEventIdentityKey(effect);

      if (turnKey !== key) {
        turnKey = key;
        sessionScopedPluginIds.clear();
      }

      const field = options.pluginManifests
        .find(manifest => manifest.id === effect.targetPluginId)
        ?.config.fields.find(candidate => candidate.name === effect.fieldName);

      // An unknown field cannot be live-reloadable; treat it as session-scoped.
      if (field?.reloadRequired !== false) {
        sessionScopedPluginIds.add(effect.targetPluginId);
      }
    },
    sessionScopedConfirmed: (identity, pluginId) =>
      turnKey === runtimeEventIdentityKey(identity) &&
      sessionScopedPluginIds.has(pluginId),
  };
}

export async function reloadRuntimePluginForCommittedConfig(options: {
  readonly effects: readonly PreparedRuntimePluginConfigEffect[];
  readonly reloader: RuntimePluginReloader | undefined;
  readonly pluginConfigControl: RuntimePluginConfigControlHostState | undefined;
  readonly livePlugins: () => readonly RuntimePlugin[];
  readonly swapEnabledPlugin: (
    next: RuntimePlugin,
  ) => RuntimePlugin | undefined;
  readonly retirePlugin: (
    plugin: RuntimePlugin,
    catalogPluginId: string,
  ) => void;
  /** Keeps terminal dispatch behind every accepted reload ownership transfer. */
  readonly trackReloadWork: <T>(work: Promise<T>) => Promise<T>;
  readonly recordLiveAppliedFingerprint: (
    pluginId: string,
    configFingerprint: string,
  ) => void;
  /** Multi-plugin turns verify against the whole turn's final fingerprint. */
  readonly turnResultFingerprint?: string;
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

  const finalEffect =
    options.effects[options.effects.length - 1] ?? firstEffect;
  // Effects arrive in apply order, so the last one is this group's result.
  const authoredResultFingerprint =
    options.turnResultFingerprint ?? finalEffect.resultFingerprint;
  const manifest = options.pluginConfigControl?.pluginManifests.find(
    candidate => candidate.id === pluginId,
  );
  const {liveFieldNames, sessionScopedFieldSeen} = groupFieldEligibility(
    options.effects,
    manifest,
  );

  if (liveFieldNames.length === 0) {
    // No evidence: the update tool already reported future_host_construction.
    return {outcome: 'not_eligible'};
  }

  if (sessionScopedFieldSeen) {
    return deferred(
      options.effects,
      pluginId,
      'the committed effects mix live and reload-required fields',
      authoredResultFingerprint,
    );
  }

  if (options.reloader === undefined) {
    return deferred(
      options.effects,
      pluginId,
      'this host has no plugin reloader',
      authoredResultFingerprint,
    );
  }

  const previous = options
    .livePlugins()
    .find(plugin => plugin.manifest.id === pluginId);

  if (previous === undefined) {
    return deferred(
      options.effects,
      pluginId,
      'the plugin is not enabled',
      authoredResultFingerprint,
    );
  }

  const retireRebuilt = (instance: RuntimePlugin): void => {
    options.retirePlugin(instance, pluginId);
  };

  let reloaded: RuntimePluginReloadResult;

  try {
    const construction = options.trackReloadWork(
      options.reloader.reload(pluginId, {
        expectedFingerprint: authoredResultFingerprint,
        retainCandidate: retireRebuilt,
      }),
    );

    reloaded = await settleReloadWithinTimeout(construction);
  } catch (error: unknown) {
    reloaded = {
      status: 'failed',
      message: error instanceof Error ? error.message : 'Plugin reload failed.',
    };
  }

  if (reloaded.status === 'declined') {
    return deferred(
      options.effects,
      pluginId,
      reloaded.reason,
      authoredResultFingerprint,
    );
  }

  if (reloaded.status === 'failed') {
    const failure = `Live config reload for plugin "${pluginId}" failed; the previous instance keeps serving: ${reloaded.message}`;

    return {
      outcome: 'failed',
      failure,
      evidence: reloadEvidence(
        options.effects,
        'failed',
        failure,
        authoredResultFingerprint,
      ),
    };
  }

  if (rebuiltPluginChangesFrozenSurface(previous, reloaded.plugin)) {
    return deferred(
      options.effects,
      pluginId,
      'the rebuilt plugin changed its manifest, hook, or tool surface',
      authoredResultFingerprint,
    );
  }

  if (options.swapEnabledPlugin(reloaded.plugin) === undefined) {
    return deferred(
      options.effects,
      pluginId,
      'the plugin left the host',
      authoredResultFingerprint,
    );
  }

  options.recordLiveAppliedFingerprint(pluginId, authoredResultFingerprint);
  return {
    outcome: 'live_applied',
    evidence: reloadEvidence(
      options.effects,
      'accepted',
      `Live-applied committed config for plugin "${pluginId}" by rebuilding its instance (fields: ${liveFieldNames.join(', ')}).`,
      authoredResultFingerprint,
    ),
  };
}

export const runtimePluginReloadTimeoutMs = 10_000;

/** A factory that never settles must not block the turn queue after commit. */
async function settleReloadWithinTimeout(
  pending: Promise<RuntimePluginReloadResult>,
): Promise<RuntimePluginReloadResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RuntimePluginReloadResult>(resolve => {
    timeoutId = setTimeout(() => {
      resolve({
        status: 'failed',
        message: `the reloader did not settle within ${String(runtimePluginReloadTimeoutMs)}ms`,
      });
    }, runtimePluginReloadTimeoutMs);
  });

  try {
    return await Promise.race([pending, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function groupFieldEligibility(
  effects: readonly PreparedRuntimePluginConfigEffect[],
  manifest: RuntimePluginManifest | undefined,
): {
  readonly liveFieldNames: readonly string[];
  readonly sessionScopedFieldSeen: boolean;
} {
  const liveFieldNames: string[] = [];
  let sessionScopedFieldSeen = false;

  for (const effect of effects) {
    const field = manifest?.config.fields.find(
      candidate => candidate.name === effect.fieldName,
    );

    if (field?.reloadRequired === false) {
      liveFieldNames.push(field.name);
    } else {
      sessionScopedFieldSeen = true;
    }
  }

  return {liveFieldNames, sessionScopedFieldSeen};
}

/** A swap must not strand advertised tools or add unadvertised behavior. */
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
  configFingerprint: string,
): RuntimePluginConfigReloadHostResult {
  return {
    outcome: 'deferred',
    evidence: reloadEvidence(
      effects,
      'degraded',
      `Committed config for plugin "${pluginId}" applies at the next host construction instead of live: ${reason}.`,
      configFingerprint,
    ),
  };
}

function reloadEvidence(
  effects: readonly PreparedRuntimePluginConfigEffect[],
  status: 'accepted' | 'degraded' | 'failed',
  summary: string,
  configFingerprint: string,
): RuntimePluginEvidenceSnapshot {
  const [firstEffect] = effects;

  if (firstEffect === undefined) {
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
    configFingerprint,
  });
}
