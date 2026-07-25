import {prepareConfiguredProject02PluginActivation} from '../../src/app/index.ts';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {createConfiguredRuntimePluginReloader} from '../../src/app/plugin-reload.ts';
import {
  createPreparedRuntimePluginConfigEffect,
  createRuntimePlugin,
  createRuntimePluginManifest,
  runtimePluginId,
} from '../../src/plugins/api/index.ts';
import type {RuntimePlugin} from '../../src/plugins/api/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import {acceptRuntimePluginPackageCandidate} from '../../src/plugins/package-loader/index.ts';
import {
  loadProject02RuntimeConfig,
  inspectRuntimePluginConfig,
} from '../../src/runtime/config/index.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {
  writeRuntimeConfig,
  runtimeLocationForTest,
} from '../support/runtime-config.ts';
import {initializeCharacterDataForHost} from '../support/runtime-config-fixtures.ts';
import {testPluginContext} from '../support/plugin-host-fixtures.ts';

async function demoConfigContextText(plugin: {
  readonly lifecycleHooks: {
    readonly beforeRoleModelCall?: (
      context: ReturnType<typeof testPluginContext>,
    ) => unknown;
  };
}): Promise<string> {
  const hook = plugin.lifecycleHooks.beforeRoleModelCall;

  if (hook === undefined) {
    throw new Error('demo-config must register beforeRoleModelCall');
  }

  const result = (await hook(testPluginContext())) as {
    contextItems: ReadonlyArray<{text: string}>;
  };

  return result.contextItems.map(item => item.text).join('|');
}

function authoredFingerprint(options: {
  readonly activationPlan: {
    readonly pluginConfigControl: {
      readonly pluginManifests: ReadonlyArray<{readonly id: string}>;
    };
  };
  readonly configPath: string;
  readonly storeRoot: string;
}): string {
  const manifest =
    options.activationPlan.pluginConfigControl.pluginManifests.find(
      candidate => candidate.id === 'demo-config',
    );

  if (manifest === undefined) {
    throw new Error('demo-config manifest missing from the plan');
  }

  return inspectRuntimePluginConfig({
    targetScope: 'character',
    runtimeLocation: runtimeLocationForTest({
      configPath: options.configPath,
      storeRoot: options.storeRoot,
      env: {},
    }),
    manifest: manifest as Parameters<
      typeof inspectRuntimePluginConfig
    >[0]['manifest'],

    env: {},
  }).fingerprint;
}

describe('configured runtime plugin reloader', () => {
  it('rebuilds a package plugin from freshly authored config and declines the rest', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-reload-');
    const configPath = join(storeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      plugins: {
        'demo-config': {enabled: true, config: {tone: 'warm'}},
      },
    });

    const activationPlan = prepareConfiguredProject02PluginActivation({
      runtimeLocation: runtimeLocationForTest({
        loadedConfig: loadProject02RuntimeConfig({
          configPath,
          storeRoot,
          env: {},
        }),
        configPath,
        storeRoot: storeRoot,
        env: {},
      }),
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),

      env: {},
    });
    const reloader = createConfiguredRuntimePluginReloader({activationPlan});

    const rebuilt = await reloader.reload('demo-config', {
      expectedFingerprint: authoredFingerprint({
        activationPlan,
        configPath,
        storeRoot,
      }),
      retainCandidate: () => undefined,
    });

    if (rebuilt.status !== 'rebuilt') {
      throw new Error(`Expected rebuilt, got ${rebuilt.status}`);
    }
    expect(await demoConfigContextText(rebuilt.plugin)).toContain('warm tone');

    const authored = loadProject02RuntimeConfig({
      configPath,
      storeRoot,
      env: {},
    });

    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          ...(authored.config ?? {}),
          plugins: {
            'demo-config': {enabled: true, config: {tone: 'playful'}},
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const refreshed = await reloader.reload('demo-config', {
      expectedFingerprint: authoredFingerprint({
        activationPlan,
        configPath,
        storeRoot,
      }),
      retainCandidate: () => undefined,
    });

    if (refreshed.status !== 'rebuilt') {
      throw new Error(`Expected rebuilt, got ${refreshed.status}`);
    }
    expect(await demoConfigContextText(refreshed.plugin)).toContain(
      'playful tone',
    );

    const currentFingerprint = authoredFingerprint({
      activationPlan,
      configPath,
      storeRoot,
    });
    const hostService = await reloader.reload(runtimePluginId, {
      expectedFingerprint: currentFingerprint,
      retainCandidate: () => undefined,
    });
    const unknown = await reloader.reload('nope.not-installed', {
      expectedFingerprint: currentFingerprint,
      retainCandidate: () => undefined,
    });

    expect(hostService.status).toBe('declined');
    expect(unknown.status).toBe('declined');
  });

  it('keeps the construction stamp, inspection, and reloader on one layered fingerprint across both authored files', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-reload-overlay-');
    const configPath = join(storeRoot, 'config.json');
    const overlayPath = join(
      storeRoot,
      'character-data',
      'mira',
      'config.json',
    );

    writeRuntimeConfig(configPath, {
      plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
    });
    mkdirSync(dirname(overlayPath), {recursive: true});
    writeRuntimeConfig(overlayPath, {
      plugins: {'demo-config': {config: {tone: 'formal'}}},
    });

    const activationPlan = prepareConfiguredProject02PluginActivation({
      runtimeLocation: runtimeLocationForTest({
        loadedConfig: loadProject02RuntimeConfig({
          configPath,
          storeRoot,
          env: {},
        }),
        configPath,
        storeRoot: storeRoot,
        env: {},
      }),
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),

      env: {},
    });

    // One currency chain: the plan's construction stamp equals what the
    // inspection path hands the model as expectedFingerprint.
    const inspectedFingerprint = authoredFingerprint({
      activationPlan,
      configPath,
      storeRoot,
    });

    expect(activationPlan.authoredConfigFingerprint).toBe(inspectedFingerprint);
    const configTarget =
      activationPlan.pluginConfigControl.configControl.target;

    expect(configTarget.scope).toBe('character');
    if (configTarget.scope !== 'character') {
      throw new TypeError('Expected a character-scoped config target.');
    }
    expect(configTarget.runtimeLocation.characterScope).toMatchObject({
      characterId: 'mira',
    });
    // The overlay layer already governs the resolved value.
    expect(
      activationPlan.resolvedConfig.pluginConfigs['demo-config']?.['tone'],
    ).toMatchObject({value: 'formal'});

    const reloader = createConfiguredRuntimePluginReloader({activationPlan});
    const rebuilt = await reloader.reload('demo-config', {
      expectedFingerprint: inspectedFingerprint,
      retainCandidate: () => undefined,
    });

    if (rebuilt.status !== 'rebuilt') {
      throw new Error(`Expected rebuilt, got ${rebuilt.status}`);
    }
    expect(await demoConfigContextText(rebuilt.plugin)).toContain(
      'formal tone',
    );

    // An overlay edit after approval is a moved authored config: the
    // reload declines instead of rebuilding from a stale layer pair.
    writeRuntimeConfig(overlayPath, {
      plugins: {'demo-config': {config: {tone: 'pirate'}}},
    });

    const tampered = await reloader.reload('demo-config', {
      expectedFingerprint: inspectedFingerprint,
      retainCandidate: () => undefined,
    });

    if (tampered.status !== 'declined') {
      throw new Error(`Expected declined, got ${tampered.status}`);
    }
    expect(tampered.reason).toContain('moved past');
  });

  it('refuses to reload from a data directory rebound to another character', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-reload-rebind-');
    const configPath = join(storeRoot, 'config.json');
    const overlayPath = join(
      storeRoot,
      'character-data',
      'mira',
      'config.json',
    );

    writeRuntimeConfig(configPath, {
      plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
    });
    mkdirSync(dirname(overlayPath), {recursive: true});
    writeRuntimeConfig(overlayPath, {
      plugins: {'demo-config': {config: {tone: 'formal'}}},
    });

    const activationPlan = prepareConfiguredProject02PluginActivation({
      runtimeLocation: runtimeLocationForTest({
        loadedConfig: loadProject02RuntimeConfig({
          configPath,
          storeRoot,
          env: {},
        }),
        configPath,
        storeRoot: storeRoot,
        env: {},
      }),
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),

      env: {},
    });
    const reloader = createConfiguredRuntimePluginReloader({activationPlan});

    // The data dir is rebound to another character after approval:
    // the reload must fail exactly as startup would refuse the store.
    writeFileSync(
      join(dirname(overlayPath), 'schema.json'),
      `${JSON.stringify({
        schemaVersion: 4,
        scope: 'character-data',
        characterId: 'nova',
        createdAt: '2026-07-23T00:00:00.000Z',
      })}\n`,
    );

    await expect(
      reloader.reload('demo-config', {
        expectedFingerprint: activationPlan.authoredConfigFingerprint,
        retainCandidate: () => undefined,
      }),
    ).rejects.toThrow('holds history for character "nova"');
  });

  it('declines when the authored config moved past the approved update', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-reload-moved-');
    const configPath = join(storeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
    });

    const activationPlan = prepareConfiguredProject02PluginActivation({
      runtimeLocation: runtimeLocationForTest({
        loadedConfig: loadProject02RuntimeConfig({
          configPath,
          storeRoot,
          env: {},
        }),
        configPath,
        storeRoot: storeRoot,
        env: {},
      }),
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),

      env: {},
    });
    const reloader = createConfiguredRuntimePluginReloader({activationPlan});
    const approvedFingerprint = authoredFingerprint({
      activationPlan,
      configPath,
      storeRoot,
    });

    writeRuntimeConfig(configPath, {
      plugins: {'demo-config': {enabled: true, config: {tone: 'playful'}}},
    });

    const result = await reloader.reload('demo-config', {
      expectedFingerprint: approvedFingerprint,
      retainCandidate: () => undefined,
    });

    expect(result.status).toBe('declined');
    if (result.status === 'declined') {
      expect(result.reason).toContain('moved past');
    }
  });

  it('retains the constructed instance before declining a rebuilt manifest mismatch', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-reload-mismatch-');
    const configPath = join(storeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
    });

    const activationPlan = prepareConfiguredProject02PluginActivation({
      runtimeLocation: runtimeLocationForTest({
        loadedConfig: loadProject02RuntimeConfig({
          configPath,
          storeRoot,
          env: {},
        }),
        configPath,
        storeRoot: storeRoot,
        env: {},
      }),
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),

      env: {},
    });
    const entry = activationPlan.catalogEntries['demo-config'];

    if (entry === undefined || entry.catalogKind !== 'package') {
      throw new Error('demo-config package entry missing from the plan');
    }

    let constructed: RuntimePlugin | undefined;
    const reloader = createConfiguredRuntimePluginReloader({
      activationPlan: {
        ...activationPlan,
        catalogEntries: {
          ...activationPlan.catalogEntries,
          'demo-config': {
            ...entry,
            load: async (input, loadOptions) => {
              const original = await entry.load(input);

              constructed = createRuntimePlugin({
                manifest: createRuntimePluginManifest({
                  ...original.manifest,
                  version: '2.0.0-drifted',
                }),
                lifecycleHooks: original.lifecycleHooks,
              });
              return acceptRuntimePluginPackageCandidate({
                manifest: entry.manifest,
                candidate: constructed,
                ...(loadOptions?.retainRejectedCandidate === undefined
                  ? {}
                  : {
                      retainRejectedCandidate:
                        loadOptions.retainRejectedCandidate,
                    }),
              });
            },
          },
        },
      },
    });

    const retained: RuntimePlugin[] = [];
    await expect(
      reloader.reload('demo-config', {
        expectedFingerprint: authoredFingerprint({
          activationPlan,
          configPath,
          storeRoot,
        }),
        retainCandidate: plugin => retained.push(plugin),
      }),
    ).rejects.toThrow('factory returned a different manifest');
    // Package acceptance owns the manifest check and transfers a rejected
    // factory product before throwing.
    expect(constructed).toBeDefined();
    expect(retained).toEqual([constructed]);
  });

  it('returns an id-drifted candidate to the caller-owned rejection lifecycle', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-reload-id-drift-');
    const configPath = join(storeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
    });

    const activationPlan = prepareConfiguredProject02PluginActivation({
      runtimeLocation: runtimeLocationForTest({
        loadedConfig: loadProject02RuntimeConfig({
          configPath,
          storeRoot,
          env: {},
        }),
        configPath,
        storeRoot: storeRoot,
        env: {},
      }),
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),

      env: {},
    });
    const entry = activationPlan.catalogEntries['demo-config'];

    if (entry === undefined || entry.catalogKind !== 'package') {
      throw new Error('demo-config package entry missing from the plan');
    }

    const reloader = createConfiguredRuntimePluginReloader({
      activationPlan: {
        ...activationPlan,
        catalogEntries: {
          ...activationPlan.catalogEntries,
          'demo-config': {
            ...entry,
            load: async (input, loadOptions) => {
              const original = await entry.load(input);

              const candidate = createRuntimePlugin({
                manifest: createRuntimePluginManifest({
                  ...original.manifest,
                  id: 'demo-config-drifted',
                }),
                lifecycleHooks: original.lifecycleHooks,
              });

              return acceptRuntimePluginPackageCandidate({
                manifest: entry.manifest,
                candidate,
                ...(loadOptions?.retainRejectedCandidate === undefined
                  ? {}
                  : {
                      retainRejectedCandidate:
                        loadOptions.retainRejectedCandidate,
                    }),
              });
            },
          },
        },
      },
    });

    const retained: RuntimePlugin[] = [];
    await expect(
      reloader.reload('demo-config', {
        expectedFingerprint: authoredFingerprint({
          activationPlan,
          configPath,
          storeRoot,
        }),
        retainCandidate: plugin => retained.push(plugin),
      }),
    ).rejects.toThrow('factory returned a different manifest');
    expect(retained.map(plugin => plugin.manifest.id)).toEqual([
      'demo-config-drifted',
    ]);
  });

  it('rebuilds a valid target even when another plugin has config errors', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-reload-unrelated-');
    const configPath = join(storeRoot, 'config.json');

    // character-state carries an undeclared config field (a plugin-scoped
    // error); demo-config itself is valid and must still be reloadable.
    writeRuntimeConfig(configPath, {
      plugins: {
        'demo-config': {enabled: true, config: {tone: 'warm'}},
        'character-state': {config: {undeclared: 'boom'}},
      },
    });

    const activationPlan = prepareConfiguredProject02PluginActivation({
      runtimeLocation: runtimeLocationForTest({
        loadedConfig: loadProject02RuntimeConfig({
          configPath,
          storeRoot,
          env: {},
        }),
        configPath,
        storeRoot: storeRoot,
        env: {},
      }),
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),

      env: {},
    });
    const reloader = createConfiguredRuntimePluginReloader({activationPlan});

    const result = await reloader.reload('demo-config', {
      expectedFingerprint: authoredFingerprint({
        activationPlan,
        configPath,
        storeRoot,
      }),
      retainCandidate: () => undefined,
    });

    if (result.status !== 'rebuilt') {
      throw new Error(`Expected rebuilt, got ${result.status}`);
    }
    expect(await demoConfigContextText(result.plugin)).toContain('warm tone');
  });

  it('declines when the authored config moves while the factory is rebuilding', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-reload-race-');
    const configPath = join(storeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
    });

    const activationPlan = prepareConfiguredProject02PluginActivation({
      runtimeLocation: runtimeLocationForTest({
        loadedConfig: loadProject02RuntimeConfig({
          configPath,
          storeRoot,
          env: {},
        }),
        configPath,
        storeRoot: storeRoot,
        env: {},
      }),
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),

      env: {},
    });
    const entry = activationPlan.catalogEntries['demo-config'];

    if (entry === undefined || entry.catalogKind !== 'package') {
      throw new Error('demo-config package entry missing from the plan');
    }

    const reloader = createConfiguredRuntimePluginReloader({
      activationPlan: {
        ...activationPlan,
        catalogEntries: {
          ...activationPlan.catalogEntries,
          'demo-config': {
            ...entry,
            load: async input => {
              const plugin = await entry.load(input);

              // Another writer moves the config while the factory runs.
              writeRuntimeConfig(configPath, {
                plugins: {
                  'demo-config': {enabled: true, config: {tone: 'playful'}},
                },
              });
              return plugin;
            },
          },
        },
      },
    });

    const retained: RuntimePlugin[] = [];
    const result = await reloader.reload('demo-config', {
      expectedFingerprint: authoredFingerprint({
        activationPlan,
        configPath,
        storeRoot,
      }),
      retainCandidate: plugin => retained.push(plugin),
    });

    if (result.status !== 'declined') {
      throw new Error(`Expected declined, got ${result.status}`);
    }
    expect(result.reason).toContain('moved while the factory');
    expect(retained).toHaveLength(1);
  });

  it('retires a constructed candidate when the post-factory authored-state read fails', async () => {
    const storeRoot = createTestTempRoot(
      'project02-plugin-reload-post-factory-read-',
    );
    const configPath = join(storeRoot, 'config.json');
    const lifecycleLog: string[] = [];

    writeRuntimeConfig(configPath, {
      plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
    });
    await initializeCharacterDataForHost(storeRoot);

    const loadedConfig = loadProject02RuntimeConfig({
      configPath,
      storeRoot,
      env: {},
    });
    const activationPlan = prepareConfiguredProject02PluginActivation({
      runtimeLocation: runtimeLocationForTest({
        loadedConfig,
        configPath,
        storeRoot,
        env: {},
      }),
      loadedConfig,
      env: {},
    });
    const entry = activationPlan.catalogEntries['demo-config'];

    if (entry === undefined || entry.catalogKind !== 'package') {
      throw new Error('demo-config package entry missing from the plan');
    }

    const trackedManifest = createRuntimePluginManifest({
      ...entry.manifest,
      declaredPlugins: [...entry.manifest.declaredPlugins, 'on_session_end'],
    });
    const trackedPlugin = (label: string) =>
      createRuntimePlugin({
        manifest: trackedManifest,
        lifecycleHooks: {
          beforeRoleModelCall: () => ({contextItems: [], evidence: []}),
          onSessionEnd: () => {
            lifecycleLog.push(label);
            return {status: 'completed' as const, evidence: []};
          },
        },
      });
    const pluginConfigControl = {
      ...activationPlan.pluginConfigControl,
      pluginManifests: activationPlan.pluginConfigControl.pluginManifests.map(
        manifest =>
          manifest.id === trackedManifest.id ? trackedManifest : manifest,
      ),
    };
    const reloader = createConfiguredRuntimePluginReloader({
      activationPlan: {
        ...activationPlan,
        pluginConfigControl,
        catalogEntries: {
          ...activationPlan.catalogEntries,
          'demo-config': {
            ...entry,
            manifest: trackedManifest,
            load: () => {
              const candidate = trackedPlugin('candidate');

              // Simulate the character marker becoming unreadable only after
              // the replacement factory has allocated its instance.
              writeFileSync(
                join(
                  activationPlan.runtimeLocation.characterScope.dataRoot,
                  'schema.json',
                ),
                '{',
                'utf8',
              );
              return Promise.resolve(candidate);
            },
          },
        },
      },
    });
    const fingerprint = authoredFingerprint({
      activationPlan,
      configPath,
      storeRoot,
    });
    const host = createRuntimePluginHost({
      plugins: [trackedPlugin('live')],
      enabledPluginIds: ['demo-config'],
      pluginConfigControl,
      pluginReloader: reloader,
      constructionConfigFingerprint: fingerprint,
    });
    const effect = createPreparedRuntimePluginConfigEffect({
      eventId: 'event-post-factory-read',
      traceId: 'trace-post-factory-read',
      createdAt: '2026-07-25T00:00:00.000Z',
      kind: 'runtime_plugin_config_effect',
      effectId: 'effect-post-factory-read',
      targetPluginId: 'demo-config',
      targetConfigPath: configPath,
      fieldName: 'tone',
      expectedFingerprint: fingerprint,
      resultFingerprint: fingerprint,
      operation: {kind: 'set', value: 'warm'},
    });

    const result = await host.reloadPluginForCommittedConfig?.([effect]);

    expect(result?.outcome).toBe('failed');
    await host.onSessionEnd(testPluginContext(), {
      allowFileStoreWrites: false,
    });
    expect(lifecycleLog).toEqual(['candidate', 'live']);
  });

  it('declines a reload when the refreshed config is invalid', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-reload-invalid-');
    const configPath = join(storeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
    });

    const activationPlan = prepareConfiguredProject02PluginActivation({
      runtimeLocation: runtimeLocationForTest({
        loadedConfig: loadProject02RuntimeConfig({
          configPath,
          storeRoot,
          env: {},
        }),
        configPath,
        storeRoot: storeRoot,
        env: {},
      }),
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),

      env: {},
    });
    const reloader = createConfiguredRuntimePluginReloader({activationPlan});

    const approvedFingerprint = authoredFingerprint({
      activationPlan,
      configPath,
      storeRoot,
    });

    writeFileSync(
      configPath,
      `${JSON.stringify({version: 'project02.config.unsupported'})}\n`,
      'utf8',
    );

    const result = await reloader.reload('demo-config', {
      expectedFingerprint: approvedFingerprint,
      retainCandidate: () => undefined,
    });

    expect(result.status).toBe('declined');
  });
});
