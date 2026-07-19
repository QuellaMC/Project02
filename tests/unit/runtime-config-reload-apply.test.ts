import {describe, expect, it} from 'vitest';

import {
  createPreparedRuntimePluginConfigEffect,
  createRuntimePluginEvidenceSnapshot,
  runtimePluginId,
} from '../../src/plugins/api/index.ts';
import type {PreparedRuntimePluginConfigEffect} from '../../src/plugins/api/index.ts';
import {
  createRuntimePluginHost,
  type RuntimePluginHost,
} from '../../src/plugins/host/index.ts';
import {applyCompletedRuntimeConfigReloads} from '../../src/runtime/turn/config-effects.ts';

const applyReloadIdentity = {
  eventId: 'evt_apply_reload',
  traceId: 'trace_apply_reload',
  createdAt: '2026-07-18T00:00:00.000Z',
} as const;

function applyReloadEffect(
  pluginId: string,
  effectId: string,
  expectedFingerprint: string,
  resultFingerprint: string,
): PreparedRuntimePluginConfigEffect {
  return createPreparedRuntimePluginConfigEffect({
    ...applyReloadIdentity,
    kind: 'runtime_plugin_config_effect',
    effectId,
    targetPluginId: pluginId,
    targetConfigPath: '/unused/config.json',
    fieldName: 'tone',
    expectedFingerprint,
    resultFingerprint,
    operation: {kind: 'set', value: 'warm'},
  });
}

function acceptedReconcileEvidence(effectId: string) {
  return createRuntimePluginEvidenceSnapshot({
    ...applyReloadIdentity,
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: runtimePluginId,
    evidenceKind: 'after_turn_committed',
    status: 'accepted',
    summary: `Reconciled config effect "${effectId}".`,
    sourceReferences: [{kind: 'runtime', id: effectId}],
    redactionLabels: [],
  });
}

describe('applyCompletedRuntimeConfigReloads', () => {
  it('passes the turn-final fingerprint to every per-plugin group', async () => {
    const calls: {
      readonly pluginIds: readonly string[];
      readonly turnResultFingerprint: string | undefined;
    }[] = [];
    const baseHost = createRuntimePluginHost();
    const capturingHost = Object.freeze({
      ...baseHost,
      reloadPluginForCommittedConfig(effects, reloadOptions) {
        calls.push({
          pluginIds: effects.map(effect => effect.targetPluginId),
          turnResultFingerprint: reloadOptions?.turnResultFingerprint,
        });
        return Promise.resolve({outcome: 'deferred' as const});
      },
    } satisfies RuntimePluginHost);

    // One turn updates TWO plugins: the file chains alpha then beta, so
    // alpha's group must verify against beta's (turn-final) fingerprint or
    // the reloader declines it as moved-past.
    const result = await applyCompletedRuntimeConfigReloads({
      pluginHost: capturingHost,
      effects: [
        applyReloadEffect('plugin.alpha', 'effect-a', 'sha256:f0', 'sha256:f1'),
        applyReloadEffect('plugin.beta', 'effect-b', 'sha256:f1', 'sha256:f2'),
      ],
      reconcileEvidence: [
        acceptedReconcileEvidence('effect-a'),
        acceptedReconcileEvidence('effect-b'),
      ],
    });

    expect(result.failures).toEqual([]);
    expect(calls.map(call => call.pluginIds)).toEqual([
      ['plugin.alpha'],
      ['plugin.beta'],
    ]);
    expect(calls.map(call => call.turnResultFingerprint)).toEqual([
      'sha256:f2',
      'sha256:f2',
    ]);
  });

  it('records a throwing currency predicate as a reload failure', async () => {
    const baseHost = createRuntimePluginHost();
    const explodingHost = Object.freeze({
      ...baseHost,
      pluginConfigCurrentFor(): boolean {
        throw new Error('currency check exploded');
      },
      reloadPluginForCommittedConfig(): Promise<never> {
        throw new Error('must not be reached');
      },
    } satisfies RuntimePluginHost);

    // The turn is already durable by the time reloads run, so a throwing
    // host predicate must surface as a post-commit failure, not a rejection.
    const result = await applyCompletedRuntimeConfigReloads({
      pluginHost: explodingHost,
      effects: [
        applyReloadEffect('plugin.alpha', 'effect-a', 'sha256:f0', 'sha256:f1'),
      ],
      reconcileEvidence: [acceptedReconcileEvidence('effect-a')],
    });

    expect(result.failures).toEqual([
      expect.stringContaining('currency check exploded') as unknown,
    ]);
  });

  it('skips a no-op group only when the host already reflects it', async () => {
    const noOpTurnEffects = [
      applyReloadEffect('plugin.alpha', 'effect-a', 'sha256:f0', 'sha256:f0'),
      applyReloadEffect('plugin.beta', 'effect-b', 'sha256:f0', 'sha256:f1'),
    ];
    const noOpTurnEvidence = [
      acceptedReconcileEvidence('effect-a'),
      acceptedReconcileEvidence('effect-b'),
    ];
    const capturingHost = (constructionConfigFingerprint?: string) => {
      const calls: string[][] = [];
      const baseHost = createRuntimePluginHost(
        constructionConfigFingerprint === undefined
          ? {}
          : {constructionConfigFingerprint},
      );

      return {
        calls,
        host: Object.freeze({
          ...baseHost,
          reloadPluginForCommittedConfig(effects) {
            calls.push(effects.map(effect => effect.targetPluginId));
            return Promise.resolve({outcome: 'deferred' as const});
          },
        } satisfies RuntimePluginHost),
      };
    };

    // Alpha's accepted update left the file exactly where it was and the
    // host was built from that state: rebuilding alpha would reset its
    // per-session state for nothing.
    const current = capturingHost('sha256:f0');

    await applyCompletedRuntimeConfigReloads({
      pluginHost: current.host,
      effects: noOpTurnEffects,
      reconcileEvidence: noOpTurnEvidence,
    });

    expect(current.calls).toEqual([['plugin.beta']]);

    // Same no-op update against a STALE host (an earlier reload failed and
    // nothing reflects f0): the same-value update must retry the reload
    // instead of being skipped as "unchanged".
    const stale = capturingHost();

    await applyCompletedRuntimeConfigReloads({
      pluginHost: stale.host,
      effects: noOpTurnEffects,
      reconcileEvidence: noOpTurnEvidence,
    });

    expect(stale.calls).toEqual([['plugin.alpha'], ['plugin.beta']]);
  });
});
