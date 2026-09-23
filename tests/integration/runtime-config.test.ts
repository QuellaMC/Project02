import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {createTestTempRoot} from '../support/temp-root.ts';
import {characterDataDirPath} from '../../src/runtime/storage/index.ts';
import {
  createConfiguredProject02PluginHostFromPlan,
  prepareConfiguredProject02PluginActivation,
} from '../../src/app/index.ts';
import {
  characterOverlayConfigPath,
  createRuntimeConfigInspectShape,
  resolveProject02RuntimeConfig,
} from '../../src/runtime/config/index.ts';
import {
  hostScopedFirstPartyRuntimePluginIds,
  runtimePluginId,
} from '../../src/plugins/index.ts';
import {
  createCharacterStatePlugin,
  createCharacterStatePluginManifest,
} from '../../src/plugins/packages/character-state/plugin.ts';
import {
  checkRuntimeConfigForTest,
  writeRuntimeConfig,
  runtimeConfigSnapshotForTest,
  loadRuntimeConfigForTest,
} from '../support/runtime-config.ts';
import {
  activationPluginById,
  initializeCharacterDataForHost,
  memoryProviderPlugin,
  requiredDottedConfigPlugin,
} from '../support/runtime-config-fixtures.ts';
import {
  nonHostScopedActivationPlugins,
  requiredSecretPlugin,
} from '../support/runtime-config-activation-fixtures.ts';

describe('runtime config loading and resolution', () => {
  it('preserves no-config behavior with source none and default store root', () => {
    const storeRoot = createTestTempRoot('project02-config-empty-');
    const loaded = loadRuntimeConfigForTest({storeRoot});
    const resolved = resolveProject02RuntimeConfig({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loaded,
        storeRoot: storeRoot,
      }),
    });

    expect(loaded.source).toBe('none');
    expect(resolved.project02.storeRoot).toBe(realpathSync.native(storeRoot));
    expect(Object.hasOwn(resolved, 'storeRoot')).toBe(false);
    expect(Object.hasOwn(resolved, 'defaultMemoryProvider')).toBe(false);
    expect(Object.hasOwn(resolved, 'roleModelProvider')).toBe(false);
    const inspection = createRuntimeConfigInspectShape(resolved);

    expect(inspection.project02.storeRoot).toBe(realpathSync.native(storeRoot));
    expect(Object.hasOwn(inspection, 'storeRoot')).toBe(false);
    expect(Object.hasOwn(inspection, 'defaultMemoryProvider')).toBe(false);
    expect(Object.hasOwn(inspection, 'roleModelProvider')).toBe(false);
    expect(resolved.diagnostics).toEqual([]);
  });

  it('trims authored user display names so speaker construction never crashes', () => {
    const storeRoot = createTestTempRoot('project02-config-user-name-');
    const configPath = join(storeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      project02: {userDisplayName: '  Mike  '},
    });

    const resolved = resolveProject02RuntimeConfig({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({storeRoot}),
        storeRoot: storeRoot,
      }),
    });

    expect(resolved.project02.userDisplayName).toBe('Mike');
  });

  it('resolves the context window to its default and fingerprints a configured one', () => {
    const storeRoot = createTestTempRoot('project02-config-context-window-');
    const configPath = join(storeRoot, 'config.json');
    const resolveFrom = () =>
      resolveProject02RuntimeConfig({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({storeRoot}),
          storeRoot,
        }),
      });

    writeRuntimeConfig(configPath, {project02: {}});
    const defaulted = resolveFrom();

    expect(defaulted.project02.contextWindowTokens).toBe(32768);
    expect(
      createRuntimeConfigInspectShape(defaulted).project02.contextWindowTokens,
    ).toBe(32768);

    writeRuntimeConfig(configPath, {project02: {contextWindowTokens: 8192}});
    const configured = resolveFrom();

    expect(configured.project02.contextWindowTokens).toBe(8192);
    expect(configured.effectiveConfigFingerprint).not.toBe(
      defaulted.effectiveConfigFingerprint,
    );
  });

  it('includes plugin enablement in the effective config fingerprint', () => {
    const storeRoot = createTestTempRoot(
      'project02-config-plugin-fingerprint-',
    );
    const configPath = join(storeRoot, 'config.json');
    const resolveFrom = () =>
      resolveProject02RuntimeConfig({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({configPath}),
          configPath,
        }),
      });

    writeRuntimeConfig(configPath, {});
    const withoutPlugin = resolveFrom();

    writeRuntimeConfig(configPath, {plugins: {memory: {enabled: true}}});
    const withEnabledPlugin = resolveFrom();

    expect(withEnabledPlugin.effectiveConfigFingerprint).not.toBe(
      withoutPlugin.effectiveConfigFingerprint,
    );
  });

  it('rejects unknown top-level config fields and blocks default activation', async () => {
    const storeRoot = createTestTempRoot('project02-config-unknown-root-');
    await initializeCharacterDataForHost(storeRoot);
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      store_root: 'typo-store',
    });
    const loaded = loadRuntimeConfigForTest({configPath});

    expect(loaded.config).toBeUndefined();
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_config_unknown_top_level_field',
        path: 'store_root',
      }),
    ]);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loaded,
          storeRoot,
        }),
      }),
    });

    expect(configured.activation.enabledPluginIds).not.toContain(
      'character-state',
    );
    expect(
      activationPluginById(configured.activation.plugins, 'character-state'),
    ).toMatchObject({
      pluginId: 'character-state',
      enabled: false,
      activationStatus: 'blocked',
    });

    const check = await checkRuntimeConfigForTest({storeRoot});

    expect(check.ok).toBe(false);
    expect(check.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_unknown_top_level_field',
          path: 'store_root',
        }),
      ]),
    );
  });

  it('rejects unknown plugin wrapper fields and blocks that plugin activation', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-unknown-plugin-wrapper-',
    );
    await initializeCharacterDataForHost(storeRoot);
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'character-state': {
          enable: false,
        },
      },
    });
    const loaded = loadRuntimeConfigForTest({configPath});

    expect(loaded.config).toBeUndefined();
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_config_unknown_plugin_wrapper_field',
        path: 'plugins.character-state.enable',
        pluginId: 'character-state',
      }),
    ]);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loaded,
          storeRoot,
        }),
      }),
    });

    expect(configured.activation.enabledPluginIds).not.toContain(
      'character-state',
    );
    const characterStateActivation = activationPluginById(
      configured.activation.plugins,
      'character-state',
    );

    expect(characterStateActivation).toMatchObject({
      pluginId: 'character-state',
      enabled: false,
      activationStatus: 'blocked',
    });
    expect(characterStateActivation?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_unknown_plugin_wrapper_field',
          path: 'plugins.character-state.enable',
        }),
      ]),
    );

    const check = await checkRuntimeConfigForTest({storeRoot});

    expect(check.ok).toBe(false);
    expect(check.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_unknown_plugin_wrapper_field',
        }),
      ]),
    );
    expect(check.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: 'character-state',
        activationStatus: 'blocked',
      }),
    );
  });

  it('treats unknown plugin wrapper load errors as global activation blockers', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-unknown-plugin-global-',
    );
    await initializeCharacterDataForHost(storeRoot);
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        unknown: {
          enable: true,
        },
      },
    });
    const loaded = loadRuntimeConfigForTest({configPath});
    let factoryCalls = 0;

    expect(loaded.config).toBeUndefined();
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_config_unknown_plugin_wrapper_field',
        path: 'plugins.unknown.enable',
        pluginId: 'unknown',
      }),
    ]);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loaded,
          storeRoot,
          factories: {
            'character-state': {
              manifest: createCharacterStatePluginManifest(),
              create() {
                factoryCalls += 1;

                return createCharacterStatePlugin();
              },
            },
          },
        }),
      }),
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([runtimePluginId]);
    const characterStateActivation = activationPluginById(
      configured.activation.plugins,
      'character-state',
    );

    expect(characterStateActivation).toMatchObject({
      pluginId: 'character-state',
      enabled: false,
      activationStatus: 'blocked',
    });
    // The injected factory displaces the bundled package, so the only
    // diagnostic is the provenance warning that withholds trusted_context.
    const injectedFactoryDiagnostics = [
      expect.objectContaining({
        code: 'trusted_context_not_first_party',
        severity: 'warning',
      }),
    ];
    expect(characterStateActivation?.diagnostics).toEqual(
      injectedFactoryDiagnostics,
    );
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_unknown_plugin_wrapper_field',
          path: 'plugins.unknown.enable',
          pluginId: 'unknown',
        }),
      ]),
    );
  });

  it('treats known plugin wrapper load errors as global activation blockers', async () => {
    const badPlugin = requiredSecretPlugin('bad');
    const storeRoot = createTestTempRoot(
      'project02-config-known-plugin-global-',
    );
    await initializeCharacterDataForHost(storeRoot);
    // The global blocking only shows on a separately enabled plugin, and the
    // failing document cannot be the one that enables it.
    writeRuntimeConfig(
      characterOverlayConfigPath(characterDataDirPath(storeRoot, 'mira')),
      {plugins: {'character-state': {enabled: true}}},
    );
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        bad: {
          enable: true,
        },
      },
    });
    const loaded = loadRuntimeConfigForTest({configPath});
    let manifestBackedFactoryCalls = 0;

    expect(loaded.config).toBeUndefined();
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_config_unknown_plugin_wrapper_field',
        path: 'plugins.bad.enable',
        pluginId: 'bad',
      }),
    ]);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loaded,
          storeRoot,
          factories: {
            'character-state': {
              manifest: createCharacterStatePluginManifest(),
              create() {
                manifestBackedFactoryCalls += 1;
                throw new Error('unrelated factory should not be constructed');
              },
            },
            bad: {
              manifest: badPlugin.manifest,
              create() {
                manifestBackedFactoryCalls += 1;
                throw new Error(
                  'invalid plugin factory should not be constructed',
                );
              },
            },
          },
        }),
      }),
    });
    const badActivation = configured.activation.plugins.find(
      plugin => plugin.pluginId === 'bad',
    );
    const characterActivation = configured.activation.plugins.find(
      plugin => plugin.pluginId === 'character-state',
    );

    expect(manifestBackedFactoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([runtimePluginId]);
    expect(characterActivation).toMatchObject({
      pluginId: 'character-state',
      enabled: false,
      activationStatus: 'blocked',
    });
    expect(characterActivation?.diagnostics).toEqual([
      expect.objectContaining({
        code: 'trusted_context_not_first_party',
        severity: 'warning',
      }),
    ]);
    expect(badActivation).toMatchObject({
      pluginId: 'bad',
      enabled: false,
      activationStatus: 'blocked',
    });
    expect(badActivation?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_unknown_plugin_wrapper_field',
          path: 'plugins.bad.enable',
          pluginId: 'bad',
        }),
      ]),
    );
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_unknown_plugin_wrapper_field',
          path: 'plugins.bad.enable',
          pluginId: 'bad',
        }),
      ]),
    );
  });

  it('redacts an inline secret and keeps the fingerprint independent of its value', () => {
    const plugin = createCharacterStatePlugin();
    const manifest = {
      ...plugin.manifest,
      config: {
        scope: 'global_with_character_overrides' as const,
        fields: [
          {
            name: 'apiKey',
            description: 'API key.',
            required: true,
            secret: true,
            valueType: 'secret' as const,
            redactionLabels: ['secret'],
          },
        ],
      },
    };
    const configPath = join(
      createTestTempRoot('project02-config-secret-'),
      'config.json',
    );
    const resolveWithSecret = (apiKey: string) =>
      resolveProject02RuntimeConfig({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({
            configPath: writeRuntimeConfig(configPath, {
              plugins: {[plugin.manifest.id]: {config: {apiKey}}},
            }),
          }),
          configPath,
        }),
        pluginManifests: [manifest],
      });
    const first = resolveWithSecret('first-secret');
    const second = resolveWithSecret('second-secret');

    expect(first.pluginConfigs['character-state']?.['apiKey']).toMatchObject({
      value: 'first-secret',
      source: 'config',
      resolved: true,
    });
    expect(
      first.redactedPluginConfigs['character-state']?.['apiKey'],
    ).toMatchObject({value: '[redacted]', source: 'config', resolved: true});
    expect(JSON.stringify(first.redactedPluginConfigs)).not.toContain(
      'first-secret',
    );
    expect(first.effectiveConfigFingerprint).not.toContain('first-secret');
    expect(first.effectiveConfigFingerprint).toBe(
      second.effectiveConfigFingerprint,
    );
  });

  it('includes per-plugin enabled flags in effective fingerprints without leaking secrets', () => {
    const plugin = requiredSecretPlugin();
    const configPath = join(
      createTestTempRoot('project02-config-enabled-fingerprint-'),
      'config.json',
    );
    const resolveWith = (enabled: boolean, apiKey: string) =>
      resolveProject02RuntimeConfig({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({
            configPath: writeRuntimeConfig(configPath, {
              plugins: {[plugin.manifest.id]: {enabled, config: {apiKey}}},
            }),
          }),
          configPath,
        }),
        pluginManifests: [plugin.manifest],
      });
    const enabledFirst = resolveWith(true, 'first-secret');
    const enabledSecond = resolveWith(true, 'second-secret');
    const disabled = resolveWith(false, 'first-secret');

    expect(enabledFirst.effectiveConfigFingerprint).toBe(
      enabledSecond.effectiveConfigFingerprint,
    );
    expect(enabledFirst.effectiveConfigFingerprint).not.toBe(
      disabled.effectiveConfigFingerprint,
    );
    expect(JSON.stringify(enabledFirst.redactedPluginConfigs)).not.toContain(
      'first-secret',
    );
    expect(enabledFirst.effectiveConfigFingerprint).not.toContain(
      'first-secret',
    );
  });

  it('redacts credential-like non-secret config field names from inspectable config and fingerprints', () => {
    const plugin = createCharacterStatePlugin();
    const manifest = {
      ...plugin.manifest,
      config: {
        scope: 'global_with_character_overrides' as const,
        fields: [
          {
            name: 'apiKey',
            description: 'Compatibility API key field.',
            required: false,
            secret: false,
            valueType: 'string' as const,
            redactionLabels: [],
          },
          {
            name: 'token',
            description: 'Compatibility token field.',
            required: false,
            secret: false,
            valueType: 'string' as const,
            redactionLabels: [],
          },
          {
            name: 'metadata',
            description: 'Structured metadata.',
            required: false,
            secret: false,
            valueType: 'object' as const,
            redactionLabels: [],
          },
        ],
      },
    };
    const configPath = join(
      createTestTempRoot('project02-config-credential-fields-'),
      'config.json',
    );
    const resolveWith = (prefix: string) =>
      resolveProject02RuntimeConfig({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({
            configPath: writeRuntimeConfig(configPath, {
              plugins: {
                [plugin.manifest.id]: {
                  config: {
                    apiKey: `${prefix}-api-key`,
                    token: `${prefix}-token`,
                    metadata: {
                      access_token: `${prefix}-nested-token`,
                      label: 'visible-label',
                    },
                  },
                },
              },
            }),
          }),
          configPath,
        }),
        pluginManifests: [manifest],
      });
    const first = resolveWith('first');
    const second = resolveWith('second');

    expect(first.pluginConfigs['character-state']?.['apiKey']?.value).toBe(
      'first-api-key',
    );
    expect(first.redactedPluginConfigs['character-state']).toMatchObject({
      apiKey: {
        secret: false,
        value: '[redacted]',
      },
      token: {
        secret: false,
        value: '[redacted]',
      },
      metadata: {
        value: {
          access_token: '[redacted]',
          label: 'visible-label',
        },
      },
    });
    expect(JSON.stringify(first.redactedPluginConfigs)).not.toContain(
      'first-api-key',
    );
    expect(JSON.stringify(first.redactedPluginConfigs)).not.toContain(
      'first-token',
    );
    expect(JSON.stringify(first.redactedPluginConfigs)).not.toContain(
      'first-nested-token',
    );
    expect(first.effectiveConfigFingerprint).toBe(
      second.effectiveConfigFingerprint,
    );
  });

  it('accepts a plaintext secret in config', () => {
    const plugin = createCharacterStatePlugin();
    const loaded = loadRuntimeConfigForTest({
      configPath: writeRuntimeConfig(
        join(createTestTempRoot('project02-config-plaintext-'), 'config.json'),
        {
          plugins: {
            [plugin.manifest.id]: {
              enabled: true,
              config: {
                apiKey: 'plaintext-secret',
              },
            },
          },
        },
      ),
    });
    const manifests = [
      {
        ...plugin.manifest,
        config: {
          scope: 'global_with_character_overrides' as const,
          fields: [
            {
              name: 'apiKey',
              description: 'API key.',
              required: true,
              secret: true,
              valueType: 'secret' as const,
              redactionLabels: ['secret'],
            },
          ],
        },
      },
    ];
    const fromConfig = resolveProject02RuntimeConfig({
      ...runtimeConfigSnapshotForTest({loadedConfig: loaded}),
      pluginManifests: manifests,
    });

    // A key typed into config is the key; the plugin reads it as written.
    expect(
      fromConfig.pluginConfigs[plugin.manifest.id]?.['apiKey'],
    ).toMatchObject({
      source: 'config',
      resolved: true,
      value: 'plaintext-secret',
    });
    // Redacted views never show the value.
    expect(JSON.stringify(fromConfig.redactedPluginConfigs)).not.toContain(
      'plaintext-secret',
    );

    // A shape other than a string is rejected, never silently ignored.
    const invalid = resolveProject02RuntimeConfig({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({
          configPath: writeRuntimeConfig(
            join(
              createTestTempRoot('project02-config-secret-shape-'),
              'config.json',
            ),
            {
              plugins: {
                [plugin.manifest.id]: {
                  enabled: true,
                  config: {apiKey: {token: 'plaintext-secret'}},
                },
              },
            },
          ),
        }),
      }),
      pluginManifests: manifests,
    });

    expect(invalid.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_secret_value_invalid',
        }),
      ]),
    );
  });

  it('rejects a blank secret as invalid rather than reading it as absent', () => {
    const configPath = writeRuntimeConfig(
      join(createTestTempRoot('project02-config-empty-secret-'), 'config.json'),
      {
        plugins: {
          'memory.required': {
            config: {
              apiKey: '   ',
            },
          },
        },
      },
    );
    const resolved = resolveProject02RuntimeConfig({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({configPath}),
      }),
      pluginManifests: [requiredSecretPlugin().manifest],
    });
    const resolvedField = resolved.pluginConfigs['memory.required']?.['apiKey'];

    expect(resolvedField).toMatchObject({
      source: 'config',
      resolved: false,
    });
    expect(resolvedField).not.toHaveProperty('value');
    expect(resolved.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_secret_value_invalid',
          path: 'plugins.memory.required.config.apiKey',
        }),
      ]),
    );
  });

  it('rejects unknown config fields for enabled or default-enabled plugins', async () => {
    const plugin = requiredSecretPlugin();
    const storeRoot = createTestTempRoot('project02-config-unknown-field-');
    await initializeCharacterDataForHost(storeRoot);
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'memory.required': {
          config: {
            apiKey: 'configured-secret',
            zetaTypo: 'ignored',
            alphaTypo: 'ignored',
          },
        },
      },
    });
    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({configPath}),
          storeRoot,
          factories: {
            'memory.required': {
              manifest: plugin.manifest,
              create: () => plugin,
            },
          },
        }),
      }),
    });

    expect(configured.resolvedConfig.diagnostics).toEqual([
      expect.objectContaining({
        code: 'runtime_config_unknown_plugin_config_field',
        path: 'plugins.memory.required.config.alphaTypo',
      }),
      expect.objectContaining({
        code: 'runtime_config_unknown_plugin_config_field',
        path: 'plugins.memory.required.config.zetaTypo',
      }),
    ]);
    expect(configured.activation.enabledPluginIds).not.toContain(
      'memory.required',
    );
    const memoryRequiredActivation = activationPluginById(
      configured.activation.plugins,
      'memory.required',
    );

    expect(memoryRequiredActivation).toMatchObject({
      pluginId: 'memory.required',
      activationStatus: 'blocked',
    });
    expect(
      memoryRequiredActivation?.diagnostics.map(item => item.code),
    ).toEqual([
      'runtime_config_unknown_plugin_config_field',
      'runtime_config_unknown_plugin_config_field',
    ]);
  });

  it('blocks plugins when missing required dotted fields contain config', async () => {
    const plugin = requiredDottedConfigPlugin('memory');
    const missingPath = 'plugins.memory.config.api.config.key';
    const storeRoot = createTestTempRoot('project02-config-dotted-field-');
    await initializeCharacterDataForHost(storeRoot);
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    let factoryCalls = 0;

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({configPath}),
          storeRoot,
          factories: {
            memory: {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;

                return plugin;
              },
            },
          },
        }),
      }),
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).not.toContain('memory');
    expect(
      activationPluginById(configured.activation.plugins, 'memory'),
    ).toMatchObject({
      pluginId: 'memory',
      enabled: false,
      activationStatus: 'blocked',
    });
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_value_missing',
          path: missingPath,
        }),
      ]),
    );
    expect(
      activationPluginById(configured.activation.plugins, 'memory')
        ?.diagnostics,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_value_missing',
          path: missingPath,
        }),
      ]),
    );
  });

  it.each(['constructor', 'toString'] as const)(
    'reports prototype-named required plugin config field %s as missing',
    async fieldName => {
      const pluginId = 'memory.prototype-field';
      const plugin = requiredDottedConfigPlugin(pluginId, fieldName);
      const storeRoot = createTestTempRoot('project02-config-prototype-field-');
      await initializeCharacterDataForHost(storeRoot);
      const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
        plugins: {
          [pluginId]: {
            config: {},
          },
        },
      });
      let factoryCalls = 0;

      const configured = await createConfiguredProject02PluginHostFromPlan({
        activationPlan: prepareConfiguredProject02PluginActivation({
          ...runtimeConfigSnapshotForTest({
            loadedConfig: loadRuntimeConfigForTest({configPath}),
            storeRoot,
            factories: {
              [pluginId]: {
                manifest: plugin.manifest,
                create() {
                  factoryCalls += 1;
                  return plugin;
                },
              },
            },
          }),
        }),
      });

      expect(factoryCalls).toBe(0);
      expect(configured.activation.diagnostics).toContainEqual(
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_required_value_missing',
          path: `plugins.${pluginId}.config.${fieldName}`,
          pluginId,
          pluginConfigField: fieldName,
        }),
      );
    },
  );

  it('blocks all plugin factory creation when activation diagnostics contain plugin errors', async () => {
    const characterPlugin = createCharacterStatePlugin();
    const memoryPlugin = requiredSecretPlugin();
    const storeRoot = createTestTempRoot(
      'project02-config-plugin-error-blocks-all-',
    );
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'memory.required': {
          enabled: true,
        },
      },
    });
    await initializeCharacterDataForHost(storeRoot);
    let characterFactoryCalls = 0;
    let memoryFactoryCalls = 0;

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({configPath, storeRoot}),
          factories: {
            'character-state': {
              manifest: characterPlugin.manifest,
              create() {
                characterFactoryCalls += 1;

                return characterPlugin;
              },
            },
            'memory.required': {
              manifest: memoryPlugin.manifest,
              create() {
                memoryFactoryCalls += 1;

                return memoryPlugin;
              },
            },
          },
        }),
      }),
    });
    const characterActivation = configured.activation.plugins.find(
      plugin => plugin.pluginId === 'character-state',
    );
    const memoryActivation = configured.activation.plugins.find(
      plugin => plugin.pluginId === 'memory.required',
    );

    expect(characterFactoryCalls).toBe(0);
    expect(memoryFactoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([runtimePluginId]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_required_secret_missing',
          path: 'plugins.memory.required.config.apiKey',
          pluginId: 'memory.required',
          pluginConfigField: 'apiKey',
        }),
      ]),
    );
    expect(characterActivation).toMatchObject({
      pluginId: 'character-state',
      enabled: false,
      activationStatus: 'disabled',
    });
    expect(characterActivation?.activationReasons).toContain('not_enabled');
    expect(memoryActivation).toMatchObject({
      pluginId: 'memory.required',
      enabled: false,
      activationStatus: 'blocked',
    });
    expect(memoryActivation?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_secret_missing',
          path: 'plugins.memory.required.config.apiKey',
        }),
      ]),
    );
  });

  it('keeps explicitly disabled plugins disabled even when their config is incomplete', async () => {
    const plugin = requiredSecretPlugin();
    const storeRoot = createTestTempRoot('project02-config-disable-invalid-');
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'memory.required': {
          enabled: false,
          config: {
            misspelledApiKey: 'ignored',
          },
        },
      },
    });
    let factoryCalls = 0;

    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({configPath}),
          storeRoot,
          factories: {
            'memory.required': {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error('disabled plugin should not be constructed');
              },
            },
          },
        }),
      }),
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(
      activationPluginById(configured.activation.plugins, 'memory.required'),
    ).toMatchObject({
      pluginId: 'memory.required',
      enabled: false,
      activationStatus: 'disabled',
    });
    expect(
      activationPluginById(configured.activation.plugins, 'memory.required')
        ?.activationReasons,
    ).toContain('disabled_by_config');
    expect(
      configured.activation.diagnostics.map(item => item.code),
    ).not.toContain('runtime_config_required_secret_missing');
    expect(
      configured.activation.diagnostics.map(item => item.code),
    ).not.toContain('runtime_config_unknown_plugin_config_field');
  });

  it('creates manifest-backed configured plugin factories once with resolved config', async () => {
    const storeRoot = createTestTempRoot('project02-config-factory-');
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'memory.required': {
          enabled: true,
          config: {
            apiKey: 'from-manifest-backed-factory',
          },
        },
      },
    });
    let characterFactoryCalls = 0;
    let memoryFactoryCalls = 0;
    const memoryFactoryInputs: Array<{
      readonly pluginId: string;
      readonly storeRoot: string;
      readonly apiKeyValue: unknown;
      readonly redactedApiKeyValue: unknown;
    }> = [];

    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({configPath}),
          factories: {
            'character-state': {
              manifest: createCharacterStatePluginManifest(),
              create() {
                characterFactoryCalls += 1;

                return createCharacterStatePlugin();
              },
            },
            'memory.required': {
              manifest: requiredSecretPlugin().manifest,
              create(input) {
                memoryFactoryCalls += 1;
                memoryFactoryInputs.push({
                  pluginId: input.pluginId,
                  storeRoot: input.storeRoot,
                  apiKeyValue: input.resolvedConfig['apiKey']?.value,
                  redactedApiKeyValue: input.redactedConfig['apiKey']?.value,
                });

                return requiredSecretPlugin();
              },
            },
          },
        }),
      }),
    });

    expect(characterFactoryCalls).toBe(0);
    expect(memoryFactoryCalls).toBe(1);
    expect(memoryFactoryInputs).toEqual([
      {
        pluginId: 'memory.required',
        // Plugin state is character-scoped, not shared across the home.
        storeRoot: characterDataDirPath(realpathSync.native(storeRoot), 'mira'),
        apiKeyValue: 'from-manifest-backed-factory',
        redactedApiKeyValue: '[redacted]',
      },
    ]);
    expect(configured.activation.enabledPluginIds).toEqual([
      ...hostScopedFirstPartyRuntimePluginIds,
      'memory.required',
    ]);
  });

  it('plans inactive manifest-backed plugin factories without constructing them', async () => {
    const disabledPlugin = requiredSecretPlugin('memory.disabled');
    const blockedPlugin = requiredSecretPlugin('memory.blocked');
    const storeRoot = createTestTempRoot('project02-config-inactive-factory-');
    await initializeCharacterDataForHost(storeRoot);
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'memory.disabled': {
          enabled: false,
        },
        'memory.blocked': {
          enabled: true,
        },
      },
    });
    let factoryCalls = 0;

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({configPath}),
          storeRoot,
          factories: {
            'memory.disabled': {
              manifest: disabledPlugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error('disabled plugin should not be constructed');
              },
            },
            'memory.blocked': {
              manifest: blockedPlugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error('blocked plugin should not be constructed');
              },
            },
          },
        }),
      }),
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(
      nonHostScopedActivationPlugins(configured.activation.plugins).map(
        plugin => [plugin.pluginId, plugin.activationStatus],
      ),
    ).toEqual([
      ['memory.disabled', 'disabled'],
      ['memory.blocked', 'blocked'],
    ]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_secret_missing',
          path: 'plugins.memory.blocked.config.apiKey',
        }),
      ]),
    );
  });

  it('passes the home to manifest-backed plugin factories', async () => {
    const storeRoot = createTestTempRoot('project02-config-factory-home-');
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'memory.required': {
          enabled: true,
          config: {
            apiKey: 'from-the-home',
          },
        },
      },
    });
    let factoryStoreRoot: string | undefined;

    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({configPath}),
          configPath,
          factories: {
            'memory.required': {
              manifest: requiredSecretPlugin().manifest,
              create(input) {
                factoryStoreRoot = input.storeRoot;

                return requiredSecretPlugin();
              },
            },
          },
        }),
      }),
    });

    expect(factoryStoreRoot).toBe(
      characterDataDirPath(realpathSync.native(storeRoot), 'mira'),
    );
    expect(configured.resolvedConfig.project02.storeRoot).toBe(
      realpathSync.native(storeRoot),
    );
  });

  it('fails activation checks when multiple explicitly enabled memory providers are ambiguous', async () => {
    const storeRoot = createTestTempRoot('project02-config-memory-ambiguous-');
    const memoryOne = memoryProviderPlugin('memory.one');
    const memoryTwo = memoryProviderPlugin('memory.two');
    const factories = {
      'memory.one': {
        manifest: memoryOne.manifest,
        create: () => memoryOne,
      },
      'memory.two': {
        manifest: memoryTwo.manifest,
        create: () => memoryTwo,
      },
    };

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'memory.one': {
          enabled: true,
        },
        'memory.two': {
          enabled: true,
        },
      },
    });
    await initializeCharacterDataForHost(storeRoot);
    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({storeRoot}),
          factories,
        }),
      }),
    });

    expect(configured.activation.enabledPluginIds).toEqual([runtimePluginId]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'ambiguous_memory_provider_selection',
          path: 'project02.defaultMemoryProvider',
        }),
      ]),
    );
    expect(
      nonHostScopedActivationPlugins(configured.activation.plugins).map(
        plugin => [plugin.pluginId, plugin.activationStatus],
      ),
    ).toEqual([
      ['memory.one', 'blocked'],
      ['memory.two', 'blocked'],
    ]);

    const check = await checkRuntimeConfigForTest({storeRoot, factories});

    expect(check.ok).toBe(false);
    expect(check.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'ambiguous_memory_provider_selection',
        }),
      ]),
    );
  });

  it('treats a typoed explicit default memory provider as an activation-wide error when another provider is enabled', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-memory-default-typo-',
    );
    const enabledPlugin = memoryProviderPlugin('memory.enabled');
    let factoryCalls = 0;
    const factories = {
      'character-state': {
        manifest: createCharacterStatePluginManifest(),
        create() {
          factoryCalls += 1;
          throw new Error('default plugin should not be constructed');
        },
      },
      'memory.enabled': {
        manifest: enabledPlugin.manifest,
        create() {
          factoryCalls += 1;
          throw new Error('unselected memory plugin should not be constructed');
        },
      },
    };

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'memory.typo',
      plugins: {
        'memory.enabled': {
          enabled: true,
        },
      },
    });
    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({storeRoot}),
          factories,
        }),
      }),
    });
    const characterActivation = configured.activation.plugins.find(
      plugin => plugin.pluginId === 'character-state',
    );
    const memoryActivation = configured.activation.plugins.find(
      plugin => plugin.pluginId === 'memory.enabled',
    );

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([runtimePluginId]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_unavailable',
          path: 'project02.defaultMemoryProvider',
        }),
      ]),
    );
    expect(characterActivation).toMatchObject({
      pluginId: 'character-state',
      enabled: false,
      activationStatus: 'disabled',
    });
    expect(characterActivation?.activationReasons).toContain('not_enabled');
    expect(memoryActivation).toMatchObject({
      pluginId: 'memory.enabled',
      enabled: false,
      activationStatus: 'disabled',
    });
    expect(memoryActivation?.activationReasons).toContain(
      'not_selected_as_default_memory_provider',
    );

    const check = await checkRuntimeConfigForTest({storeRoot, factories});

    expect(factoryCalls).toBe(0);
    expect(check.ok).toBe(false);
    expect(check.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_unavailable',
        }),
      ]),
    );
  });

  it('treats a known non-memory default memory provider as an activation error', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-memory-default-non-memory-',
    );

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'character-state',
    });
    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({storeRoot}),
        }),
      }),
    });

    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([runtimePluginId]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_not_memory_provider',
          path: 'project02.defaultMemoryProvider',
          pluginId: 'character-state',
        }),
      ]),
    );
    expect(
      activationPluginById(configured.activation.plugins, 'character-state'),
    ).toMatchObject({
      pluginId: 'character-state',
      enabled: false,
      activationStatus: 'disabled',
    });

    const check = await checkRuntimeConfigForTest({storeRoot});

    expect(check.ok).toBe(false);
    expect(check.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_not_memory_provider',
        }),
      ]),
    );
  });

  it('treats an inactive explicit default memory provider as an activation error when another provider is enabled', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-memory-default-inactive-',
    );
    const enabledPlugin = memoryProviderPlugin('memory.enabled');
    const disabledPlugin = memoryProviderPlugin('memory.disabled');
    const factories = {
      'memory.enabled': {
        manifest: enabledPlugin.manifest,
        create: () => enabledPlugin,
      },
      'memory.disabled': {
        manifest: disabledPlugin.manifest,
        create: () => disabledPlugin,
      },
    };

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'memory.disabled',
      plugins: {
        'memory.enabled': {
          enabled: true,
        },
        'memory.disabled': {
          enabled: false,
        },
      },
    });
    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({storeRoot}),
          factories,
        }),
      }),
    });

    expect(configured.activation.enabledPluginIds).toEqual([runtimePluginId]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_unavailable',
          path: 'project02.defaultMemoryProvider',
        }),
      ]),
    );
    expect(
      nonHostScopedActivationPlugins(configured.activation.plugins).map(
        plugin => [plugin.pluginId, plugin.activationStatus],
      ),
    ).toEqual([
      ['memory.enabled', 'disabled'],
      ['memory.disabled', 'disabled'],
    ]);
    expect(
      activationPluginById(configured.activation.plugins, 'memory.enabled')
        ?.activationReasons,
    ).toContain('not_selected_as_default_memory_provider');
    expect(
      activationPluginById(configured.activation.plugins, 'memory.disabled')
        ?.activationReasons,
    ).toContain('disabled_by_config');

    const check = await checkRuntimeConfigForTest({storeRoot, factories});

    expect(check.ok).toBe(false);
    expect(check.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_unavailable',
        }),
      ]),
    );
  });

  it('treats a disabled explicit default memory provider as an activation error without another provider enabled', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-memory-default-disabled-',
    );
    const disabledPlugin = memoryProviderPlugin('memory.disabled');
    let factoryCalls = 0;
    const factories = {
      'memory.disabled': {
        manifest: disabledPlugin.manifest,
        create() {
          factoryCalls += 1;
          throw new Error('disabled memory provider should not be constructed');
        },
      },
    };

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'memory.disabled',
      plugins: {
        'memory.disabled': {
          enabled: false,
        },
      },
    });
    await initializeCharacterDataForHost(storeRoot);

    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({storeRoot}),
          factories,
        }),
      }),
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([runtimePluginId]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_unavailable',
          path: 'project02.defaultMemoryProvider',
        }),
      ]),
    );
    expect(
      nonHostScopedActivationPlugins(configured.activation.plugins),
    ).toEqual([
      expect.objectContaining({
        pluginId: 'memory.disabled',
        enabled: false,
        activationStatus: 'disabled',
      }),
    ]);
    expect(
      activationPluginById(configured.activation.plugins, 'memory.disabled')
        ?.activationReasons,
    ).toContain('disabled_by_config');

    const check = await checkRuntimeConfigForTest({storeRoot, factories});

    expect(factoryCalls).toBe(0);
    expect(check.ok).toBe(false);
    expect(check.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_unavailable',
        }),
      ]),
    );
  });
});
