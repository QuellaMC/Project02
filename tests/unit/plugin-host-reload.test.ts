import {describe, expect, it} from 'vitest';

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
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import type {RuntimePluginReloader} from '../../src/plugins/host/index.ts';
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
      sideEffectLevel: 'none',
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
}) {
  return createRuntimePluginHost({
    plugins: [options.initial ?? reloadFixturePlugin('v1')],
    enabledPluginIds: [reloadPluginId],
    pluginConfigControl: {
      control: testRuntimePluginConfigControlCapability,
      pluginManifests: [reloadFixtureManifest()],
    },
    ...(options.reloader === undefined
      ? {}
      : {pluginReloader: options.reloader}),
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
          requiredForUserTurn: false,
          inputContract: {type: 'object', fields: [], additionalFields: false},
          validationOwner: 'plugin_host',
          sideEffectLevel: 'none',
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
        reload: () =>
          Promise.resolve({status: 'rebuilt', plugin: hollowRebuild}),
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

  it('retires an instance handed back with a declined reload', async () => {
    const sessionEndLog: string[] = [];
    const orphan = reloadFixturePlugin('orphan', sessionEndLog);
    const host = reloadHost({
      initial: reloadFixturePlugin('v1', sessionEndLog),
      reloader: {
        reload: () =>
          Promise.resolve({
            status: 'declined',
            reason: 'manifest drifted after construction',
            plugin: orphan,
          }),
      },
    });

    const result = await host.reloadPluginForCommittedConfig?.([toneEffect()]);

    expect(result?.outcome).toBe('deferred');
    expect(await contextText(host)).toBe('v1');
    await host.onSessionEnd(testPluginContext(), {allowFileStoreWrites: false});
    expect(sessionEndLog.sort()).toEqual(['orphan', 'v1']);
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
    expect(sessionEndLog.sort()).toEqual(['v1', 'v2']);
  });

  it('defers when the host has no reloader', async () => {
    const host = reloadHost({});

    const result = await host.reloadPluginForCommittedConfig?.([toneEffect()]);

    expect(result?.outcome).toBe('deferred');
    expect(result?.evidence?.summary).toContain('no plugin reloader');
    expect(await contextText(host)).toBe('v1');
  });
});
