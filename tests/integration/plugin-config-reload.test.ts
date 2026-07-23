import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {prepareConfiguredProject02PluginActivation} from '../../src/app/index.ts';
import {createConfiguredRuntimePluginReloader} from '../../src/app/plugin-reload.ts';
import {
  createRuntimePlugin,
  createRuntimePluginManifest,
  runtimePluginId,
} from '../../src/plugins/api/index.ts';
import type {RuntimePlugin} from '../../src/plugins/api/index.ts';
import {
  inspectRuntimePluginConfig,
  loadProject02RuntimeConfig,
} from '../../src/runtime/config/index.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
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
    manifest: manifest as Parameters<
      typeof inspectRuntimePluginConfig
    >[0]['manifest'],
    configPath: options.configPath,
    storeRoot: options.storeRoot,
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
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),
      storeRoot,
      env: {},
    });
    const reloader = createConfiguredRuntimePluginReloader({activationPlan});

    const rebuilt = await reloader.reload('demo-config', {
      expectedFingerprint: authoredFingerprint({
        activationPlan,
        configPath,
        storeRoot,
      }),
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
    });
    const unknown = await reloader.reload('nope.not-installed', {
      expectedFingerprint: currentFingerprint,
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
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),
      storeRoot,
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
    expect(activationPlan.pluginConfigControl.characterScope).toMatchObject({
      characterId: 'mira',
    });
    // The overlay layer already governs the resolved value.
    expect(
      activationPlan.resolvedConfig.pluginConfigs['demo-config']?.['tone'],
    ).toMatchObject({value: 'formal'});

    const reloader = createConfiguredRuntimePluginReloader({activationPlan});
    const rebuilt = await reloader.reload('demo-config', {
      expectedFingerprint: inspectedFingerprint,
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
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),
      storeRoot,
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
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),
      storeRoot,
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
    });

    expect(result.status).toBe('declined');
    if (result.status === 'declined') {
      expect(result.reason).toContain('moved past');
    }
  });

  it('hands the constructed instance back when the rebuilt manifest mismatches', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-reload-mismatch-');
    const configPath = join(storeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
    });

    const activationPlan = prepareConfiguredProject02PluginActivation({
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),
      storeRoot,
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
            load: async input => {
              const original = await entry.load(input);

              constructed = createRuntimePlugin({
                manifest: createRuntimePluginManifest({
                  ...original.manifest,
                  version: '2.0.0-drifted',
                }),
                lifecycleHooks: original.lifecycleHooks,
              });
              return constructed;
            },
          },
        },
      },
    });

    const result = await reloader.reload('demo-config', {
      expectedFingerprint: authoredFingerprint({
        activationPlan,
        configPath,
        storeRoot,
      }),
    });

    if (result.status !== 'declined') {
      throw new Error(`Expected declined, got ${result.status}`);
    }
    expect(result.reason).toContain('no longer matches');
    // The factory ran, so the declined result must carry the instance for
    // the host to retire into terminal lifecycle dispatch.
    expect(constructed).toBeDefined();
    expect(result.plugin).toBe(constructed);
  });

  it('declines an id-drifted rebuild without handing the instance back', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-reload-id-drift-');
    const configPath = join(storeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
    });

    const activationPlan = prepareConfiguredProject02PluginActivation({
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),
      storeRoot,
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
              const original = await entry.load(input);

              return createRuntimePlugin({
                manifest: createRuntimePluginManifest({
                  ...original.manifest,
                  id: 'demo-config-drifted',
                }),
                lifecycleHooks: original.lifecycleHooks,
              });
            },
          },
        },
      },
    });

    const result = await reloader.reload('demo-config', {
      expectedFingerprint: authoredFingerprint({
        activationPlan,
        configPath,
        storeRoot,
      }),
    });

    if (result.status !== 'declined') {
      throw new Error(`Expected declined, got ${result.status}`);
    }
    expect(result.reason).toContain('different plugin id');
    // Retirement resolves access by the instance's own id, so an id-drifted
    // product is never handed back for ordinary lifecycle dispatch.
    expect(result.plugin).toBeUndefined();
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
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),
      storeRoot,
      env: {},
    });
    const reloader = createConfiguredRuntimePluginReloader({activationPlan});

    const result = await reloader.reload('demo-config', {
      expectedFingerprint: authoredFingerprint({
        activationPlan,
        configPath,
        storeRoot,
      }),
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
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),
      storeRoot,
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

    const result = await reloader.reload('demo-config', {
      expectedFingerprint: authoredFingerprint({
        activationPlan,
        configPath,
        storeRoot,
      }),
    });

    if (result.status !== 'declined') {
      throw new Error(`Expected declined, got ${result.status}`);
    }
    expect(result.reason).toContain('moved while the factory');
    // The instance was constructed before the decline, so it comes back for
    // retirement.
    expect(result.plugin).toBeDefined();
  });

  it('declines a reload when the refreshed config is invalid', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-reload-invalid-');
    const configPath = join(storeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
    });

    const activationPlan = prepareConfiguredProject02PluginActivation({
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),
      storeRoot,
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
    });

    expect(result.status).toBe('declined');
  });
});
