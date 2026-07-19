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
  RuntimePluginManifest,
} from '../api/index.ts';
import {canonicalJsonValuesEqual} from '../../shared/canonical-json.ts';
import type {RuntimePluginConfigControlHostState} from '../builtin/plugin-management/index.ts';

export type RuntimePluginReloadResult =
  | {readonly status: 'rebuilt'; readonly plugin: RuntimePlugin}
  | {
      readonly status: 'declined';
      readonly reason: string;
      /**
       * Instance the reloader constructed before declining (e.g. the factory
       * ran but the result failed a check). The host retires it so terminal
       * lifecycle hooks still reach factory-allocated resources.
       */
      readonly plugin?: RuntimePlugin;
    }
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

export type RuntimeEventIdentitySlice = {
  readonly eventId: string;
  readonly traceId: string;
  readonly createdAt: string;
};

export type ConfirmedRuntimePluginConfigUpdateLog = {
  /** Records a settled tool result; only accepted results carrying a prepared effect count. */
  readonly note: (result: {
    readonly status: string;
    readonly preparedConfigEffect?: PreparedRuntimePluginConfigEffect;
  }) => void;
  /** True when the given turn already confirmed a session-scoped update for the plugin. */
  readonly sessionScopedConfirmed: (
    identity: RuntimeEventIdentitySlice,
    pluginId: string,
  ) => boolean;
};

/**
 * Turn-scoped record of CONFIRMED config updates, kept by the host at its
 * tool-dispatch choke point. The update tool's appliesTo promise reads this
 * instead of reconstructing turn state at prepare time, so the promise and
 * the commit-time reload policy see the same effects: results that later
 * fail user confirmation never register, and the record is scoped by the
 * full runtime identity (eventId, traceId, createdAt), not event id alone.
 */
export function createConfirmedRuntimePluginConfigUpdateLog(options: {
  readonly pluginManifests: readonly RuntimePluginManifest[];
}): ConfirmedRuntimePluginConfigUpdateLog {
  let turnKey: string | undefined;
  const sessionScopedPluginIds = new Set<string>();
  // Newline separator: identity components are single-line ids and an ISO
  // timestamp, so a newline cannot appear inside any component.
  const keyOf = (identity: RuntimeEventIdentitySlice): string =>
    [identity.eventId, identity.traceId, identity.createdAt].join('\n');

  return {
    note: result => {
      const effect = result.preparedConfigEffect;

      if (result.status !== 'accepted' || effect === undefined) {
        return;
      }

      const key = keyOf(effect);

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
      turnKey === keyOf(identity) && sessionScopedPluginIds.has(pluginId),
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
  /** Retains an instance that will never serve so it still receives terminal lifecycle hooks. */
  readonly retirePlugin: (plugin: RuntimePlugin) => void;
  /** Records that this host swapped the plugin to an instance built from the fingerprinted config. */
  readonly recordLiveAppliedFingerprint: (
    pluginId: string,
    configFingerprint: string,
  ) => void;
  /**
   * Authored-config fingerprint after ALL of the turn's accepted effects,
   * across plugins. A turn that updates several plugins leaves the file at
   * the whole turn's final fingerprint, so each per-plugin group must verify
   * against that one, not its own last effect. Defaults to this group's
   * final effect for single-group callers.
   */
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
  // Effects arrive in apply order, so a lone group leaves the authored file
  // at its own last effect; multi-plugin turns supply the whole turn's final
  // fingerprint instead.
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
    // Entirely session-scoped: the documented norm, no evidence needed —
    // the update tool already reported appliesTo: future_host_construction.
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

  // Retention is only safe under a truthful id: terminal dispatch resolves
  // access by the retired instance's own manifest.id, so an id-drifted
  // factory product must not enter ordinary lifecycle dispatch — under an
  // unknown id cleanup aborts, and under a colliding id it would run with
  // another plugin's access.
  const retireRebuilt = (instance: RuntimePlugin): void => {
    if (instance.manifest.id === pluginId) {
      options.retirePlugin(instance);
    }
  };

  let reloaded: RuntimePluginReloadResult;

  try {
    reloaded = await settleReloadWithinTimeout(
      options.reloader.reload(pluginId, {
        expectedFingerprint: authoredResultFingerprint,
      }),
      retireRebuilt,
    );
  } catch (error: unknown) {
    reloaded = {
      status: 'failed',
      message: error instanceof Error ? error.message : 'Plugin reload failed.',
    };
  }

  if (reloaded.status === 'declined') {
    if (reloaded.plugin !== undefined) {
      retireRebuilt(reloaded.plugin);
    }

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
    // The rebuilt instance may already hold factory-allocated resources, so
    // it is retired (not dropped) even though it never serves a dispatch.
    retireRebuilt(reloaded.plugin);
    return deferred(
      options.effects,
      pluginId,
      'the rebuilt plugin changed its manifest, hook, or tool surface',
      authoredResultFingerprint,
    );
  }

  if (options.swapEnabledPlugin(reloaded.plugin) === undefined) {
    retireRebuilt(reloaded.plugin);
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

/**
 * Bounds the reloader like every other plugin dispatch: a factory that never
 * settles must not block the per-session turn queue after the turn is
 * already durable. A factory that settles late may still have built an
 * instance, so the loser of the race is handed to ordinary retirement: it
 * joins whichever ordered terminal phases have not run yet, and one that
 * arrives after the last phase is deliberately dropped — the process is
 * exiting, and dispatching it out of band is what would let a never-served
 * instance write after the live instance's final state.
 */
async function settleReloadWithinTimeout(
  pending: Promise<RuntimePluginReloadResult>,
  retireLateInstance: (plugin: RuntimePlugin) => void,
): Promise<RuntimePluginReloadResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<RuntimePluginReloadResult>(resolve => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      resolve({
        status: 'failed',
        message: `the reloader did not settle within ${String(runtimePluginReloadTimeoutMs)}ms`,
      });
    }, runtimePluginReloadTimeoutMs);
  });

  pending
    .then(late => {
      if (!timedOut) {
        return;
      }

      if (late.status === 'rebuilt') {
        retireLateInstance(late.plugin);
      } else if (late.status === 'declined' && late.plugin !== undefined) {
        retireLateInstance(late.plugin);
      }
    })
    .catch(() => undefined);

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
  /** Authored fingerprint the reload verified (or deferred on): the turn's final state. */
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
