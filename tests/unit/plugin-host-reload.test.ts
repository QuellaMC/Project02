import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import {join} from 'node:path';

import {describe, expect, it, vi} from 'vitest';

import {
  createRuntimePlugin,
  createRuntimePluginContextItem,
  createRuntimePluginManifest,
  runtimePluginConfigUpdateToolName,
  runtimePluginContractVersion,
  runtimePluginId,
} from '../../src/plugins/api/index.ts';
import type {
  RuntimePlugin,
  RuntimePluginManifest,
  RuntimePluginToolCallResult,
} from '../../src/plugins/api/index.ts';
import {
  runtimeLocationForTest,
  runtimePluginConfigControlStateForTest,
  writeRuntimeConfig,
} from '../support/runtime-config.ts';
import type {RuntimePluginReloader} from '../../src/plugins/host/index.ts';
import {runtimePluginReloadTimeoutMs} from '../../src/plugins/host/reload.ts';
import {runtimePluginQuiesceTimeoutMs} from '../../src/plugins/host/instance-lifecycle.ts';
import {createPluginContextEvidence} from '../../src/plugins/api/evidence-helpers.ts';
import {inspectRuntimePluginConfig} from '../../src/runtime/config/index.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
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
          description: 'Restart-only setting without a reload declaration.',
          required: false,
          secret: false,
          valueType: 'string',
          agentMutable: true,
          redactionLabels: [],
        },
      ],
    },
    firstParty: false,
    runtimePolicy: {
      timeoutMs: 1000,
      redactionLabels: [],
      failureBehavior: {
        beforeRoleModelCall: 'degrade',
        handleToolCall: 'reject_tool_call',
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

type ReloadHost = {
  readonly host: ReturnType<typeof createRuntimePluginHost>;
  /** Approves one field update through the update tool and returns its result. */
  readonly approve: (change?: {
    readonly fieldName?: string;
    readonly value?: string;
  }) => Promise<RuntimePluginToolCallResult>;
  readonly authoredFingerprint: () => string;
  readonly authoredValue: (fieldName: string) => unknown;
};

function reloadHost(options: {
  readonly reloader?: RuntimePluginReloader;
  readonly initial?: RuntimePlugin;
  readonly enabled?: boolean;
  /** Defaults to approving at once. */
  readonly confirm?: () => Promise<{readonly status: 'approved'}>;
}): ReloadHost {
  const storeRoot = createTestTempRoot('project02-plugin-host-reload-');
  const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
  const runtimeLocation = runtimeLocationForTest({configPath, storeRoot});
  const manifest = reloadFixtureManifest();
  const host = createRuntimePluginHost({
    storeRoot,
    plugins: [options.initial ?? reloadFixturePlugin('v1')],
    enabledPluginIds:
      options.enabled === false
        ? [runtimePluginId]
        : [runtimePluginId, reloadPluginId],
    pluginConfigControl: runtimePluginConfigControlStateForTest({
      runtimeLocation,
      control: testRuntimePluginConfigControlCapability,
      pluginManifests: [manifest],
    }),
    toolConfirmationHandler: options.confirm ?? (() => ({status: 'approved'})),
    ...(options.reloader === undefined
      ? {}
      : {pluginReloader: options.reloader}),
  });
  const inspect = () =>
    inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation,
      manifest,
      pluginManifests: [manifest],
    });
  let calls = 0;

  return {
    host,
    approve(change = {}) {
      calls += 1;
      return host.handleToolCall(
        {
          ...testIdentity(),
          toolCallId: `call-reload-${String(calls)}`,
          pluginId: runtimePluginId,
          toolName: runtimePluginConfigUpdateToolName,
          input: {
            pluginId: reloadPluginId,
            fieldName: change.fieldName ?? 'tone',
            operation: 'set',
            value: change.value ?? 'warm',
            expectedFingerprint: inspect().fingerprint,
          },
        },
        testPluginContext(),
      );
    },
    authoredFingerprint: () => inspect().fingerprint,
    authoredValue: fieldName =>
      inspect().fields.find(field => field.name === fieldName)?.authored.value,
  };
}

async function contextText(host: ReturnType<typeof createRuntimePluginHost>) {
  const result = await host.beforeRoleModelCall(testPluginContext());

  if (result.status !== 'completed') {
    throw new Error('Expected beforeRoleModelCall to complete.');
  }

  return result.contextItems.map(item => item.text).join('|');
}

function rebuiltReloader(
  plugin: () => RuntimePlugin,
  seen?: string[],
): RuntimePluginReloader {
  return {
    reload: (_pluginId, reloadOptions) => {
      seen?.push(reloadOptions.expectedFingerprint);
      return Promise.resolve({status: 'rebuilt', plugin: plugin()});
    },
  };
}

describe('runtime plugin host live config reload', () => {
  it('rebuilds and swaps the plugin inside the approved update call', async () => {
    const seenFingerprints: string[] = [];
    const fixture = reloadHost({
      reloader: rebuiltReloader(
        () => reloadFixturePlugin('v2'),
        seenFingerprints,
      ),
    });
    const toolsBefore = fixture.host.pluginToolDefinitions();

    expect(await contextText(fixture.host)).toBe('v1');

    const result = await fixture.approve();
    const after = fixture.authoredFingerprint();

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        status: 'applied',
        appliesTo: 'now',
        reloadRequired: false,
        fingerprint: after,
      },
    });
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        evidenceKind: 'tool_invocation',
        status: 'accepted',
        summary: expect.stringContaining('Live-applied') as string,
        configFingerprint: after,
      }),
    );
    expect(seenFingerprints).toEqual([after]);
    expect(fixture.authoredValue('tone')).toBe('warm');
    expect(await contextText(fixture.host)).toBe('v2');
    expect(fixture.host.pluginToolDefinitions()).toBe(toolsBefore);
  });

  it('keeps the old instance and answers next_launch when the rebuilt plugin changes its tool surface', async () => {
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
          inputContract: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
          validationOwner: 'plugin_host',
          requiresConfirmation: false,
        },
      ],
      lifecycleHooks: reloadFixturePlugin('changed').lifecycleHooks,
    });
    const fixture = reloadHost({reloader: rebuiltReloader(() => changed)});

    const result = await fixture.approve();

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        status: 'applied',
        appliesTo: 'next_launch',
        appliesToNote: expect.stringContaining('tool surface') as string,
      },
    });
    expect(result.evidence).toContainEqual(
      expect.objectContaining({status: 'degraded'}),
    );
    expect(fixture.authoredValue('tone')).toBe('warm');
    expect(await contextText(fixture.host)).toBe('v1');
  });

  it('keeps the old instance serving and tells the model when the reload fails', async () => {
    const fixture = reloadHost({
      reloader: {
        reload: () => Promise.reject(new Error('factory exploded')),
      },
    });

    const result = await fixture.approve();

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        status: 'applied',
        appliesTo: 'next_launch',
        appliesToNote: expect.stringContaining('factory exploded') as string,
      },
    });
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        evidenceKind: 'tool_invocation',
        status: 'degraded',
        summary: expect.stringContaining('factory exploded') as string,
      }),
    );
    expect(fixture.authoredValue('tone')).toBe('warm');
    expect(await contextText(fixture.host)).toBe('v1');
  });

  it('writes a restart-only field without rebuilding', async () => {
    const reloads: string[] = [];
    const fixture = reloadHost({
      reloader: rebuiltReloader(() => reloadFixturePlugin('v2'), reloads),
    });

    const result = await fixture.approve({fieldName: 'note', value: 'later'});

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        status: 'applied',
        appliesTo: 'next_launch',
        reloadRequired: true,
      },
    });
    expect(
      result.status === 'accepted' ? result.output : undefined,
    ).not.toHaveProperty('appliesToNote');
    expect(reloads).toEqual([]);
    expect(fixture.authoredValue('note')).toBe('later');
    expect(await contextText(fixture.host)).toBe('v1');
  });

  it('declines a live rebuild once a restart-only field of the same plugin was applied', async () => {
    const reloads: string[] = [];
    const fixture = reloadHost({
      reloader: rebuiltReloader(() => reloadFixturePlugin('v2'), reloads),
    });

    await fixture.approve({fieldName: 'note', value: 'later'});
    const result = await fixture.approve();

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        status: 'applied',
        appliesTo: 'next_launch',
        appliesToNote: expect.stringContaining('waits for a restart') as string,
      },
    });
    expect(reloads).toEqual([]);
    expect(fixture.authoredValue('tone')).toBe('warm');
    expect(await contextText(fixture.host)).toBe('v1');
  });

  it('answers next_launch when the host cannot rebuild the plugin live', async () => {
    const withoutReloader = reloadHost({});
    const notEnabled = reloadHost({
      enabled: false,
      reloader: rebuiltReloader(() => reloadFixturePlugin('v2')),
    });

    expect(await withoutReloader.approve()).toMatchObject({
      output: {
        appliesTo: 'next_launch',
        appliesToNote: expect.stringContaining('no plugin reloader') as string,
      },
    });
    expect(await notEnabled.approve()).toMatchObject({
      output: {
        appliesTo: 'next_launch',
        appliesToNote: expect.stringContaining('not enabled') as string,
      },
    });
    expect(withoutReloader.authoredValue('tone')).toBe('warm');
    expect(await contextText(withoutReloader.host)).toBe('v1');
  });

  it('declines a live rebuild once the host has shut down', async () => {
    const terminalLog: string[] = [];
    const reloads: string[] = [];
    let approve: (() => void) | undefined;
    const fixture = reloadHost({
      initial: terminalReloadFixturePlugin('v1', terminalLog),
      reloader: rebuiltReloader(
        () => terminalReloadFixturePlugin('v2', terminalLog),
        reloads,
      ),
      confirm: () =>
        new Promise(resolve => {
          approve = () => {
            resolve({status: 'approved'});
          };
        }),
    });

    // The person is still being asked when the host shuts down; the approval
    // that arrives afterwards writes the change but must not publish an
    // instance that terminal dispatch will never own.
    const pending = fixture.approve();

    await vi.waitFor(() => {
      expect(approve).toBeDefined();
    });
    await fixture.host.shutdown(testPluginContext());
    approve?.();

    expect(await pending).toMatchObject({
      status: 'accepted',
      output: {
        appliesTo: 'next_launch',
        appliesToNote: expect.stringContaining('shutting down') as string,
      },
    });
    expect(fixture.authoredValue('tone')).toBe('warm');
    expect(reloads).toEqual([]);
    expect(terminalLog).toEqual(['v1:shutdown']);
  });

  it('keeps reloading live after a session ends, and ends a retired instance once', async () => {
    const sessionEndLog: string[] = [];
    const fixture = reloadHost({
      initial: reloadFixturePlugin('v1', sessionEndLog),
      reloader: rebuiltReloader(() => reloadFixturePlugin('v2', sessionEndLog)),
    });

    // The chat may continue in the next session with the same host, so a
    // session's end is not the host's end.
    await fixture.host.onSessionEnd(testPluginContext(), {
      allowFileStoreWrites: false,
    });
    const result = await fixture.approve();

    expect(result).toMatchObject({output: {appliesTo: 'now'}});
    expect(await contextText(fixture.host)).toBe('v2');

    // v1 served the second session until it was retired and is ended with it;
    // the third session's end reaches only v2, which is all that served it.
    await fixture.host.onSessionEnd(testPluginContext(), {
      allowFileStoreWrites: false,
    });
    await fixture.host.onSessionEnd(testPluginContext(), {
      allowFileStoreWrites: false,
    });
    expect(sessionEndLog).toEqual(['v1', 'v1', 'v2', 'v2']);
  });

  it('answers next_launch and retires a rebuilt instance that drops a lifecycle hook', async () => {
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
    const fixture = reloadHost({
      initial: reloadFixturePlugin('v1', sessionEndLog),
      reloader: {
        reload: (_pluginId, reloadOptions) => {
          reloadOptions.retainCandidate(hollowRebuild);
          return Promise.resolve({status: 'rebuilt', plugin: hollowRebuild});
        },
      },
    });

    const result = await fixture.approve();

    expect(result).toMatchObject({
      output: {
        appliesTo: 'next_launch',
        appliesToNote: expect.stringContaining('hook') as string,
      },
    });
    expect(await contextText(fixture.host)).toBe('v1');

    // The declined rebuild may hold factory-allocated resources.
    await fixture.host.onSessionEnd(testPluginContext(), {
      allowFileStoreWrites: false,
    });
    expect(sessionEndLog.sort()).toEqual(['declined-rebuild', 'v1']);
  });

  it('retires an instance handed back with a declined reload', async () => {
    const sessionEndLog: string[] = [];
    const orphan = reloadFixturePlugin('orphan', sessionEndLog);
    const fixture = reloadHost({
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

    const result = await fixture.approve();

    expect(result).toMatchObject({
      output: {
        appliesTo: 'next_launch',
        appliesToNote: expect.stringContaining('manifest drifted') as string,
      },
    });
    expect(await contextText(fixture.host)).toBe('v1');
    await fixture.host.onSessionEnd(testPluginContext(), {
      allowFileStoreWrites: false,
    });
    expect(sessionEndLog.sort()).toEqual(['orphan', 'v1']);
  });

  it('removes a resurrected instance from the retired list', async () => {
    const sessionEndLog: string[] = [];
    const v1 = reloadFixturePlugin('v1', sessionEndLog);
    const v2 = reloadFixturePlugin('v2', sessionEndLog);
    let round = 0;
    const fixture = reloadHost({
      initial: v1,
      reloader: rebuiltReloader(() => {
        round += 1;
        return round === 1 ? v2 : v1;
      }),
    });

    const first = await fixture.approve();
    const second = await fixture.approve({value: 'formal'});

    expect(first).toMatchObject({output: {appliesTo: 'now'}});
    expect(second).toMatchObject({output: {appliesTo: 'now'}});
    expect(await contextText(fixture.host)).toBe('v1');

    // A config-keyed factory cache took v1 live, retired, then live again.
    await fixture.host.onSessionEnd(testPluginContext(), {
      allowFileStoreWrites: false,
    });
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
    const fixture = reloadHost({
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

    const result = await fixture.approve();

    expect(result).toMatchObject({output: {appliesTo: 'next_launch'}});
    // Construction transfers teardown ownership even for a candidate that
    // never goes live.
    await fixture.host.onSessionEnd(testPluginContext(), {
      allowFileStoreWrites: false,
    });
    expect(sessionEndLog).toEqual(['drifted', 'v1']);
  });

  it('does not retire the live instance when the factory returns it unchanged', async () => {
    const sessionEndLog: string[] = [];
    const v1 = reloadFixturePlugin('v1', sessionEndLog);
    const fixture = reloadHost({
      initial: v1,
      reloader: rebuiltReloader(() => v1),
    });

    const result = await fixture.approve();

    expect(result).toMatchObject({output: {appliesTo: 'now'}});
    await fixture.host.onSessionEnd(testPluginContext(), {
      allowFileStoreWrites: false,
    });
    // The same object must not receive terminal hooks twice (live + retired).
    expect(sessionEndLog).toEqual(['v1']);
  });

  it('runs terminal lifecycle hooks on superseded instances too', async () => {
    const sessionEndLog: string[] = [];
    const fixture = reloadHost({
      initial: reloadFixturePlugin('v1', sessionEndLog),
      reloader: rebuiltReloader(() => reloadFixturePlugin('v2', sessionEndLog)),
    });

    const result = await fixture.approve();

    expect(result).toMatchObject({output: {appliesTo: 'now'}});
    await fixture.host.onSessionEnd(testPluginContext(), {
      allowFileStoreWrites: false,
    });
    // Retired instances run first so the live one's terminal writes land last.
    expect(sessionEndLog).toEqual(['v1', 'v2']);
  });

  it('fails a reload whose factory never settles instead of blocking the tool call', async () => {
    vi.useFakeTimers();

    try {
      const fixture = reloadHost({
        reloader: {reload: () => new Promise<never>(() => undefined)},
      });
      const resultPromise = fixture.approve();

      await vi.advanceTimersByTimeAsync(runtimePluginReloadTimeoutMs);

      expect(await resultPromise).toMatchObject({
        output: {
          appliesTo: 'next_launch',
          appliesToNote: expect.stringContaining('did not settle') as string,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('quiesces a timed-out reload before an ordered terminal phase', async () => {
    vi.useFakeTimers();

    try {
      const terminalLog: string[] = [];
      let settleLate: ((plugin: RuntimePlugin) => void) | undefined;
      const fixture = reloadHost({
        initial: terminalReloadFixturePlugin('v1', terminalLog),
        reloader: {
          reload: (_pluginId, reloadOptions) =>
            new Promise(resolve => {
              // Ownership transfers when the candidate is produced, not through
              // the settled result.
              settleLate = plugin => {
                reloadOptions.retainCandidate(plugin);
                resolve({status: 'rebuilt', plugin});
              };
            }),
        },
      });
      const resultPromise = fixture.approve();

      await vi.advanceTimersByTimeAsync(runtimePluginReloadTimeoutMs);
      expect(await resultPromise).toMatchObject({
        output: {appliesTo: 'next_launch'},
      });

      const sessionEnd = fixture.host.onSessionEnd(testPluginContext(), {
        allowFileStoreWrites: false,
      });

      expect(terminalLog).toEqual([]);
      settleLate?.(terminalReloadFixturePlugin('late', terminalLog));
      await vi.runAllTimersAsync();
      await sessionEnd;
      expect(terminalLog).toEqual(['late:sessionEnd', 'v1:sessionEnd']);

      await fixture.host.shutdown(testPluginContext());
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
      const fixture = reloadHost({
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
      const resultPromise = fixture.approve();

      await vi.advanceTimersByTimeAsync(runtimePluginReloadTimeoutMs);
      expect(await resultPromise).toMatchObject({
        output: {appliesTo: 'next_launch'},
      });

      const shutdown = fixture.host.shutdown(testPluginContext());

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
      const fixture = reloadHost({
        initial: terminalReloadFixturePlugin('v1', terminalLog),
        reloader: {
          // The race abandons this promise without cancelling it, so it stays
          // tracked for the rest of the process.
          reload: () => new Promise(() => undefined),
        },
      });
      const resultPromise = fixture.approve();

      await vi.advanceTimersByTimeAsync(runtimePluginReloadTimeoutMs);
      expect(await resultPromise).toMatchObject({
        output: {appliesTo: 'next_launch'},
      });

      // Terminal dispatch is the one phase that must always finish, so without
      // a bound the session can never shut down.
      const shutdown = fixture.host.shutdown(testPluginContext());

      await vi.advanceTimersByTimeAsync(runtimePluginQuiesceTimeoutMs);
      await shutdown;

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
      const fixture = reloadHost({
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
      const resultPromise = fixture.approve();

      await vi.advanceTimersByTimeAsync(runtimePluginReloadTimeoutMs);
      expect(await resultPromise).toMatchObject({
        output: {appliesTo: 'next_launch'},
      });

      const shutdown = fixture.host.shutdown(testPluginContext());

      // Outlives the quiesce bound, so shutdown proceeds without it.
      await vi.advanceTimersByTimeAsync(runtimePluginQuiesceTimeoutMs);
      await shutdown;
      expect(terminalLog).toEqual(['v1:shutdown']);

      // The abandoned factory was never cancelled, and nothing reads the retired
      // list again, so this candidate must be torn down on arrival.
      settleLate?.(terminalReloadFixturePlugin('late', terminalLog));
      await vi.runAllTimersAsync();

      expect(terminalLog).toEqual(['v1:shutdown', 'late:shutdown']);
    } finally {
      vi.useRealTimers();
    }
  });
});
