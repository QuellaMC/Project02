import {describe, expect, it} from 'vitest';

import type {CharacterRuntimeState} from '../../src/gateway/index.ts';
import {createReconciler} from '../../src/gateway/reconcile.ts';

function createHarness() {
  const states = new Map<string, CharacterRuntimeState | 'not_started'>();
  const enabled = new Map<string, boolean>();
  const drifted = new Set<string>();
  const log: string[] = [];
  let rosterReads = 0;
  let releaseStart: (() => void) | undefined;
  const reconciler = createReconciler({
    roster() {
      rosterReads += 1;

      return [...enabled.entries()].map(([id, isEnabled]) => ({
        id,
        displayName: id,
        enabled: isEnabled,
      }));
    },
    running: () => [...states.keys()],
    stateOf: id => states.get(id) ?? 'not_started',
    start(id) {
      log.push(`start:${id}`);
      states.set(id, 'starting');

      return new Promise<void>(resolve => {
        releaseStart = () => {
          states.set(id, 'ready');
          resolve();
        };
      });
    },
    stop(id) {
      log.push(`stop:${id}`);
      states.set(id, 'stopped');

      return Promise.resolve();
    },
    drifted: id => drifted.has(id),
    reload(id) {
      log.push(`reload:${id}`);
      drifted.delete(id);

      return Promise.resolve();
    },
  });

  return {
    reconciler,
    states,
    enabled,
    drifted,
    log,
    rosterReads: () => rosterReads,
    release: () => releaseStart?.(),
  };
}

describe('gateway reconciler', () => {
  it('runs one more pass for requests that arrived mid-pass, on the newest roster', async () => {
    const harness = createHarness();

    harness.enabled.set('mira', true);

    const first = harness.reconciler.reconcile();
    // Two requests land while the start is in flight; the roster changes
    // under them. They join the pass, and exactly one trailing pass follows.
    harness.enabled.set('mira', false);

    const second = harness.reconciler.reconcile();
    const third = harness.reconciler.reconcile();

    expect(second).toBe(first);
    expect(third).toBe(first);
    harness.release();

    await expect(first).resolves.toEqual({
      starting: ['mira'],
      stopping: ['mira'],
      reloading: [],
    });
    expect(harness.rosterReads()).toBe(2);
    expect(harness.log).toEqual(['start:mira', 'stop:mira']);
    expect(harness.states.get('mira')).toBe('stopped');
  });

  it('leaves settled and in-flight characters alone, retries a failed one, and reloads a drifted one', async () => {
    const harness = createHarness();

    harness.enabled.set('ready', true);
    harness.states.set('ready', 'ready');
    harness.enabled.set('drifted', true);
    harness.states.set('drifted', 'ready');
    harness.drifted.add('drifted');
    harness.enabled.set('reloading', true);
    harness.states.set('reloading', 'reloading');
    harness.drifted.add('reloading');
    harness.enabled.set('stopping', false);
    harness.states.set('stopping', 'stopping');
    harness.enabled.set('failed', true);
    harness.states.set('failed', 'failed');
    harness.enabled.set('off', false);
    harness.states.set('off', 'failed');
    harness.enabled.set('off-mid-reload', false);
    harness.states.set('off-mid-reload', 'reloading');

    const pass = harness.reconciler.reconcile();

    harness.release();

    await expect(pass).resolves.toEqual({
      starting: ['failed'],
      stopping: ['off', 'off-mid-reload'],
      reloading: ['drifted'],
    });
    expect(harness.log).toEqual([
      'reload:drifted',
      'start:failed',
      'stop:off',
      'stop:off-mid-reload',
    ]);
    await expect(harness.reconciler.settled()).resolves.toBeUndefined();
  });

  it('stops a running character whose package left the roster', async () => {
    const harness = createHarness();

    harness.states.set('gone', 'ready');
    harness.states.set('long-gone', 'stopped');
    harness.enabled.set('mira', true);
    harness.states.set('mira', 'ready');

    await expect(harness.reconciler.reconcile()).resolves.toEqual({
      starting: [],
      stopping: ['gone'],
      reloading: [],
    });
    expect(harness.log).toEqual(['stop:gone']);
  });
});
