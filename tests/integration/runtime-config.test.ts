import {readFileSync, realpathSync, statSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {createTestTempRoot} from '../support/temp-root.ts';
import {createConfiguredProject02PluginHost} from '../../src/app/index.ts';
import {
  createRuntimeConfigInspectShape,
  defaultRuntimeConfigPath,
  loadProject02RuntimeConfig,
  resolveProject02RuntimeConfig,
  runtimeControlEnvVarNames,
  runtimeConfigEnvVarName,
  runtimeConfigVersion,
} from '../../src/runtime/config/index.ts';
import {
  hostScopedFirstPartyRuntimePluginIds,
  runtimePluginId,
} from '../../src/plugins/index.ts';
import {
  createCharacterStatePlugin,
  createCharacterStatePluginManifest,
} from '../../src/plugins/packages/character-state/plugin.ts';
import {runRuntimeConfigCliFromArgs} from '../../src/cli/config/main.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {collect} from '../support/streams.ts';
import {
  activationPluginById,
  memoryProviderPlugin,
  nonHostScopedActivationPlugins,
  requiredDottedConfigPlugin,
  requiredSecretPlugin,
  requiredSecretPluginWithManifestEnvVar,
  structuredConfigPlugin,
} from '../support/runtime-config-fixtures.ts';

describe('runtime config loading and resolution', () => {
  it('preserves no-config behavior with source none and default store root', () => {
    const storeRoot = createTestTempRoot('project02-config-empty-');
    const loaded = loadProject02RuntimeConfig({storeRoot});
    const resolved = resolveProject02RuntimeConfig({
      loadedConfig: loaded,
      storeRoot,
    });

    expect(loaded.source).toBe('none');
    expect(resolved.project02.storeRoot).toBe(storeRoot);
    expect(Object.hasOwn(resolved, 'storeRoot')).toBe(false);
    expect(Object.hasOwn(resolved, 'defaultMemoryProvider')).toBe(false);
    expect(Object.hasOwn(resolved, 'roleModelProvider')).toBe(false);
    const inspection = createRuntimeConfigInspectShape(resolved);

    expect(inspection.project02.storeRoot).toBe(storeRoot);
    expect(Object.hasOwn(inspection, 'storeRoot')).toBe(false);
    expect(Object.hasOwn(inspection, 'defaultMemoryProvider')).toBe(false);
    expect(Object.hasOwn(inspection, 'roleModelProvider')).toBe(false);
    expect(resolved.diagnostics).toEqual([]);
  });

  it('loads explicit config before env config', () => {
    const root = createTestTempRoot('project02-config-precedence-');
    const explicitPath = join(root, 'explicit.json');
    const envPath = join(root, 'env.json');

    writeRuntimeConfig(explicitPath, {storeRoot: 'explicit-store'});
    writeRuntimeConfig(envPath, {storeRoot: 'env-store'});

    const loaded = loadProject02RuntimeConfig({
      configPath: explicitPath,
      env: {
        PROJECT02_RUNTIME_CONFIG: envPath,
      },
    });
    const resolved = resolveProject02RuntimeConfig({loadedConfig: loaded});

    expect(loaded.source).toBe('path');
    expect(resolved.project02.storeRoot).toBe('explicit-store');
  });

  it('includes plugin enablement in the effective config fingerprint', () => {
    const storeRoot = createTestTempRoot(
      'project02-config-plugin-fingerprint-',
    );
    const withoutPlugin = resolveProject02RuntimeConfig({
      loadedConfig: {
        source: 'path',
        path: join(storeRoot, 'without.json'),
        config: {
          version: runtimeConfigVersion,
        },
        diagnostics: [],
      },
      storeRoot,
    });
    const withEnabledPlugin = resolveProject02RuntimeConfig({
      loadedConfig: {
        source: 'path',
        path: join(storeRoot, 'with.json'),
        config: {
          version: runtimeConfigVersion,
          plugins: {
            memory: {
              enabled: true,
            },
          },
        },
        diagnostics: [],
      },
      storeRoot,
    });

    expect(withEnabledPlugin.effectiveConfigFingerprint).not.toBe(
      withoutPlugin.effectiveConfigFingerprint,
    );
  });

  it('loads explicit store default config before env config', () => {
    const selectedStoreRoot = createTestTempRoot(
      'project02-config-store-precedence-',
    );
    const envStoreRoot = createTestTempRoot('project02-config-env-store-');
    const selectedPath = defaultRuntimeConfigPath(selectedStoreRoot);
    const envPath = join(envStoreRoot, 'env.json');

    writeRuntimeConfig(selectedPath, {storeRoot: selectedStoreRoot});
    writeRuntimeConfig(envPath, {storeRoot: envStoreRoot});

    const loaded = loadProject02RuntimeConfig({
      storeRoot: selectedStoreRoot,
      env: {
        [runtimeConfigEnvVarName]: envPath,
      },
    });
    const resolved = resolveProject02RuntimeConfig({
      loadedConfig: loaded,
      storeRoot: selectedStoreRoot,
    });

    expect(loaded).toMatchObject({
      source: 'default',
      path: selectedPath,
    });
    expect(resolved.project02.storeRoot).toBe(selectedStoreRoot);
  });

  it('infers store root from existing store-default config selected by path or env', () => {
    const storeRoot = createTestTempRoot(
      'project02-config-store-default-infer-',
    );
    const seededStoreRoot = realpathSync.native(storeRoot);
    const configPath = defaultRuntimeConfigPath(storeRoot);

    writeRuntimeConfig(configPath, {});

    const explicitLoaded = loadProject02RuntimeConfig({configPath});
    const envLoaded = loadProject02RuntimeConfig({
      env: {
        [runtimeConfigEnvVarName]: configPath,
      },
    });

    expect(explicitLoaded.config?.project02?.storeRoot).toBeUndefined();
    expect(envLoaded.config?.project02?.storeRoot).toBeUndefined();
    expect(
      resolveProject02RuntimeConfig({loadedConfig: explicitLoaded}).project02
        .storeRoot,
    ).toBe(seededStoreRoot);
    expect(
      resolveProject02RuntimeConfig({loadedConfig: envLoaded}).project02
        .storeRoot,
    ).toBe(seededStoreRoot);
  });

  it('infers store root from canonical symlink targets for store-default configs selected by path or env', () => {
    const targetStoreRoot = createTestTempRoot(
      'project02-config-store-default-link-target-',
    );
    const linkStoreRoot = createTestTempRoot(
      'project02-config-store-default-link-selected-',
    );
    const seededStoreRoot = realpathSync.native(targetStoreRoot);
    const targetConfigPath = defaultRuntimeConfigPath(targetStoreRoot);
    const linkConfigPath = defaultRuntimeConfigPath(linkStoreRoot);

    writeRuntimeConfig(targetConfigPath, {});
    symlinkSync(targetConfigPath, linkConfigPath);

    const explicitLoaded = loadProject02RuntimeConfig({
      configPath: linkConfigPath,
    });
    const envLoaded = loadProject02RuntimeConfig({
      env: {
        [runtimeConfigEnvVarName]: linkConfigPath,
      },
    });

    expect(explicitLoaded.config?.project02?.storeRoot).toBeUndefined();
    expect(envLoaded.config?.project02?.storeRoot).toBeUndefined();
    expect(
      resolveProject02RuntimeConfig({loadedConfig: explicitLoaded}).project02
        .storeRoot,
    ).toBe(seededStoreRoot);
    expect(
      resolveProject02RuntimeConfig({loadedConfig: envLoaded}).project02
        .storeRoot,
    ).toBe(seededStoreRoot);
  });

  it('rejects unknown top-level config fields and blocks default activation', async () => {
    const configPath = writeRuntimeConfig(
      join(createTestTempRoot('project02-config-unknown-root-'), 'config.json'),
      {
        store_root: 'typo-store',
      },
    );
    const loaded = loadProject02RuntimeConfig({configPath});
    let stdout = '';

    expect(loaded.config).toBeUndefined();
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_config_unknown_top_level_field',
        path: 'store_root',
      }),
    ]);

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loaded,
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

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'check'], {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
      }),
    ).toBe(1);
    expect(stdout).toContain('"runtime_config_unknown_top_level_field"');
    expect(stdout).toContain('"store_root"');
  });

  it('rejects the removed enabledPlugins config field', () => {
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-removed-enabled-plugins-'),
        'config.json',
      ),
      {
        enabledPlugins: ['character-state'],
      },
    );
    const loaded = loadProject02RuntimeConfig({configPath});

    expect(loaded.config).toBeUndefined();
    expect(loaded.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_config_unknown_top_level_field',
        path: 'enabledPlugins',
      }),
    );
  });

  it('rejects unknown plugin wrapper fields and blocks that plugin activation', async () => {
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-unknown-plugin-wrapper-'),
        'config.json',
      ),
      {
        plugins: {
          'character-state': {
            enable: false,
          },
        },
      },
    );
    const loaded = loadProject02RuntimeConfig({configPath});
    let stdout = '';

    expect(loaded.config).toBeUndefined();
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_config_unknown_plugin_wrapper_field',
        path: 'plugins.character-state.enable',
        pluginId: 'character-state',
      }),
    ]);

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loaded,
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

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'check'], {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
      }),
    ).toBe(1);
    expect(stdout).toContain('"runtime_config_unknown_plugin_wrapper_field"');
    expect(stdout).toContain('"activationStatus": "blocked"');
  });

  it('treats unknown plugin wrapper load errors as global activation blockers', async () => {
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-unknown-plugin-global-'),
        'config.json',
      ),
      {
        plugins: {
          unknown: {
            enable: true,
          },
        },
      },
    );
    const loaded = loadProject02RuntimeConfig({configPath});
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

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loaded,
      factories: {
        'character-state': {
          manifest: createCharacterStatePluginManifest(),
          create() {
            factoryCalls += 1;

            return createCharacterStatePlugin();
          },
        },
      },
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
    expect(characterStateActivation?.diagnostics).toEqual([]);
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
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-known-plugin-global-'),
        'config.json',
      ),
      {
        plugins: {
          bad: {
            enable: true,
          },
        },
      },
    );
    const loaded = loadProject02RuntimeConfig({configPath});
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

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loaded,
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
            throw new Error('invalid plugin factory should not be constructed');
          },
        },
      },
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
    expect(characterActivation?.diagnostics).toEqual([]);
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

  it('redacts secret env refs and keeps fingerprints independent of env secret values', () => {
    const plugin = createCharacterStatePlugin();
    const loaded = loadProject02RuntimeConfig({
      configPath: writeRuntimeConfig(
        join(createTestTempRoot('project02-config-secret-'), 'config.json'),
        {
          plugins: {
            [plugin.manifest.id]: {
              config: {
                apiKey: {$env: 'PROJECT02_TEST_SECRET'},
              },
            },
          },
        },
      ),
    });
    const manifest = {
      ...plugin.manifest,
      config: {
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
    const first = resolveProject02RuntimeConfig({
      loadedConfig: loaded,
      pluginManifests: [manifest],
      env: {PROJECT02_TEST_SECRET: 'first-secret'},
    });
    const second = resolveProject02RuntimeConfig({
      loadedConfig: loaded,
      pluginManifests: [manifest],
      env: {PROJECT02_TEST_SECRET: 'second-secret'},
    });

    expect(
      first.redactedPluginConfigs['character-state']?.['apiKey'],
    ).toMatchObject({
      value: '[redacted]',
      source: 'env:PROJECT02_TEST_SECRET',
      resolved: true,
    });
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
    const enabledPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-enabled-fingerprint-'),
        'config.json',
      ),
      {
        plugins: {
          [plugin.manifest.id]: {
            enabled: true,
            config: {
              apiKey: {$env: 'PROJECT02_ENABLED_FINGERPRINT_SECRET'},
            },
          },
        },
      },
    );
    const disabledPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-disabled-fingerprint-'),
        'config.json',
      ),
      {
        plugins: {
          [plugin.manifest.id]: {
            enabled: false,
            config: {
              apiKey: {$env: 'PROJECT02_ENABLED_FINGERPRINT_SECRET'},
            },
          },
        },
      },
    );
    const enabledFirst = resolveProject02RuntimeConfig({
      loadedConfig: loadProject02RuntimeConfig({configPath: enabledPath}),
      pluginManifests: [plugin.manifest],
      env: {PROJECT02_ENABLED_FINGERPRINT_SECRET: 'first-secret'},
    });
    const enabledSecond = resolveProject02RuntimeConfig({
      loadedConfig: loadProject02RuntimeConfig({configPath: enabledPath}),
      pluginManifests: [plugin.manifest],
      env: {PROJECT02_ENABLED_FINGERPRINT_SECRET: 'second-secret'},
    });
    const disabled = resolveProject02RuntimeConfig({
      loadedConfig: loadProject02RuntimeConfig({configPath: disabledPath}),
      pluginManifests: [plugin.manifest],
      env: {PROJECT02_ENABLED_FINGERPRINT_SECRET: 'first-secret'},
    });

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
    const first = resolveProject02RuntimeConfig({
      loadedConfig: loadProject02RuntimeConfig({
        configPath: writeRuntimeConfig(
          join(
            createTestTempRoot('project02-config-credential-fields-a-'),
            'runtime.json',
          ),
          {
            plugins: {
              [plugin.manifest.id]: {
                config: {
                  apiKey: 'first-api-key',
                  token: 'first-token',
                  metadata: {
                    access_token: 'first-nested-token',
                    label: 'visible-label',
                  },
                },
              },
            },
          },
        ),
      }),
      pluginManifests: [manifest],
    });
    const second = resolveProject02RuntimeConfig({
      loadedConfig: loadProject02RuntimeConfig({
        configPath: writeRuntimeConfig(
          join(
            createTestTempRoot('project02-config-credential-fields-b-'),
            'runtime.json',
          ),
          {
            plugins: {
              [plugin.manifest.id]: {
                config: {
                  apiKey: 'second-api-key',
                  token: 'second-token',
                  metadata: {
                    access_token: 'second-nested-token',
                    label: 'visible-label',
                  },
                },
              },
            },
          },
        ),
      }),
      pluginManifests: [manifest],
    });

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

  it('rejects nested secret refs in non-secret object and array config fields', async () => {
    const plugin = structuredConfigPlugin('memory.structured');
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-nested-secret-ref-'),
        'config.json',
      ),
      {
        plugins: {
          'memory.structured': {
            enabled: true,
            config: {
              settings: {
                apiKey: {$env: 'PROJECT02_NESTED_OBJECT_SECRET'},
              },
              endpoints: [
                {
                  token: {$env: 'PROJECT02_NESTED_ARRAY_SECRET'},
                },
              ],
            },
          },
        },
      },
    );
    let factoryCalls = 0;

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({configPath}),
      factories: {
        'memory.structured': {
          manifest: plugin.manifest,
          create() {
            factoryCalls += 1;
            throw new Error('factory should not receive nested secret refs');
          },
        },
      },
      env: {
        PROJECT02_NESTED_OBJECT_SECRET: 'object-secret',
        PROJECT02_NESTED_ARRAY_SECRET: 'array-secret',
      },
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(
      configured.resolvedConfig.pluginConfigs['memory.structured'],
    ).toMatchObject({
      settings: {
        source: 'config',
        resolved: false,
      },
      endpoints: {
        source: 'config',
        resolved: false,
      },
    });
    expect(
      configured.resolvedConfig.pluginConfigs['memory.structured']?.[
        'settings'
      ],
    ).not.toHaveProperty('value');
    expect(
      configured.resolvedConfig.pluginConfigs['memory.structured']?.[
        'endpoints'
      ],
    ).not.toHaveProperty('value');
    expect(configured.activation.enabledPluginIds).not.toContain(
      'memory.structured',
    );
    expect(
      activationPluginById(configured.activation.plugins, 'memory.structured'),
    ).toMatchObject({
      pluginId: 'memory.structured',
      activationStatus: 'blocked',
    });
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_secret_ref_for_non_secret',
          path: 'plugins.memory.structured.config.settings.apiKey',
          pluginId: 'memory.structured',
          pluginConfigField: 'settings',
        }),
        expect.objectContaining({
          code: 'runtime_config_secret_ref_for_non_secret',
          path: 'plugins.memory.structured.config.endpoints.0.token',
          pluginId: 'memory.structured',
          pluginConfigField: 'endpoints',
        }),
      ]),
    );
  });

  it('rejects plaintext secret values by default', () => {
    const plugin = createCharacterStatePlugin();
    const loaded = loadProject02RuntimeConfig({
      configPath: writeRuntimeConfig(
        join(createTestTempRoot('project02-config-plaintext-'), 'config.json'),
        {
          plugins: {
            [plugin.manifest.id]: {
              config: {
                apiKey: 'plaintext-secret',
              },
            },
          },
        },
      ),
    });
    const resolved = resolveProject02RuntimeConfig({
      loadedConfig: loaded,
      pluginManifests: [
        {
          ...plugin.manifest,
          config: {
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
      ],
    });

    expect(resolved.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_plaintext_secret_rejected',
        }),
      ]),
    );
    expect(JSON.stringify(resolved)).not.toContain('plaintext-secret');
  });

  it('treats empty env values for required secrets as missing', () => {
    const envVar = 'PROJECT02_EMPTY_SECRET_3447588015';
    const configPath = writeRuntimeConfig(
      join(createTestTempRoot('project02-config-empty-secret-'), 'config.json'),
      {
        plugins: {
          'memory.required': {
            config: {
              apiKey: {$env: envVar},
            },
          },
        },
      },
    );
    const resolved = resolveProject02RuntimeConfig({
      loadedConfig: loadProject02RuntimeConfig({configPath}),
      pluginManifests: [requiredSecretPlugin().manifest],
      env: {[envVar]: ''},
    });
    const resolvedField = resolved.pluginConfigs['memory.required']?.['apiKey'];

    expect(resolvedField).toMatchObject({
      source: `env:${envVar}`,
      resolved: false,
    });
    expect(resolvedField).not.toHaveProperty('value');
    expect(resolved.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_secret_missing',
          path: 'plugins.memory.required.config.apiKey',
        }),
      ]),
    );
  });

  it('resolves manifest secret env var defaults without raw config', async () => {
    const envVar = 'PROJECT02_MANIFEST_DEFAULT_SECRET_3449527784';
    const plugin = requiredSecretPluginWithManifestEnvVar(
      'memory.manifest-default-secret',
      envVar,
    );
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-manifest-env-default-'),
        'config.json',
      ),
      {
        plugins: {
          [plugin.manifest.id]: {
            enabled: true,
          },
        },
      },
    );
    const factoryInputs: unknown[] = [];

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({configPath}),
      env: {[envVar]: 'manifest-default-secret'},
      factories: {
        [plugin.manifest.id]: {
          manifest: plugin.manifest,
          create(input) {
            factoryInputs.push(input.resolvedConfig['apiKey']?.value);

            return plugin;
          },
        },
      },
    });

    expect(configured.activation.enabledPluginIds).toContain(
      plugin.manifest.id,
    );
    expect(factoryInputs).toEqual(['manifest-default-secret']);
    expect(
      configured.resolvedConfig.pluginConfigs[plugin.manifest.id]?.['apiKey'],
    ).toMatchObject({
      source: `env:${envVar}`,
      resolved: true,
      value: 'manifest-default-secret',
    });
    expect(
      configured.activation.diagnostics.map(item => item.code),
    ).not.toContain('runtime_config_reserved_control_env_var');
  });

  it.each(runtimeControlEnvVarNames)(
    'rejects reserved runtime control env var %s in manifest secret defaults',
    async envVar => {
      const plugin = requiredSecretPluginWithManifestEnvVar(
        'memory.reserved-manifest-secret',
        envVar,
      );
      const configPath = writeRuntimeConfig(
        join(
          createTestTempRoot('project02-config-manifest-reserved-env-'),
          'config.json',
        ),
        {
          plugins: {
            [plugin.manifest.id]: {
              enabled: true,
            },
          },
        },
      );
      let factoryCalls = 0;
      const configured = await createConfiguredProject02PluginHost({
        loadedConfig: loadProject02RuntimeConfig({configPath}),
        env: {[envVar]: 'runtime-control-value'},
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error('reserved control env var must block activation');
            },
          },
        },
      });
      const resolvedField =
        configured.resolvedConfig.pluginConfigs[plugin.manifest.id]?.['apiKey'];
      const activation = configured.activation.plugins.find(
        item => item.pluginId === plugin.manifest.id,
      );

      expect(factoryCalls).toBe(0);
      expect(configured.activation.enabledPluginIds).not.toContain(
        plugin.manifest.id,
      );
      expect(resolvedField).toMatchObject({
        source: `env:${envVar}`,
        resolved: false,
      });
      expect(resolvedField).not.toHaveProperty('value');
      expect(configured.activation.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'runtime_config_reserved_control_env_var',
            path: `plugins.${plugin.manifest.id}.config.apiKey`,
            pluginId: plugin.manifest.id,
            pluginConfigField: 'apiKey',
          }),
        ]),
      );
      expect(activation).toMatchObject({
        pluginId: plugin.manifest.id,
        enabled: false,
        activationStatus: 'blocked',
      });
      expect(activation?.activationReasons).toContain(
        'blocked_by_config_errors',
      );
      expect(JSON.stringify(configured.resolvedConfig)).not.toContain(
        'runtime-control-value',
      );
    },
  );

  it('rejects unknown config fields for enabled or default-enabled plugins', async () => {
    const envVar = 'PROJECT02_UNKNOWN_FIELD_SECRET_3447705094';
    const plugin = requiredSecretPlugin();
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-unknown-field-'),
        'config.json',
      ),
      {
        plugins: {
          'memory.required': {
            config: {
              apiKey: {$env: envVar},
              zetaTypo: 'ignored',
              alphaTypo: 'ignored',
            },
          },
        },
      },
    );
    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({configPath}),
      factories: {
        'memory.required': {
          manifest: plugin.manifest,
          create: () => plugin,
        },
      },
      env: {[envVar]: 'configured-secret'},
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
    const configPath = writeRuntimeConfig(
      join(createTestTempRoot('project02-config-dotted-field-'), 'config.json'),
      {},
    );
    let factoryCalls = 0;

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({configPath}),
      factories: {
        memory: {
          manifest: plugin.manifest,
          create() {
            factoryCalls += 1;

            return plugin;
          },
        },
      },
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
      const configPath = writeRuntimeConfig(
        join(
          createTestTempRoot('project02-config-prototype-field-'),
          'config.json',
        ),
        {
          plugins: {
            [pluginId]: {
              config: {},
            },
          },
        },
      );
      let factoryCalls = 0;

      const configured = await createConfiguredProject02PluginHost({
        loadedConfig: loadProject02RuntimeConfig({configPath}),
        factories: {
          [pluginId]: {
            manifest: plugin.manifest,
            create() {
              factoryCalls += 1;
              return plugin;
            },
          },
        },
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
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-plugin-error-blocks-all-'),
        'config.json',
      ),
      {
        plugins: {
          'memory.required': {
            enabled: true,
          },
        },
      },
    );
    let characterFactoryCalls = 0;
    let memoryFactoryCalls = 0;

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({configPath}),
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
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-disable-invalid-'),
        'config.json',
      ),
      {
        plugins: {
          'memory.required': {
            enabled: false,
            config: {
              misspelledApiKey: 'ignored',
            },
          },
        },
      },
    );
    let factoryCalls = 0;
    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({configPath}),
      factories: {
        'memory.required': {
          manifest: plugin.manifest,
          create() {
            factoryCalls += 1;
            throw new Error('disabled plugin should not be constructed');
          },
        },
      },
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

  it('uses supplied env maps when creating configured plugin hosts', async () => {
    const envVar = 'PROJECT02_SUPPLIED_ONLY_SECRET_3447588016';
    const previousEnvValue = process.env[envVar];
    process.env[envVar] = '';

    try {
      const configPath = writeRuntimeConfig(
        join(
          createTestTempRoot('project02-config-supplied-env-'),
          'config.json',
        ),
        {
          plugins: {
            'memory.required': {
              enabled: true,
              config: {
                apiKey: {$env: envVar},
              },
            },
          },
        },
      );
      const configured = await createConfiguredProject02PluginHost({
        loadedConfig: loadProject02RuntimeConfig({configPath}),
        factories: {
          'memory.required': {
            manifest: requiredSecretPlugin().manifest,
            create: () => requiredSecretPlugin(),
          },
        },
        env: {[envVar]: 'from-supplied-env'},
      });

      expect(configured.activation.enabledPluginIds).toContain(
        'memory.required',
      );
      expect(
        configured.activation.diagnostics.map(item => item.code),
      ).not.toContain('runtime_config_required_secret_missing');
      expect(
        configured.resolvedConfig.pluginConfigs['memory.required']?.['apiKey'],
      ).toMatchObject({
        source: `env:${envVar}`,
        resolved: true,
        value: 'from-supplied-env',
      });
    } finally {
      if (previousEnvValue === undefined) {
        Reflect.deleteProperty(process.env, envVar);
      } else {
        process.env[envVar] = previousEnvValue;
      }
    }
  });

  it('creates manifest-backed configured plugin factories once with resolved config', async () => {
    const envVar = 'PROJECT02_FACTORY_SECRET_3447631396';
    const storeRoot = createTestTempRoot('project02-config-factory-');
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      storeRoot,
      plugins: {
        'memory.required': {
          enabled: true,
          config: {
            apiKey: {$env: envVar},
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

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({configPath}),
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
      env: {[envVar]: 'from-manifest-backed-factory'},
    });

    expect(characterFactoryCalls).toBe(0);
    expect(memoryFactoryCalls).toBe(1);
    expect(memoryFactoryInputs).toEqual([
      {
        pluginId: 'memory.required',
        storeRoot,
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
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-inactive-factory-'),
        'config.json',
      ),
      {
        plugins: {
          'memory.disabled': {
            enabled: false,
          },
          'memory.blocked': {
            enabled: true,
          },
        },
      },
    );
    let factoryCalls = 0;

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({configPath}),
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

  it('passes config-resolved store roots to manifest-backed plugin factories', async () => {
    const cliStoreRoot = createTestTempRoot('project02-config-cli-root-');
    const configuredStoreRoot = createTestTempRoot(
      'project02-config-file-root-',
    );
    const envVar = 'PROJECT02_CONFIG_ROOT_FACTORY_SECRET_3448745052';
    const configPath = writeRuntimeConfig(
      join(createTestTempRoot('project02-config-legacy-root-'), 'config.json'),
      {
        storeRoot: configuredStoreRoot,
        plugins: {
          'memory.required': {
            enabled: true,
            config: {
              apiKey: {$env: envVar},
            },
          },
        },
      },
    );
    let factoryStoreRoot: string | undefined;

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({configPath}),
      storeRoot: cliStoreRoot,
      factories: {
        'memory.required': {
          manifest: requiredSecretPlugin().manifest,
          create(input) {
            factoryStoreRoot = input.storeRoot;

            return requiredSecretPlugin();
          },
        },
      },
      env: {[envVar]: 'from-configured-store-root'},
    });

    expect(factoryStoreRoot).toBe(configuredStoreRoot);
    expect(configured.resolvedConfig.project02.storeRoot).toBe(
      configuredStoreRoot,
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
    let stdout = '';

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
    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({storeRoot}),
      factories,
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

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories,
      }),
    ).toBe(1);
    expect(stdout).toContain('"ambiguous_memory_provider_selection"');
    expect(stdout).toContain('"severity": "error"');
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
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'memory.typo',
      plugins: {
        'memory.enabled': {
          enabled: true,
        },
      },
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({storeRoot}),
      factories,
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

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories,
      }),
    ).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(stdout).toContain('"default_memory_provider_unavailable"');
    expect(stdout).toContain('"severity": "error"');
  });

  it('treats a known non-memory default memory provider as an activation error', async () => {
    const storeRoot = createTestTempRoot(
      'project02-config-memory-default-non-memory-',
    );
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'character-state',
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({storeRoot}),
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
      activationStatus: 'blocked',
    });

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
      }),
    ).toBe(1);
    expect(stdout).toContain('"default_memory_provider_not_memory_provider"');
    expect(stdout).toContain('"severity": "error"');
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
    let stdout = '';

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

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({storeRoot}),
      factories,
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

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories,
      }),
    ).toBe(1);
    expect(stdout).toContain('"default_memory_provider_unavailable"');
    expect(stdout).toContain('"severity": "error"');
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
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'memory.disabled',
      plugins: {
        'memory.disabled': {
          enabled: false,
        },
      },
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({storeRoot}),
      factories,
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

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories,
      }),
    ).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(stdout).toContain('"default_memory_provider_unavailable"');
    expect(stdout).toContain('"severity": "error"');
  });

  it('writes non-secret and secret-ref config through the shared mutation path', async () => {
    const storeRoot = createTestTempRoot('project02-config-cli-');
    const secretPlugin = requiredSecretPlugin('mem0-local');
    const factories = {
      [secretPlugin.manifest.id]: {
        manifest: secretPlugin.manifest,
        create: () => secretPlugin,
      },
    };
    let stdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'plugin', 'disable', 'character-state'],
        {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
        },
      ),
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'plugin', 'enable', 'memory.recall'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
        },
      ),
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--store',
          storeRoot,
          'secret',
          'set',
          'mem0-local',
          'apiKey',
          'MEM0_API_KEY',
        ],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          factories,
          env: {MEM0_API_KEY: 'super-secret'},
        },
      ),
    ).toBe(0);

    const config: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8'),
    );

    expect(stdout).toContain('config.json');
    expect(config).toMatchObject({
      plugins: {
        'character-state': {enabled: false},
        'memory.recall': {enabled: true},
        'mem0-local': {
          config: {apiKey: {$env: 'MEM0_API_KEY'}},
        },
      },
    });
    expect(readFileSync(join(storeRoot, '.env'), 'utf8')).toContain(
      'MEM0_API_KEY="super-secret"',
    );
    expect((statSync(join(storeRoot, '.env')).mode & 0o777).toString(8)).toBe(
      '600',
    );
  });
});
