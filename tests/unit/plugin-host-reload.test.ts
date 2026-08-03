import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import {describe, expect, it, vi} from 'vitest';

import {
  createPreparedRuntimePluginConfigEffect,
  createRuntimePlugin,
  createRuntimePluginContextItem,
  createRuntimePluginManifest,
  runtimePluginContractVersion,
} from '../../src/plugins/api/index.ts';
import type {
  PreparedRuntimePluginConfigEffect,
  RuntimePlugin,
  RuntimePluginManifest,
} from '../../src/plugins/api/index.ts';
import {runtimePluginConfigControlStateForTest} from '../support/runtime-config.ts';
import type {RuntimePluginReloader} from '../../src/plugins/host/index.ts';
import {runtimePluginReloadTimeoutMs} from '../../src/plugins/host/reload.ts';
import {runtimePluginQuiesceTimeoutMs} from '../../src/plugins/host/instance-lifecycle.ts';
import {createPluginContextEvidence} from '../../src/plugins/api/evidence-helpers.ts';
import {
  testIdentity,
  testPluginContext,
  testRuntimePluginConfigControlCapability,
} from '../support/plugin-host-fixtures.ts';

const reloadPluginId = 'reload.style.fixture';

function reloadFixtureManifest(): RuntimePluginManifest {
  return createRuntimePluginManifest({
    id: reloadPluginId,
    displayName: 'Reload Style Fixture',
    version: '1.0.0',
    kind: 'context_provider',
    description: 'Fixture plugin with one live-reloadable config field.',
    contractVersion: runtimePluginContractVersion,
    compatibility: {
      hostContractVersions: [runtimePluginContractVersion],
      sourceSystem: 'test',
    },
    declaredPlugins: ['before_role_model_call', 'on_session_end'],
    config: {
      scope: 'global_with_character_overrides',
      fields: [
        {
          name: 'tone',
          description: 'Live-applied reply tone.',
          required: false,
          secret: false,
          valueType: 'string',
          agentMutable: true,
          reloadRequired: false,
          redactionLabels: [],
        },
        {
          name: 'note',
          description: 'Session-scoped setting without a reload declaration.',
          required: false,
          secret: false,
          valueType: 'string',
          agentMutable: true,
          redactionLabels: [],
        },
      ],
    },
    localTrustLevel: 'test_fixture',
    runtimePolicy: {
      requiredForTurn: false,
      confirmation: 'not_required',
      timeoutMs: 1000,
      sourceReferencesRequired: false,
      redactionLabels: [],
      failureBehavior: {
        beforeRoleModelCall: 'degrade',
        handleToolCall: 'reject_tool_call',
        afterTurnCommitted: 'log_failure',
        health: 'degrade',
      },
    },
    activation: {
      defaultEnabled: false,
      reasons: ['test_reload_fixture'],
    },
    requestedAccess: {model_input: 'write'},
  });
}

function reloadFixturePlugin(
  label: string,
  sessionEndLog?: string[],
): RuntimePlugin {
  return createRuntimePlugin({
    manifest: reloadFixtureManifest(),
    lifecycleHooks: {
      onSessionEnd() {
        sessionEndLog?.push(label);
        return {status: 'completed' as const, evidence: []};
      },
      beforeRoleModelCall(context) {
        return {
          contextItems: [
            createRuntimePluginContextItem({
              pluginId: reloadPluginId,
              id: 'style',
              kind: 'runtime_note',
              text: label,
              budget: {estimatedTokens: 8, priority: 50},
              sourceReferences: [],
              confidence: 1,
              redactionLabels: context.privacy.redactionLabels,
            }),
          ],
          evidence: [
            createPluginContextEvidence({
              context,
              pluginId: reloadPluginId,
              status: 'accepted',
              summary: `Provided ${label} context.`,
            }),
          ],
        };
      },
    },
  });
}

function terminalReloadFixturePlugin(
  label: string,
  terminalLog: string[],
): RuntimePlugin {
  return createRuntimePlugin({
    manifest: createRuntimePluginManifest({
      ...reloadFixtureManifest(),
      declaredPlugins: [
        'before_role_model_call',
        'on_session_end',
        'on_shutdown',
      ],
    }),
    lifecycleHooks: {
      onSessionEnd() {
        terminalLog.push(`${label}:sessionEnd`);
        return {status: 'completed' as const, evidence: []};
      },
      onShutdown() {
        terminalLog.push(`${label}:shutdown`);
        return {status: 'completed' as const, evidence: []};
      },
    },
  });
}

function toneEffect(
  fieldName = 'tone',
  effectId = 'effect-tone-1',
  resultFingerprint = 'sha256:after',
): PreparedRuntimePluginConfigEffect {
  return createPreparedRuntimePluginConfigEffect({
    ...testIdentity(),
    kind: 'runtime_plugin_config_effect',
    effectId,
    targetPluginId: reloadPluginId,
    targetConfigPath: '/unused/config.json',
    fieldName,
    expectedFingerprint: 'sha256:before',
    resultFingerprint,
    operation: {kind: 'set', value: 'warm'},
  });
}

function reloadHost(options: {
  readonly reloader?: RuntimePluginReloader;
  readonly initial?: RuntimePlugin;
  readonly constructionConfigFingerprint?: string;
}) {
  return createRuntimePluginHost({
    plugins: [options.initial ?? reloadFixturePlugin('v1')],
    enabledPluginIds: [reloadPluginId],
    pluginConfigControl: runtimePluginConfigControlStateForTest({
      control: testRuntimePluginConfigControlCapability,
      pluginManifests: [reloadFixtureManifest()],
    }),
    ...(options.reloader === undefined
      ? {}
      : {pluginReloader: options.reloader}),
    ...(options.constructionConfigFingerprint === undefined
      ? {}
      : {
          constructionConfigFingerprint: options.constructionConfigFingerprint,
        }),
  });
}

async function contextText(host: ReturnType<typeof createRuntimePluginHost>) {
  const result = await host.beforeRoleModelCall(testPluginContext());

  if (result.status !== 'completed') {
    throw new Error('Expected beforeRoleModelCall to complete.');
  }

  return result.contextItems.map(item => item.text).join('|');
}

describe('runtime plugin host live config reload', () => {
  it('swaps the rebuilt instance so the next dispatch sees it', async () => {
    const host = reloadHost({
      reloader: {
        reload: () =>
          Promise.resolve({
            status: 'rebuilt',
            plugin: reloadFixturePlugin('v2'),
          }),
      },
    });
    const toolsBefore = host.pluginToolDefinitions();

    expect(await contextText(host)).toBe('v1');

    const result = await host.reloadPluginForCommittedConfig?.([toneEffect()]);

    expect(result?.outcome).toBe('live_applied');
    expect(result?.evidence).toMatchObject({
      status: 'accepted',
      sourceReferences: [{kind: 'runtime', id: 'effect-tone-1'}],
    });
    expect(await contextText(host)).toBe('v2');
    expect(host.pluginToolDefinitions()).toBe(toolsBefore);
  });

  it('defers when the rebuilt plugin changes its tool surface', async () => {
    const changed = createRuntimePlugin({
      manifest: createRuntimePluginManifest({
        ...reloadFixtureManifest(),
        declaredPlugins: [
          'tool_provider',
          'before_role_model_call',
          'on_session_end',
        ],
      }),
      providedTools: [
        {
          name: 'reload.style.extra',
          description: 'Tool the original never advertised.',
          inputContract: {type: 'object', fields: [], additionalFields: false},
          validationOwner: 'plugin_host',
          requiresConfirmation: false,
          sourceReferencesRequired: false,
        },
      ],
      lifecycleHooks: reloadFixturePlugin('changed').lifecycleHooks,
    });
    const host = reloadHost({
      reloader: {
        reload: () => Promise.resolve({status: 'rebuilt', plugin: changed}),
      },
    });

    const result = await host.reloadPluginForCommittedConfig?.([toneEffect()]);

    expect(result?.outcome).toBe('deferred');
    expect(result?.evidence).toMatchObject({status: 'degraded'});
    expect(result?.evidence?.summary).toContain('tool surface');
    expect(await contextText(host)).toBe('v1');
  });

  it('keeps the old instance and reports a failure when the reload fails', async () => {
    const host = reloadHost({
      reloader: {
        reload: () => Promise.reject(new Error('factory exploded')),
      },
    });

    const result = await host.reloadPluginForCommittedConfig?.([toneEffect()]);

    expect(result?.outcome).toBe('failed');
    expect(result?.failure).toContain('factory exploded');
    expect(result?.evidence).toMatchObject({status: 'failed'});
    expect(await contextText(host)).toBe('v1');
  });

  it('is not eligible when no committed field opted into live reload', async () => {
    const host = reloadHost({
      reloader: {
        reload: () =>
          Promise.resolve({
            status: 'rebuilt',
            plugin: reloadFixturePlugin('v2'),
          }),
      },
    });

    const result = await host.reloadPluginForCommittedConfig?.([
      toneEffect('note', 'effect-note-1'),
    ]);

    expect(result?.outcome).toBe('not_eligible');
    expect(result?.evidence).toBeUndefined();
    expect(await contextText(host)).toBe('v1');
  });

  it('defers a group that mixes live and session-scoped fields', async () => {
    const host = reloadHost({
      reloader: {
        reload: () =>
          Promise.resolve({
            status: 'rebuilt',
            plugin: reloadFixturePlugin('v2'),
          }),
      },
    });

    const result = await host.reloadPluginForCommittedConfig?.([
      toneEffect('tone', 'effect-tone-1'),
      toneEffect('note', 'effect-note-1'),
    ]);

    expect(result?.outcome).toBe('deferred');
    expect(result?.evidence?.summary).toContain(
      'mix live and reload-required fields',
    );
    expect(await contextText(host)).toBe('v1');
  });

  it('verifies against the final fingerprint when a turn groups several updates', async () => {
    const seenFingerprints: string[] = [];
    const host = reloadHost({
      reloader: {
        reload: (_pluginId, reloadOptions) => {
          seenFingerprints.push(reloadOptions.expectedFingerprint);
          return Promise.resolve({
            status: 'rebuilt',
            plugin: reloadFixturePlugin('v2'),
          });
        },
      },
    });

    const result = await host.reloadPluginForCommittedConfig?.([
      toneEffect('tone', 'effect-tone-1', 'sha256:intermediate'),
      toneEffect('tone', 'effect-tone-2', 'sha256:final'),
    ]);

    expect(result?.outcome).toBe('live_applied');
    expect(seenFingerprints).toEqual(['sha256:final']);
    // The evidence must describe the authored file the reload verified,
    // which is the final effect's fingerprint, not the intermediate one.
    expect(result?.evidence).toMatchObject({
      configFingerprint: 'sha256:final',
    });
  });

  it('defers and retires a rebuilt instance that drops a lifecycle hook', async () => {
    const sessionEndLog: string[] = [];
    const hollowRebuild = createRuntimePlugin({
      manifest: reloadFixtureManifest(),
      lifecycleHooks: {
        onSessionEnd() {
          sessionEndLog.push('declined-rebuild');
          return {status: 'completed' as const, evidence: []};
        },
      },
    });
    const host = reloadHost({
      initial: reloadFixturePlugin('v1', sessionEndLog),
      reloader: {
        reload: (_pluginId, reloadOptions) => {
          reloadOptions.retainCandidate(hollowRebuild);
          return Promise.resolve({status: 'rebuilt', plugin: hollowRebuild});
        },
      },
    });

    const result = await host.reloadPluginForCommittedConfig?.([toneEffect()]);

    expect(result?.outcome).toBe('deferred');
    expect(result?.evidence?.summary).toContain('hook');
    expect(await contextText(host)).toBe('v1');

    // The declined rebuild may hold factory-allocated resources, so terminal
    // lifecycle hooks must still reach it even though it never served.
    await host.onSessionEnd(testPluginContext(), {allowFileStoreWrites: false});
    expect(sessionEndLog.sort()).toEqual(['declined-rebuild', 'v1']);
  });

  it('verifies against a supplied turn-final fingerprint', async () => {
    const seenFingerprints: string[] = [];
    const host = reloadHost({
      reloader: {
        reload: (_pluginId, reloadOptions) => {
          seenFingerprints.push(reloadOptions.expectedFingerprint);
          return Promise.resolve({
            status: 'rebuilt',
            plugin: reloadFixturePlugin('v2'),
          });
        },
      },
    });

    // A turn that also updated ANOTHER plugin leaves the authored file at
    // the whole turn's final fingerprint, not this group's last effect.
    const result = await host.reloadPluginForCommittedConfig?.(
      [toneEffect('tone', 'effect-tone-1', 'sha256:intermediate')],
      {turnResultFingerprint: 'sha256:turn-final'},
    );

    expect(result?.outcome).toBe('live_applied');
    expect(seenFingerprints).toEqual(['sha256:turn-final']);
    expect(result?.evidence).toMatchObject({
      configFingerprint: 'sha256:turn-final',
    });
  });

  it('retires an instance handed back with a declined reload', async () => {
    const sessionEndLog: string[] = [];
    const orphan = reloadFixturePlugin('orphan', sessionEndLog);
    const host = reloadHost({
      initial: reloadFixturePlugin('v1', sessionEndLog),
      reloader: {
        reload: (_pluginId, reloadOptions) => {
          reloadOptions.retainCandidate(orphan);
          return Promise.resolve({
            status: 'declined',
            reason: 'manifest drifted after construction',
          });
        },
      },
    });

    const result = await host.reloadPluginForCommittedConfig?.([toneEffect()]);

    expect(result?.outcome).toBe('deferred');
    expect(await contextText(host)).toBe('v1');
    await host.onSessionEnd(testPluginContext(), {allowFileStoreWrites: false});
    expect(sessionEndLog.sort()).toEqual(['orphan', 'v1']);
  });

  it('removes a resurrected instance from the retired list', async () => {
    const sessionEndLog: string[] = [];
    const v1 = reloadFixturePlugin('v1', sessionEndLog);
    const v2 = reloadFixturePlugin('v2', sessionEndLog);
    let round = 0;
    const host = reloadHost({
      initial: v1,
      reloader: {
        reload: () => {
          round += 1;
          return Promise.resolve({
            status: 'rebuilt',
            plugin: round === 1 ? v2 : v1,
          });
        },
      },
    });

    const first = await host.reloadPluginForCommittedConfig?.([toneEffect()]);
    const second = await host.reloadPluginForCommittedConfig?.([
      toneEffect('tone', 'effect-tone-2'),
    ]);

    expect(first?.outcome).toBe('live_applied');
    expect(second?.outcome).toBe('live_applied');
    expect(await contextText(host)).toBe('v1');

    // v1 went live → retired → live again (config-keyed factory cache); it
    // must not keep its retired slot or terminal hooks would run it twice.
    await host.onSessionEnd(testPluginContext(), {allowFileStoreWrites: false});
    expect(sessionEndLog.sort()).toEqual(['v1', 'v2']);
  });

  it('retires an id-drifted instance without publishing it', async () => {
    const sessionEndLog: string[] = [];
    const drifted = createRuntimePlugin({
      manifest: createRuntimePluginManifest({
        ...reloadFixtureManifest(),
        id: 'reload.style.drifted',
      }),
      lifecycleHooks: {
        onSessionEnd() {
          sessionEndLog.push('drifted');
          return {status: 'completed' as const, evidence: []};
        },
      },
    });
    const host = reloadHost({
      initial: reloadFixturePlugin('v1', sessionEndLog),
      reloader: {
        reload: (_pluginId, reloadOptions) => {
          reloadOptions.retainCandidate(drifted);
          return Promise.resolve({
            status: 'declined',
            reason: 'the factory returned a different plugin id',
          });
        },
      },
    });

    const result = await host.reloadPluginForCommittedConfig?.([toneEffect()]);

    expect(result?.outcome).toBe('deferred');
    // The candidate never becomes live, but construction still transfers
    // teardown ownership to the host.
    await host.onSessionEnd(testPluginContext(), {allowFileStoreWrites: false});
    expect(sessionEndLog).toEqual(['drifted', 'v1']);
  });

  it('does not retire the live instance when the factory returns it unchanged', async () => {
    const sessionEndLog: string[] = [];
    const v1 = reloadFixturePlugin('v1', sessionEndLog);
    const host = reloadHost({
      initial: v1,
      reloader: {
        reload: () => Promise.resolve({status: 'rebuilt', plugin: v1}),
      },
    });

    const result = await host.reloadPluginForCommittedConfig?.([toneEffect()]);

    expect(result?.outcome).toBe('live_applied');
    await host.onSessionEnd(testPluginContext(), {allowFileStoreWrites: false});
    // The same object must not receive terminal hooks twice (live + retired).
    expect(sessionEndLog).toEqual(['v1']);
  });

  it('runs terminal lifecycle hooks on superseded instances too', async () => {
    const sessionEndLog: string[] = [];
    const host = reloadHost({
      initial: reloadFixturePlugin('v1', sessionEndLog),
      reloader: {
        reload: () =>
          Promise.resolve({
            status: 'rebuilt',
            plugin: reloadFixturePlugin('v2', sessionEndLog),
          }),
      },
    });

    const result = await host.reloadPluginForCommittedConfig?.([toneEffect()]);

    expect(result?.outcome).toBe('live_applied');
    await host.onSessionEnd(testPluginContext(), {allowFileStoreWrites: false});
    // Retired instances run BEFORE the live one so the live instance's
    // terminal writes land last and win.
    expect(sessionEndLog).toEqual(['v1', 'v2']);
  });

  it('fails a reload whose factory never settles instead of blocking the turn', async () => {
    vi.useFakeTimers();

    try {
      const host = reloadHost({
        reloader: {
          reload: () => new Promise<never>(() => undefined),
        },
      });
      const resultPromise = host.reloadPluginForCommittedConfig?.([
        toneEffect(),
      ]);

      await vi.advanceTimersByTimeAsync(runtimePluginReloadTimeoutMs);

      const result = await resultPromise;

      expect(result?.outcome).toBe('failed');
      expect(result?.failure).toContain('did not settle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports config currency from construction and live-applied fingerprints', async () => {
    const host = reloadHost({
      constructionConfigFingerprint: 'sha256:construction',
      reloader: {
        reload: () =>
          Promise.resolve({
            status: 'rebuilt',
            plugin: reloadFixturePlugin('v2'),
          }),
      },
    });

    expect(
      host.pluginConfigCurrentFor?.(reloadPluginId, 'sha256:construction'),
    ).toBe(true);
    expect(host.pluginConfigCurrentFor?.(reloadPluginId, 'sha256:after')).toBe(
      false,
    );

    const result = await host.reloadPluginForCommittedConfig?.([toneEffect()]);

    expect(result?.outcome).toBe('live_applied');
    expect(host.pluginConfigCurrentFor?.(reloadPluginId, 'sha256:after')).toBe(
      true,
    );
    // The swap supersedes the construction fingerprint for this plugin: a
    // later update that RESTORES the startup config must not read as
    // already-current while the newer instance is the one serving.
    expect(
      host.pluginConfigCurrentFor?.(reloadPluginId, 'sha256:construction'),
    ).toBe(false);
  });

  it('quiesces a timed-out reload before an ordered terminal phase', async () => {
    vi.useFakeTimers();

    try {
      const terminalLog: string[] = [];
      let settleLate: ((plugin: RuntimePlugin) => void) | undefined;
      const host = reloadHost({
        initial: terminalReloadFixturePlugin('v1', terminalLog),
        reloader: {
          reload: (_pluginId, reloadOptions) =>
            new Promise(resolve => {
              // A late factory still transfers teardown ownership the moment
              // it produces the candidate, not through the settled result.
              settleLate = plugin => {
                reloadOptions.retainCandidate(plugin);
                resolve({status: 'rebuilt', plugin});
              };
            }),
        },
      });
      const resultPromise = host.reloadPluginForCommittedConfig?.([
        toneEffect(),
      ]);

      await vi.advanceTimersByTimeAsync(runtimePluginReloadTimeoutMs);
      expect((await resultPromise)?.outcome).toBe('failed');

      const sessionEnd = host.onSessionEnd(testPluginContext(), {
        allowFileStoreWrites: false,
      });

      expect(terminalLog).toEqual([]);
      settleLate?.(terminalReloadFixturePlugin('late', terminalLog));
      await vi.runAllTimersAsync();
      await sessionEnd;
      expect(terminalLog).toEqual(['late:sessionEnd', 'v1:sessionEnd']);

      await host.shutdown(testPluginContext());
      expect(terminalLog).toEqual([
        'late:sessionEnd',
        'v1:sessionEnd',
        'late:shutdown',
        'v1:shutdown',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('quiesces a timed-out reload before the final terminal phase', async () => {
    vi.useFakeTimers();

    try {
      const terminalLog: string[] = [];
      let settleLate: ((plugin: RuntimePlugin) => void) | undefined;
      const host = reloadHost({
        initial: terminalReloadFixturePlugin('v1', terminalLog),
        reloader: {
          reload: (_pluginId, reloadOptions) =>
            new Promise(resolve => {
              // A late factory still transfers teardown ownership the moment
              // it produces the candidate, not through the settled result.
              settleLate = plugin => {
                reloadOptions.retainCandidate(plugin);
                resolve({status: 'rebuilt', plugin});
              };
            }),
        },
      });
      const resultPromise = host.reloadPluginForCommittedConfig?.([
        toneEffect(),
      ]);

      await vi.advanceTimersByTimeAsync(runtimePluginReloadTimeoutMs);
      expect((await resultPromise)?.outcome).toBe('failed');

      const shutdown = host.shutdown(testPluginContext());

      expect(terminalLog).toEqual([]);
      settleLate?.(terminalReloadFixturePlugin('late', terminalLog));
      await vi.runAllTimersAsync();
      await shutdown;
      expect(terminalLog).toEqual(['late:shutdown', 'v1:shutdown']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds terminal quiescing when a reload never settles', async () => {
    vi.useFakeTimers();

    try {
      const terminalLog: string[] = [];
      const host = reloadHost({
        initial: terminalReloadFixturePlugin('v1', terminalLog),
        reloader: {
          // Never settles and never produces a candidate. The reload race
          // abandons this promise without cancelling it, so it stays tracked
          // for the rest of the process.
          reload: () => new Promise(() => undefined),
        },
      });
      const resultPromise = host.reloadPluginForCommittedConfig?.([
        toneEffect(),
      ]);

      await vi.advanceTimersByTimeAsync(runtimePluginReloadTimeoutMs);
      expect((await resultPromise)?.outcome).toBe('failed');

      // Terminal dispatch is the one phase that must always finish. Without a
      // bound this never resolves and the session can never shut down.
      const shutdown = host.shutdown(testPluginContext());

      await vi.advanceTimersByTimeAsync(runtimePluginQuiesceTimeoutMs);
      await shutdown;

      // Giving up on the stuck reload must not skip teardown for the instance
      // the host already owns.
      expect(terminalLog).toEqual(['v1:shutdown']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tears down a candidate that arrives after quiescing gives up', async () => {
    vi.useFakeTimers();

    try {
      const terminalLog: string[] = [];
      let settleLate: ((plugin: RuntimePlugin) => void) | undefined;
      const host = reloadHost({
        initial: terminalReloadFixturePlugin('v1', terminalLog),
        reloader: {
          reload: (_pluginId, reloadOptions) =>
            new Promise(resolve => {
              settleLate = plugin => {
                reloadOptions.retainCandidate(plugin);
                resolve({status: 'rebuilt', plugin});
              };
            }),
        },
      });
      const resultPromise = host.reloadPluginForCommittedConfig?.([
        toneEffect(),
      ]);

      await vi.advanceTimersByTimeAsync(runtimePluginReloadTimeoutMs);
      expect((await resultPromise)?.outcome).toBe('failed');

      const shutdown = host.shutdown(testPluginContext());

      // Outlives the quiesce bound, so shutdown proceeds without it.
      await vi.advanceTimersByTimeAsync(runtimePluginQuiesceTimeoutMs);
      await shutdown;
      expect(terminalLog).toEqual(['v1:shutdown']);

      // The abandoned factory was never cancelled, so it can still produce an
      // instance. Nothing will read the retired list again, so this candidate
      // must be torn down on arrival rather than filed away holding whatever
      // its factory opened.
      settleLate?.(terminalReloadFixturePlugin('late', terminalLog));
      await vi.runAllTimersAsync();

      expect(terminalLog).toEqual(['v1:shutdown', 'late:shutdown']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers when the host has no reloader', async () => {
    const host = reloadHost({});

    const result = await host.reloadPluginForCommittedConfig?.([toneEffect()]);

    expect(result?.outcome).toBe('deferred');
    expect(result?.evidence?.summary).toContain('no plugin reloader');
    expect(await contextText(host)).toBe('v1');
  });
});
