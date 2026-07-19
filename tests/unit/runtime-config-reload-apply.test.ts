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

  it('does not reload a plugin whose accepted effects are pure no-ops', async () => {
    const calls: string[][] = [];
    const baseHost = createRuntimePluginHost();
    const capturingHost = Object.freeze({
      ...baseHost,
      reloadPluginForCommittedConfig(effects) {
        calls.push(effects.map(effect => effect.targetPluginId));
        return Promise.resolve({outcome: 'deferred' as const});
      },
    } satisfies RuntimePluginHost);

    // Alpha's accepted update left the file exactly where it was; only
    // beta's config actually changed. Rebuilding alpha would reset its
    // per-session state for nothing.
    await applyCompletedRuntimeConfigReloads({
      pluginHost: capturingHost,
      effects: [
        applyReloadEffect('plugin.alpha', 'effect-a', 'sha256:f0', 'sha256:f0'),
        applyReloadEffect('plugin.beta', 'effect-b', 'sha256:f0', 'sha256:f1'),
      ],
      reconcileEvidence: [
        acceptedReconcileEvidence('effect-a'),
        acceptedReconcileEvidence('effect-b'),
      ],
    });

    expect(calls).toEqual([['plugin.beta']]);
  });
});
