import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  applyRuntimeConfigMutation,
  createConfiguredProject02PluginHost,
  defaultRuntimeConfigPath,
  loadProject02RuntimeConfig,
  resolveProject02RuntimeConfig,
  roleModelProviderEnvVarName,
  runtimeControlEnvVarNames,
  runtimeConfigEnvVarName,
  runtimeConfigVersion
} from '../src/runtime/config/index.ts';
import {
  createCharacterStatePlugin,
  createCharacterStatePluginManifest,
  createMemoryProviderRuntimePlugin,
  createRuntimePlugin,
  runtimePluginContractVersion
} from '../src/plugins/index.ts';
import { runRuntimeConfigCliFromArgs } from '../src/cli/config.ts';

describe('runtime config loading and resolution', () => {
  it('preserves no-config behavior with source none and default store root', () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-empty-'));
    const loaded = loadProject02RuntimeConfig({ storeRoot });
    const resolved = resolveProject02RuntimeConfig({ loadedConfig: loaded, storeRoot });

    expect(loaded.source).toBe('none');
    expect(resolved.storeRoot).toBe(storeRoot);
    expect(resolved.diagnostics).toEqual([]);
  });

  it('loads explicit config before env config', () => {
    const root = mkdtempSync(join(tmpdir(), 'project02-config-precedence-'));
    const explicitPath = join(root, 'explicit.json');
    const envPath = join(root, 'env.json');

    writeRuntimeConfig(explicitPath, { storeRoot: 'explicit-store' });
    writeRuntimeConfig(envPath, { storeRoot: 'env-store' });

    const loaded = loadProject02RuntimeConfig({
      configPath: explicitPath,
      env: {
        PROJECT02_RUNTIME_CONFIG: envPath
      }
    });
    const resolved = resolveProject02RuntimeConfig({ loadedConfig: loaded });

    expect(loaded.source).toBe('path');
    expect(resolved.storeRoot).toBe('explicit-store');
  });

  it('loads explicit store default config before env config', () => {
    const selectedStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-store-precedence-')
    );
    const envStoreRoot = mkdtempSync(join(tmpdir(), 'project02-config-env-store-'));
    const selectedPath = defaultRuntimeConfigPath(selectedStoreRoot);
    const envPath = join(envStoreRoot, 'env.json');

    writeRuntimeConfig(selectedPath, { storeRoot: selectedStoreRoot });
    writeRuntimeConfig(envPath, { storeRoot: envStoreRoot });

    const loaded = loadProject02RuntimeConfig({
      storeRoot: selectedStoreRoot,
      env: {
        [runtimeConfigEnvVarName]: envPath
      }
    });
    const resolved = resolveProject02RuntimeConfig({
      loadedConfig: loaded,
      storeRoot: selectedStoreRoot
    });

    expect(loaded).toMatchObject({
      source: 'default',
      path: selectedPath
    });
    expect(resolved.storeRoot).toBe(selectedStoreRoot);
  });

  it('infers store root from existing store-default config selected by path or env', () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-store-default-infer-')
    );
    const seededStoreRoot = realpathSync.native(storeRoot);
    const configPath = defaultRuntimeConfigPath(storeRoot);

    writeRuntimeConfig(configPath, {});

    const explicitLoaded = loadProject02RuntimeConfig({ configPath });
    const envLoaded = loadProject02RuntimeConfig({
      env: {
        [runtimeConfigEnvVarName]: configPath
      }
    });

    expect(explicitLoaded.config?.storeRoot).toBeUndefined();
    expect(envLoaded.config?.storeRoot).toBeUndefined();
    expect(
      resolveProject02RuntimeConfig({ loadedConfig: explicitLoaded }).storeRoot
    ).toBe(seededStoreRoot);
    expect(resolveProject02RuntimeConfig({ loadedConfig: envLoaded }).storeRoot).toBe(
      seededStoreRoot
    );
  });

  it('infers store root from canonical symlink targets for store-default configs selected by path or env', () => {
    const targetStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-store-default-link-target-')
    );
    const linkStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-store-default-link-selected-')
    );
    const seededStoreRoot = realpathSync.native(targetStoreRoot);
    const targetConfigPath = defaultRuntimeConfigPath(targetStoreRoot);
    const linkConfigPath = defaultRuntimeConfigPath(linkStoreRoot);

    writeRuntimeConfig(targetConfigPath, {});
    symlinkSync(targetConfigPath, linkConfigPath);

    const explicitLoaded = loadProject02RuntimeConfig({
      configPath: linkConfigPath
    });
    const envLoaded = loadProject02RuntimeConfig({
      env: {
        [runtimeConfigEnvVarName]: linkConfigPath
      }
    });

    expect(explicitLoaded.config?.storeRoot).toBeUndefined();
    expect(envLoaded.config?.storeRoot).toBeUndefined();
    expect(
      resolveProject02RuntimeConfig({ loadedConfig: explicitLoaded }).storeRoot
    ).toBe(seededStoreRoot);
    expect(resolveProject02RuntimeConfig({ loadedConfig: envLoaded }).storeRoot).toBe(
      seededStoreRoot
    );
  });

  it('rejects unknown top-level config fields and blocks default activation', async () => {
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-unknown-root-')), 'config.json'),
      {
        store_root: 'typo-store'
      }
    );
    const loaded = loadProject02RuntimeConfig({ configPath });
    let stdout = '';

    expect(loaded.config).toBeUndefined();
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_config_unknown_top_level_field',
        path: 'store_root'
      })
    ]);

    const configured = await createConfiguredProject02PluginHost({ loadedConfig: loaded });

    expect(configured.activation.enabledPluginIds).not.toContain('character-state');
    expect(configured.activation.plugins[0]).toMatchObject({
      pluginId: 'character-state',
      enabled: false,
      activationStatus: 'blocked'
    });

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'check'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(1);
    expect(stdout).toContain('"runtime_config_unknown_top_level_field"');
    expect(stdout).toContain('"store_root"');
  });

  it('rejects unknown plugin wrapper fields and blocks that plugin activation', async () => {
    const configPath = writeRuntimeConfig(
      join(
        mkdtempSync(join(tmpdir(), 'project02-config-unknown-plugin-wrapper-')),
        'config.json'
      ),
      {
        plugins: {
          'character-state': {
            enable: false
          }
        }
      }
    );
    const loaded = loadProject02RuntimeConfig({ configPath });
    let stdout = '';

    expect(loaded.config).toBeUndefined();
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_config_unknown_plugin_wrapper_field',
        path: 'plugins.character-state.enable',
        pluginId: 'character-state'
      })
    ]);

    const configured = await createConfiguredProject02PluginHost({ loadedConfig: loaded });

    expect(configured.activation.enabledPluginIds).not.toContain('character-state');
    expect(configured.activation.plugins[0]).toMatchObject({
      pluginId: 'character-state',
      enabled: false,
      activationStatus: 'blocked'
    });
    expect(configured.activation.plugins[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_unknown_plugin_wrapper_field',
          path: 'plugins.character-state.enable'
        })
      ])
    );

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'check'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(1);
    expect(stdout).toContain('"runtime_config_unknown_plugin_wrapper_field"');
    expect(stdout).toContain('"activationStatus": "blocked"');
  });

  it('treats unknown plugin wrapper load errors as global activation blockers', async () => {
    const configPath = writeRuntimeConfig(
      join(
        mkdtempSync(join(tmpdir(), 'project02-config-unknown-plugin-global-')),
        'config.json'
      ),
      {
        plugins: {
          unknown: {
            enable: true
          }
        }
      }
    );
    const loaded = loadProject02RuntimeConfig({ configPath });
    let factoryCalls = 0;

    expect(loaded.config).toBeUndefined();
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_config_unknown_plugin_wrapper_field',
        path: 'plugins.unknown.enable',
        pluginId: 'unknown'
      })
    ]);

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loaded,
      factories: {
        'character-state': {
          manifest: createCharacterStatePluginManifest(),
          create() {
            factoryCalls += 1;

            return createCharacterStatePlugin();
          }
        }
      }
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([]);
    expect(configured.activation.plugins[0]).toMatchObject({
      pluginId: 'character-state',
      enabled: false,
      activationStatus: 'blocked'
    });
    expect(configured.activation.plugins[0]?.diagnostics).toEqual([]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_unknown_plugin_wrapper_field',
          path: 'plugins.unknown.enable',
          pluginId: 'unknown'
        })
      ])
    );
  });

  it('treats known plugin wrapper load errors as global activation blockers', async () => {
    const badPlugin = requiredSecretPlugin('bad');
    const configPath = writeRuntimeConfig(
      join(
        mkdtempSync(join(tmpdir(), 'project02-config-known-plugin-global-')),
        'config.json'
      ),
      {
        plugins: {
          bad: {
            enable: true
          }
        }
      }
    );
    const loaded = loadProject02RuntimeConfig({ configPath });
    let manifestBackedFactoryCalls = 0;
    let legacyFactoryCalls = 0;

    expect(loaded.config).toBeUndefined();
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_config_unknown_plugin_wrapper_field',
        path: 'plugins.bad.enable',
        pluginId: 'bad'
      })
    ]);

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loaded,
      factories: {
        'character-state': {
          manifest: createCharacterStatePluginManifest(),
          create() {
            manifestBackedFactoryCalls += 1;
            throw new Error('unrelated factory should not be constructed');
          }
        },
        bad: {
          manifest: badPlugin.manifest,
          create() {
            manifestBackedFactoryCalls += 1;
            throw new Error('invalid plugin factory should not be constructed');
          }
        },
        legacy() {
          legacyFactoryCalls += 1;

          return requiredSecretPlugin('legacy');
        }
      }
    });
    const badActivation = configured.activation.plugins.find(
      (plugin) => plugin.pluginId === 'bad'
    );
    const characterActivation = configured.activation.plugins.find(
      (plugin) => plugin.pluginId === 'character-state'
    );

    expect(manifestBackedFactoryCalls).toBe(0);
    expect(legacyFactoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([]);
    expect(characterActivation).toMatchObject({
      pluginId: 'character-state',
      enabled: false,
      activationStatus: 'blocked'
    });
    expect(characterActivation?.diagnostics).toEqual([]);
    expect(badActivation).toMatchObject({
      pluginId: 'bad',
      enabled: false,
      activationStatus: 'blocked'
    });
    expect(badActivation?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_unknown_plugin_wrapper_field',
          path: 'plugins.bad.enable',
          pluginId: 'bad'
        })
      ])
    );
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_unknown_plugin_wrapper_field',
          path: 'plugins.bad.enable',
          pluginId: 'bad'
        })
      ])
    );
  });

  it('redacts secret env refs and keeps fingerprints independent of env secret values', () => {
    const plugin = createCharacterStatePlugin();
    const loaded = loadProject02RuntimeConfig({
      configPath: writeRuntimeConfig(
        join(mkdtempSync(join(tmpdir(), 'project02-config-secret-')), 'config.json'),
        {
          plugins: {
            [plugin.manifest.id]: {
              config: {
                apiKey: { $env: 'PROJECT02_TEST_SECRET' }
              }
            }
          }
        }
      )
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
            redactionLabels: ['secret']
          }
        ]
      }
    };
    const first = resolveProject02RuntimeConfig({
      loadedConfig: loaded,
      pluginManifests: [manifest],
      env: { PROJECT02_TEST_SECRET: 'first-secret' }
    });
    const second = resolveProject02RuntimeConfig({
      loadedConfig: loaded,
      pluginManifests: [manifest],
      env: { PROJECT02_TEST_SECRET: 'second-secret' }
    });

    expect(first.redactedPluginConfigs['character-state']?.['apiKey']).toMatchObject({
      value: '[redacted]',
      source: 'env:PROJECT02_TEST_SECRET',
      resolved: true
    });
    expect(JSON.stringify(first.redactedPluginConfigs)).not.toContain('first-secret');
    expect(first.effectiveConfigFingerprint).not.toContain('first-secret');
    expect(first.effectiveConfigFingerprint).toBe(second.effectiveConfigFingerprint);
  });

  it('includes per-plugin enabled flags in effective fingerprints without leaking secrets', () => {
    const plugin = requiredSecretPlugin();
    const enabledPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-enabled-fingerprint-')), 'config.json'),
      {
        plugins: {
          [plugin.manifest.id]: {
            enabled: true,
            config: {
              apiKey: { $env: 'PROJECT02_ENABLED_FINGERPRINT_SECRET' }
            }
          }
        }
      }
    );
    const disabledPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-disabled-fingerprint-')), 'config.json'),
      {
        plugins: {
          [plugin.manifest.id]: {
            enabled: false,
            config: {
              apiKey: { $env: 'PROJECT02_ENABLED_FINGERPRINT_SECRET' }
            }
          }
        }
      }
    );
    const enabledFirst = resolveProject02RuntimeConfig({
      loadedConfig: loadProject02RuntimeConfig({ configPath: enabledPath }),
      pluginManifests: [plugin.manifest],
      env: { PROJECT02_ENABLED_FINGERPRINT_SECRET: 'first-secret' }
    });
    const enabledSecond = resolveProject02RuntimeConfig({
      loadedConfig: loadProject02RuntimeConfig({ configPath: enabledPath }),
      pluginManifests: [plugin.manifest],
      env: { PROJECT02_ENABLED_FINGERPRINT_SECRET: 'second-secret' }
    });
    const disabled = resolveProject02RuntimeConfig({
      loadedConfig: loadProject02RuntimeConfig({ configPath: disabledPath }),
      pluginManifests: [plugin.manifest],
      env: { PROJECT02_ENABLED_FINGERPRINT_SECRET: 'first-secret' }
    });

    expect(enabledFirst.effectiveConfigFingerprint).toBe(
      enabledSecond.effectiveConfigFingerprint
    );
    expect(enabledFirst.effectiveConfigFingerprint).not.toBe(
      disabled.effectiveConfigFingerprint
    );
    expect(JSON.stringify(enabledFirst.redactedPluginConfigs)).not.toContain(
      'first-secret'
    );
    expect(enabledFirst.effectiveConfigFingerprint).not.toContain('first-secret');
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
            redactionLabels: []
          },
          {
            name: 'token',
            description: 'Compatibility token field.',
            required: false,
            secret: false,
            valueType: 'string' as const,
            redactionLabels: []
          },
          {
            name: 'metadata',
            description: 'Structured metadata.',
            required: false,
            secret: false,
            valueType: 'object' as const,
            redactionLabels: []
          }
        ]
      }
    };
    const first = resolveProject02RuntimeConfig({
      loadedConfig: loadProject02RuntimeConfig({
        configPath: writeRuntimeConfig(
          join(
            mkdtempSync(join(tmpdir(), 'project02-config-credential-fields-a-')),
            'runtime.json'
          ),
          {
            plugins: {
              [plugin.manifest.id]: {
                config: {
                  apiKey: 'first-api-key',
                  token: 'first-token',
                  metadata: {
                    access_token: 'first-nested-token',
                    label: 'visible-label'
                  }
                }
              }
            }
          }
        )
      }),
      pluginManifests: [manifest]
    });
    const second = resolveProject02RuntimeConfig({
      loadedConfig: loadProject02RuntimeConfig({
        configPath: writeRuntimeConfig(
          join(
            mkdtempSync(join(tmpdir(), 'project02-config-credential-fields-b-')),
            'runtime.json'
          ),
          {
            plugins: {
              [plugin.manifest.id]: {
                config: {
                  apiKey: 'second-api-key',
                  token: 'second-token',
                  metadata: {
                    access_token: 'second-nested-token',
                    label: 'visible-label'
                  }
                }
              }
            }
          }
        )
      }),
      pluginManifests: [manifest]
    });

    expect(first.pluginConfigs['character-state']?.['apiKey']?.value).toBe(
      'first-api-key'
    );
    expect(first.redactedPluginConfigs['character-state']).toMatchObject({
      apiKey: {
        secret: false,
        value: '[redacted]'
      },
      token: {
        secret: false,
        value: '[redacted]'
      },
      metadata: {
        value: {
          access_token: '[redacted]',
          label: 'visible-label'
        }
      }
    });
    expect(JSON.stringify(first.redactedPluginConfigs)).not.toContain('first-api-key');
    expect(JSON.stringify(first.redactedPluginConfigs)).not.toContain('first-token');
    expect(JSON.stringify(first.redactedPluginConfigs)).not.toContain(
      'first-nested-token'
    );
    expect(first.effectiveConfigFingerprint).toBe(second.effectiveConfigFingerprint);
  });

  it('rejects nested secret refs in non-secret object and array config fields', async () => {
    const plugin = structuredConfigPlugin('memory.structured');
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-nested-secret-ref-')), 'config.json'),
      {
        plugins: {
          'memory.structured': {
            enabled: true,
            config: {
              settings: {
                apiKey: { $env: 'PROJECT02_NESTED_OBJECT_SECRET' }
              },
              endpoints: [
                {
                  token: { $env: 'PROJECT02_NESTED_ARRAY_SECRET' }
                }
              ]
            }
          }
        }
      }
    );
    let factoryCalls = 0;

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      factories: {
        'memory.structured': {
          manifest: plugin.manifest,
          create() {
            factoryCalls += 1;
            throw new Error('factory should not receive nested secret refs');
          }
        }
      },
      env: {
        PROJECT02_NESTED_OBJECT_SECRET: 'object-secret',
        PROJECT02_NESTED_ARRAY_SECRET: 'array-secret'
      }
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.resolvedConfig.pluginConfigs['memory.structured']).toMatchObject({
      settings: {
        source: 'config',
        resolved: false
      },
      endpoints: {
        source: 'config',
        resolved: false
      }
    });
    expect(
      configured.resolvedConfig.pluginConfigs['memory.structured']?.['settings']
    ).not.toHaveProperty('value');
    expect(
      configured.resolvedConfig.pluginConfigs['memory.structured']?.['endpoints']
    ).not.toHaveProperty('value');
    expect(configured.activation.enabledPluginIds).not.toContain('memory.structured');
    expect(configured.activation.plugins[0]).toMatchObject({
      pluginId: 'memory.structured',
      activationStatus: 'blocked'
    });
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_secret_ref_for_non_secret',
          path: 'plugins.memory.structured.config.settings.apiKey',
          pluginId: 'memory.structured',
          pluginConfigField: 'settings'
        }),
        expect.objectContaining({
          code: 'runtime_config_secret_ref_for_non_secret',
          path: 'plugins.memory.structured.config.endpoints.0.token',
          pluginId: 'memory.structured',
          pluginConfigField: 'endpoints'
        })
      ])
    );
  });

  it('rejects plaintext secret values by default', () => {
    const plugin = createCharacterStatePlugin();
    const loaded = loadProject02RuntimeConfig({
      configPath: writeRuntimeConfig(
        join(mkdtempSync(join(tmpdir(), 'project02-config-plaintext-')), 'config.json'),
        {
          plugins: {
            [plugin.manifest.id]: {
              config: {
                apiKey: 'plaintext-secret'
              }
            }
          }
        }
      )
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
                redactionLabels: ['secret']
              }
            ]
          }
        }
      ]
    });

    expect(resolved.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_plaintext_secret_rejected'
        })
      ])
    );
    expect(JSON.stringify(resolved)).not.toContain('plaintext-secret');
  });

  it('treats empty env values for required secrets as missing', () => {
    const envVar = 'PROJECT02_EMPTY_SECRET_3447588015';
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-empty-secret-')), 'config.json'),
      {
        plugins: {
          'memory.required': {
            config: {
              apiKey: { $env: envVar }
            }
          }
        }
      }
    );
    const resolved = resolveProject02RuntimeConfig({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      pluginManifests: [requiredSecretPlugin().manifest],
      env: { [envVar]: '' }
    });
    const resolvedField = resolved.pluginConfigs['memory.required']?.['apiKey'];

    expect(resolvedField).toMatchObject({
      source: `env:${envVar}`,
      resolved: false
    });
    expect(resolvedField).not.toHaveProperty('value');
    expect(resolved.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_secret_missing',
          path: 'plugins.memory.required.config.apiKey'
        })
      ])
    );
  });

  it('resolves manifest secret env var defaults without raw config', async () => {
    const envVar = 'PROJECT02_MANIFEST_DEFAULT_SECRET_3449527784';
    const plugin = requiredSecretPluginWithManifestEnvVar(
      'memory.manifest-default-secret',
      envVar
    );
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-manifest-env-default-')), 'config.json'),
      {
        plugins: {
          [plugin.manifest.id]: {
            enabled: true
          }
        }
      }
    );
    const factoryInputs: unknown[] = [];

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      env: { [envVar]: 'manifest-default-secret' },
      factories: {
        [plugin.manifest.id]: {
          manifest: plugin.manifest,
          create(input) {
            factoryInputs.push(input.resolvedConfig['apiKey']?.value);

            return plugin;
          }
        }
      }
    });

    expect(configured.activation.enabledPluginIds).toContain(plugin.manifest.id);
    expect(factoryInputs).toEqual(['manifest-default-secret']);
    expect(configured.resolvedConfig.pluginConfigs[plugin.manifest.id]?.['apiKey']).toMatchObject({
      source: `env:${envVar}`,
      resolved: true,
      value: 'manifest-default-secret'
    });
    expect(configured.activation.diagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_reserved_control_env_var'
    );
  });

  it.each(runtimeControlEnvVarNames)(
    'rejects reserved runtime control env var %s in manifest secret defaults',
    async (envVar) => {
      const plugin = requiredSecretPluginWithManifestEnvVar(
        'memory.reserved-manifest-secret',
        envVar
      );
      const configPath = writeRuntimeConfig(
        join(
          mkdtempSync(join(tmpdir(), 'project02-config-manifest-reserved-env-')),
          'config.json'
        ),
        {
          plugins: {
            [plugin.manifest.id]: {
              enabled: true
            }
          }
        }
      );
      let factoryCalls = 0;
      const configured = await createConfiguredProject02PluginHost({
        loadedConfig: loadProject02RuntimeConfig({ configPath }),
        env: { [envVar]: 'runtime-control-value' },
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error('reserved control env var must block activation');
            }
          }
        }
      });
      const resolvedField =
        configured.resolvedConfig.pluginConfigs[plugin.manifest.id]?.['apiKey'];
      const activation = configured.activation.plugins.find(
        (item) => item.pluginId === plugin.manifest.id
      );

      expect(factoryCalls).toBe(0);
      expect(configured.activation.enabledPluginIds).not.toContain(plugin.manifest.id);
      expect(resolvedField).toMatchObject({
        source: `env:${envVar}`,
        resolved: false
      });
      expect(resolvedField).not.toHaveProperty('value');
      expect(configured.activation.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'runtime_config_reserved_control_env_var',
            path: `plugins.${plugin.manifest.id}.config.apiKey`,
            pluginId: plugin.manifest.id,
            pluginConfigField: 'apiKey'
          })
        ])
      );
      expect(activation).toMatchObject({
        pluginId: plugin.manifest.id,
        enabled: false,
        activationStatus: 'blocked'
      });
      expect(activation?.activationReasons).toContain('blocked_by_config_errors');
      expect(JSON.stringify(configured.resolvedConfig)).not.toContain(
        'runtime-control-value'
      );
    }
  );

  it('rejects unknown config fields for enabled or default-enabled plugins', async () => {
    const envVar = 'PROJECT02_UNKNOWN_FIELD_SECRET_3447705094';
    const plugin = requiredSecretPlugin();
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-unknown-field-')), 'config.json'),
      {
        plugins: {
          'memory.required': {
            config: {
              apiKey: { $env: envVar },
              zetaTypo: 'ignored',
              alphaTypo: 'ignored'
            }
          }
        }
      }
    );
    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      factories: {
        'memory.required': {
          manifest: plugin.manifest,
          create: () => plugin
        }
      },
      env: { [envVar]: 'configured-secret' }
    });

    expect(configured.resolvedConfig.diagnostics).toEqual([
      expect.objectContaining({
        code: 'runtime_config_unknown_plugin_config_field',
        path: 'plugins.memory.required.config.alphaTypo'
      }),
      expect.objectContaining({
        code: 'runtime_config_unknown_plugin_config_field',
        path: 'plugins.memory.required.config.zetaTypo'
      })
    ]);
    expect(configured.activation.enabledPluginIds).not.toContain('memory.required');
    expect(configured.activation.plugins[0]).toMatchObject({
      pluginId: 'memory.required',
      activationStatus: 'blocked'
    });
    expect(configured.activation.plugins[0]?.diagnostics.map((item) => item.code)).toEqual([
      'runtime_config_unknown_plugin_config_field',
      'runtime_config_unknown_plugin_config_field'
    ]);
  });

  it('blocks plugins when missing required dotted fields contain config', async () => {
    const plugin = requiredDottedConfigPlugin('memory');
    const missingPath = 'plugins.memory.config.api.config.key';
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-dotted-field-')), 'config.json'),
      {}
    );
    let factoryCalls = 0;

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      factories: {
        memory: {
          manifest: plugin.manifest,
          create() {
            factoryCalls += 1;

            return plugin;
          }
        }
      }
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).not.toContain('memory');
    expect(configured.activation.plugins[0]).toMatchObject({
      pluginId: 'memory',
      enabled: false,
      activationStatus: 'blocked'
    });
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_value_missing',
          path: missingPath
        })
      ])
    );
    expect(configured.activation.plugins[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_value_missing',
          path: missingPath
        })
      ])
    );
  });

  it('blocks all plugin factory creation when activation diagnostics contain plugin errors', async () => {
    const characterPlugin = createCharacterStatePlugin();
    const memoryPlugin = requiredSecretPlugin();
    const configPath = writeRuntimeConfig(
      join(
        mkdtempSync(join(tmpdir(), 'project02-config-plugin-error-blocks-all-')),
        'config.json'
      ),
      {
        plugins: {
          'memory.required': {
            enabled: true
          }
        }
      }
    );
    let characterFactoryCalls = 0;
    let memoryFactoryCalls = 0;
    let legacyFactoryCalls = 0;

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      factories: {
        'character-state': {
          manifest: characterPlugin.manifest,
          create() {
            characterFactoryCalls += 1;

            return characterPlugin;
          }
        },
        'memory.required': {
          manifest: memoryPlugin.manifest,
          create() {
            memoryFactoryCalls += 1;

            return memoryPlugin;
          }
        },
        'legacy.side-effect': () => {
          legacyFactoryCalls += 1;
          throw new Error('legacy factory should not be constructed');
        }
      }
    });
    const characterActivation = configured.activation.plugins.find(
      (plugin) => plugin.pluginId === 'character-state'
    );
    const memoryActivation = configured.activation.plugins.find(
      (plugin) => plugin.pluginId === 'memory.required'
    );

    expect(characterFactoryCalls).toBe(0);
    expect(memoryFactoryCalls).toBe(0);
    expect(legacyFactoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_required_secret_missing',
          path: 'plugins.memory.required.config.apiKey',
          pluginId: 'memory.required',
          pluginConfigField: 'apiKey'
        })
      ])
    );
    expect(characterActivation).toMatchObject({
      pluginId: 'character-state',
      enabled: false,
      activationStatus: 'blocked'
    });
    expect(characterActivation?.activationReasons).toContain(
      'blocked_by_config_errors'
    );
    expect(memoryActivation).toMatchObject({
      pluginId: 'memory.required',
      enabled: false,
      activationStatus: 'blocked'
    });
    expect(memoryActivation?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_secret_missing',
          path: 'plugins.memory.required.config.apiKey'
        })
      ])
    );
  });

  it('lets explicit per-plugin disable win over legacy enabledPlugins', async () => {
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-disable-')), 'config.json'),
      {
        enabledPlugins: ['character-state'],
        plugins: {
          'character-state': {
            enabled: false
          }
        }
      }
    );
    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath })
    });

    expect(configured.activation.enabledPluginIds).not.toContain('character-state');
    expect(configured.activation.plugins[0]).toMatchObject({
      pluginId: 'character-state',
      enabled: false,
      activationStatus: 'disabled'
    });
    expect(configured.activation.plugins[0]?.activationReasons).toContain('disabled_by_config');
  });

  it('keeps explicitly disabled plugins disabled even when their config is incomplete', async () => {
    const plugin = requiredSecretPlugin();
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-disable-invalid-')), 'config.json'),
      {
        plugins: {
          'memory.required': {
            enabled: false,
            config: {
              misspelledApiKey: 'ignored'
            }
          }
        }
      }
    );
    let factoryCalls = 0;
    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      factories: {
        'memory.required': {
          manifest: plugin.manifest,
          create() {
            factoryCalls += 1;
            throw new Error('disabled plugin should not be constructed');
          }
        }
      }
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.plugins[0]).toMatchObject({
      pluginId: 'memory.required',
      enabled: false,
      activationStatus: 'disabled'
    });
    expect(configured.activation.plugins[0]?.activationReasons).toContain('disabled_by_config');
    expect(configured.activation.diagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_required_secret_missing'
    );
    expect(configured.activation.diagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_unknown_plugin_config_field'
    );
  });

  it('skips unreferenced legacy factories instead of discovering default activation', async () => {
    const configPath = writeRuntimeConfig(
      join(
        mkdtempSync(join(tmpdir(), 'project02-config-default-legacy-factory-')),
        'config.json'
      ),
      {}
    );
    let legacyFactoryCalls = 0;

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      factories: {
        'memory.required': () => {
          legacyFactoryCalls += 1;
          throw new Error('unreferenced legacy factory should not be constructed');
        }
      }
    });

    expect(legacyFactoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([]);
    expect(configured.activation.diagnostics).toEqual([]);
  });

  it('skips explicitly disabled legacy function plugin factories before creation', async () => {
    const configPath = writeRuntimeConfig(
      join(
        mkdtempSync(join(tmpdir(), 'project02-config-disabled-legacy-factory-')),
        'config.json'
      ),
      {
        enabledPlugins: ['memory.required'],
        plugins: {
          'memory.required': {
            enabled: false
          }
        }
      }
    );
    let legacyFactoryCalls = 0;

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      factories: {
        'memory.required': () => {
          legacyFactoryCalls += 1;
          throw new Error('disabled legacy plugin should not be constructed');
        }
      }
    });

    expect(legacyFactoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([]);
    expect(configured.activation.diagnostics).toEqual([]);
  });

  it('blocks configured legacy function factories before missing config can trigger construction', async () => {
    const configPath = writeRuntimeConfig(
      join(
        mkdtempSync(join(tmpdir(), 'project02-config-enabled-legacy-factory-')),
        'config.json'
      ),
      {
        plugins: {
          'memory.required': {
            enabled: true
          }
        }
      }
    );
    let legacyFactoryCalls = 0;

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      factories: {
        'memory.required': () => {
          legacyFactoryCalls += 1;

          return requiredSecretPlugin();
        }
      }
    });

    expect(legacyFactoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_legacy_factory_unchecked',
          path: 'plugins.memory.required.enabled',
          pluginId: 'memory.required'
        })
      ])
    );
  });

  it('uses supplied env maps when creating configured plugin hosts', async () => {
    const envVar = 'PROJECT02_SUPPLIED_ONLY_SECRET_3447588016';
    const previousEnvValue = process.env[envVar];
    process.env[envVar] = '';

    try {
      const configPath = writeRuntimeConfig(
        join(mkdtempSync(join(tmpdir(), 'project02-config-supplied-env-')), 'config.json'),
        {
          plugins: {
            'memory.required': {
              enabled: true,
              config: {
                apiKey: { $env: envVar }
              }
            }
          }
        }
      );
      const configured = await createConfiguredProject02PluginHost({
        loadedConfig: loadProject02RuntimeConfig({ configPath }),
        factories: {
          'memory.required': {
            manifest: requiredSecretPlugin().manifest,
            create: () => requiredSecretPlugin()
          }
        },
        env: { [envVar]: 'from-supplied-env' }
      });

      expect(configured.activation.enabledPluginIds).toContain('memory.required');
      expect(configured.activation.diagnostics.map((item) => item.code)).not.toContain(
        'runtime_config_required_secret_missing'
      );
      expect(
        configured.resolvedConfig.pluginConfigs['memory.required']?.['apiKey']
      ).toMatchObject({
        source: `env:${envVar}`,
        resolved: true,
        value: 'from-supplied-env'
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
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-factory-'));
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      storeRoot,
      plugins: {
        'memory.required': {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
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
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      factories: {
        'character-state': {
          manifest: createCharacterStatePluginManifest(),
          create() {
            characterFactoryCalls += 1;

            return createCharacterStatePlugin();
          }
        },
        'memory.required': {
          manifest: requiredSecretPlugin().manifest,
          create(input) {
            memoryFactoryCalls += 1;
            memoryFactoryInputs.push({
              pluginId: input.pluginId,
              storeRoot: input.storeRoot,
              apiKeyValue: input.resolvedConfig['apiKey']?.value,
              redactedApiKeyValue: input.redactedConfig['apiKey']?.value
            });

            return requiredSecretPlugin();
          }
        }
      },
      env: { [envVar]: 'from-manifest-backed-factory' }
    });

    expect(characterFactoryCalls).toBe(1);
    expect(memoryFactoryCalls).toBe(1);
    expect(memoryFactoryInputs).toEqual([
      {
        pluginId: 'memory.required',
        storeRoot,
        apiKeyValue: 'from-manifest-backed-factory',
        redactedApiKeyValue: '[redacted]'
      }
    ]);
    expect(configured.activation.enabledPluginIds).toEqual([
      'character-state',
      'memory.required'
    ]);
  });

  it('plans inactive manifest-backed plugin factories without constructing them', async () => {
    const disabledPlugin = requiredSecretPlugin('memory.disabled');
    const blockedPlugin = requiredSecretPlugin('memory.blocked');
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-inactive-factory-')), 'config.json'),
      {
        plugins: {
          'memory.disabled': {
            enabled: false
          },
          'memory.blocked': {
            enabled: true
          }
        }
      }
    );
    let factoryCalls = 0;

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      factories: {
        'memory.disabled': {
          manifest: disabledPlugin.manifest,
          create() {
            factoryCalls += 1;
            throw new Error('disabled plugin should not be constructed');
          }
        },
        'memory.blocked': {
          manifest: blockedPlugin.manifest,
          create() {
            factoryCalls += 1;
            throw new Error('blocked plugin should not be constructed');
          }
        }
      }
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(
      configured.activation.plugins.map((plugin) => [
        plugin.pluginId,
        plugin.activationStatus
      ])
    ).toEqual([
      ['memory.disabled', 'disabled'],
      ['memory.blocked', 'blocked']
    ]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_secret_missing',
          path: 'plugins.memory.blocked.config.apiKey'
        })
      ])
    );
  });

  it('passes config-resolved store roots to manifest-backed plugin factories', async () => {
    const cliStoreRoot = mkdtempSync(join(tmpdir(), 'project02-config-cli-root-'));
    const configuredStoreRoot = mkdtempSync(join(tmpdir(), 'project02-config-file-root-'));
    const envVar = 'PROJECT02_CONFIG_ROOT_FACTORY_SECRET_3448745052';
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-legacy-root-')), 'config.json'),
      {
        storeRoot: configuredStoreRoot,
        plugins: {
          'memory.required': {
            enabled: true,
            config: {
              apiKey: { $env: envVar }
            }
          }
        }
      }
    );
    let factoryStoreRoot: string | undefined;

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      storeRoot: cliStoreRoot,
      factories: {
        'memory.required': {
          manifest: requiredSecretPlugin().manifest,
          create(input) {
            factoryStoreRoot = input.storeRoot;

            return requiredSecretPlugin();
          }
        }
      },
      env: { [envVar]: 'from-configured-store-root' }
    });

    expect(factoryStoreRoot).toBe(configuredStoreRoot);
    expect(configured.resolvedConfig.storeRoot).toBe(configuredStoreRoot);
  });

  it('fails activation checks when multiple explicitly enabled memory providers are ambiguous', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-memory-ambiguous-'));
    const memoryOne = memoryProviderPlugin('memory.one');
    const memoryTwo = memoryProviderPlugin('memory.two');
    const factories = {
      'memory.one': {
        manifest: memoryOne.manifest,
        create: () => memoryOne
      },
      'memory.two': {
        manifest: memoryTwo.manifest,
        create: () => memoryTwo
      }
    };
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'memory.one': {
          enabled: true
        },
        'memory.two': {
          enabled: true
        }
      }
    });
    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ storeRoot }),
      factories
    });

    expect(configured.activation.enabledPluginIds).toEqual([]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'ambiguous_memory_provider_selection',
          path: 'defaultMemoryProvider'
        })
      ])
    );
    expect(
      configured.activation.plugins.map((plugin) => [
        plugin.pluginId,
        plugin.activationStatus
      ])
    ).toEqual([
      ['memory.one', 'blocked'],
      ['memory.two', 'blocked']
    ]);

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories
      })
    ).toBe(1);
    expect(stdout).toContain('"ambiguous_memory_provider_selection"');
    expect(stdout).toContain('"severity": "error"');
  });

  it('treats a typoed explicit default memory provider as an activation-wide error when another provider is enabled', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-memory-default-typo-'));
    const enabledPlugin = memoryProviderPlugin('memory.enabled');
    let factoryCalls = 0;
    const factories = {
      'character-state': {
        manifest: createCharacterStatePluginManifest(),
        create() {
          factoryCalls += 1;
          throw new Error('default plugin should not be constructed');
        }
      },
      'memory.enabled': {
        manifest: enabledPlugin.manifest,
        create() {
          factoryCalls += 1;
          throw new Error('unselected memory plugin should not be constructed');
        }
      }
    };
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'memory.typo',
      plugins: {
        'memory.enabled': {
          enabled: true
        }
      }
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ storeRoot }),
      factories
    });
    const characterActivation = configured.activation.plugins.find(
      (plugin) => plugin.pluginId === 'character-state'
    );
    const memoryActivation = configured.activation.plugins.find(
      (plugin) => plugin.pluginId === 'memory.enabled'
    );

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_unavailable',
          path: 'defaultMemoryProvider'
        })
      ])
    );
    expect(characterActivation).toMatchObject({
      pluginId: 'character-state',
      enabled: false,
      activationStatus: 'blocked'
    });
    expect(characterActivation?.activationReasons).toContain(
      'blocked_by_config_errors'
    );
    expect(memoryActivation).toMatchObject({
      pluginId: 'memory.enabled',
      enabled: false,
      activationStatus: 'disabled'
    });
    expect(memoryActivation?.activationReasons).toContain(
      'not_selected_as_default_memory_provider'
    );

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories
      })
    ).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(stdout).toContain('"default_memory_provider_unavailable"');
    expect(stdout).toContain('"severity": "error"');
  });

  it('treats a known non-memory default memory provider as an activation error', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-memory-default-non-memory-')
    );
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'character-state'
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ storeRoot })
    });

    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_not_memory_provider',
          path: 'defaultMemoryProvider',
          pluginId: 'character-state'
        })
      ])
    );
    expect(configured.activation.plugins[0]).toMatchObject({
      pluginId: 'character-state',
      enabled: false,
      activationStatus: 'blocked'
    });

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(1);
    expect(stdout).toContain('"default_memory_provider_not_memory_provider"');
    expect(stdout).toContain('"severity": "error"');
  });

  it('treats an inactive explicit default memory provider as an activation error when another provider is enabled', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-memory-default-inactive-'));
    const enabledPlugin = memoryProviderPlugin('memory.enabled');
    const disabledPlugin = memoryProviderPlugin('memory.disabled');
    const factories = {
      'memory.enabled': {
        manifest: enabledPlugin.manifest,
        create: () => enabledPlugin
      },
      'memory.disabled': {
        manifest: disabledPlugin.manifest,
        create: () => disabledPlugin
      }
    };
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'memory.disabled',
      plugins: {
        'memory.enabled': {
          enabled: true
        },
        'memory.disabled': {
          enabled: false
        }
      }
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ storeRoot }),
      factories
    });

    expect(configured.activation.enabledPluginIds).toEqual([]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_unavailable',
          path: 'defaultMemoryProvider'
        })
      ])
    );
    expect(
      configured.activation.plugins.map((plugin) => [
        plugin.pluginId,
        plugin.activationStatus
      ])
    ).toEqual([
      ['memory.enabled', 'disabled'],
      ['memory.disabled', 'disabled']
    ]);
    expect(configured.activation.plugins[0]?.activationReasons).toContain(
      'not_selected_as_default_memory_provider'
    );
    expect(configured.activation.plugins[1]?.activationReasons).toContain(
      'disabled_by_config'
    );

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories
      })
    ).toBe(1);
    expect(stdout).toContain('"default_memory_provider_unavailable"');
    expect(stdout).toContain('"severity": "error"');
  });

  it('treats a disabled explicit default memory provider as an activation error without another provider enabled', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-memory-default-disabled-'));
    const disabledPlugin = memoryProviderPlugin('memory.disabled');
    let factoryCalls = 0;
    const factories = {
      'memory.disabled': {
        manifest: disabledPlugin.manifest,
        create() {
          factoryCalls += 1;
          throw new Error('disabled memory provider should not be constructed');
        }
      }
    };
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      defaultMemoryProvider: 'memory.disabled',
      plugins: {
        'memory.disabled': {
          enabled: false
        }
      }
    });

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ storeRoot }),
      factories
    });

    expect(factoryCalls).toBe(0);
    expect(configured.plugins).toEqual([]);
    expect(configured.activation.enabledPluginIds).toEqual([]);
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'default_memory_provider_unavailable',
          path: 'defaultMemoryProvider'
        })
      ])
    );
    expect(configured.activation.plugins).toEqual([
      expect.objectContaining({
        pluginId: 'memory.disabled',
        enabled: false,
        activationStatus: 'disabled'
      })
    ]);
    expect(configured.activation.plugins[0]?.activationReasons).toContain(
      'disabled_by_config'
    );

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories
      })
    ).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(stdout).toContain('"default_memory_provider_unavailable"');
    expect(stdout).toContain('"severity": "error"');
  });
});

describe('runtime config CLI', () => {
  it('writes non-secret and secret-ref config through the shared mutation path', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-cli-'));
    let stdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'plugin', 'disable', 'character-state'],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'plugin', 'enable', 'memory.recall'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--store',
          storeRoot,
          'secret',
          'set',
          'mem0-local',
          'cloudApiKey',
          'MEM0_API_KEY'
        ],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { MEM0_API_KEY: 'super-secret' }
        }
      )
    ).toBe(0);

    const config: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(stdout).toContain('config.json');
    expect(config).toMatchObject({
      plugins: {
        'character-state': { enabled: false },
        'memory.recall': { enabled: true },
        'mem0-local': {
          config: { cloudApiKey: { $env: 'MEM0_API_KEY' } }
        }
      }
    });
    expect(readFileSync(join(storeRoot, '.env'), 'utf8')).toContain(
      'MEM0_API_KEY="super-secret"'
    );
    expect((statSync(join(storeRoot, '.env')).mode & 0o777).toString(8)).toBe('600');
  });

  it('seeds explicit store roots into newly created store configs', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-cli-store-seed-'));
    const seededStoreRoot = realpathSync.native(storeRoot);
    const configPath = join(storeRoot, 'config.json');
    let setStdout = '';
    let envPathStdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'set', 'plugins.foo.config.backend', 'local'],
        {
          stdout: collect((chunk) => {
            setStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(setStdout) as unknown).toMatchObject({
      configPath,
      envPath: join(seededStoreRoot, '.env')
    });
    expect(JSON.parse(readFileSync(configPath, 'utf8')) as unknown).toMatchObject({
      storeRoot: seededStoreRoot,
      plugins: {
        foo: {
          config: {
            backend: 'local'
          }
        }
      }
    });

    expect(
      await runRuntimeConfigCliFromArgs(['env-path'], {
        stdout: collect((chunk) => {
          envPathStdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {
          [runtimeConfigEnvVarName]: configPath
        }
      })
    ).toBe(0);

    expect(envPathStdout).toBe(`${join(seededStoreRoot, '.env')}\n`);
  });

  it('seeds relative explicit store roots as absolute paths', async () => {
    const cwdRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-cli-relative-store-cwd-')
    );
    const otherCwd = mkdtempSync(
      join(tmpdir(), 'project02-config-cli-relative-store-other-')
    );
    const relativeStoreRoot = 'runtime-store';
    const storeRoot = join(realpathSync.native(cwdRoot), relativeStoreRoot);
    const configPath = join(storeRoot, 'config.json');
    const previousCwd = process.cwd();
    let setStdout = '';
    let envPathStdout = '';

    try {
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(
          ['--store', relativeStoreRoot, 'set', 'plugins.foo.config.backend', 'local'],
          {
            stdout: collect((chunk) => {
              setStdout += chunk;
            }),
            stderr: collect(() => {})
          }
        )
      ).toBe(0);

      expect(JSON.parse(setStdout) as unknown).toMatchObject({
        configPath: join(relativeStoreRoot, 'config.json'),
        envPath: join(storeRoot, '.env')
      });
      expect(JSON.parse(readFileSync(configPath, 'utf8')) as unknown).toMatchObject({
        storeRoot,
        plugins: {
          foo: {
            config: {
              backend: 'local'
            }
          }
        }
      });

      process.chdir(otherCwd);

      expect(
        await runRuntimeConfigCliFromArgs(['--config', configPath, 'env-path'], {
          stdout: collect((chunk) => {
            envPathStdout += chunk;
          }),
          stderr: collect(() => {})
        })
      ).toBe(0);

      expect(envPathStdout).toBe(`${join(storeRoot, '.env')}\n`);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('seeds env-selected missing store-default configs with their store root', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-cli-env-store-seed-')
    );
    const seededStoreRoot = realpathSync.native(storeRoot);
    const configPath = defaultRuntimeConfigPath(storeRoot);
    let setStdout = '';
    let envPathStdout = '';

    expect(existsSync(configPath)).toBe(false);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['set', 'plugins.foo.config.backend', 'local'],
        {
          stdout: collect((chunk) => {
            setStdout += chunk;
          }),
          stderr: collect(() => {}),
          env: {
            [runtimeConfigEnvVarName]: configPath
          }
        }
      )
    ).toBe(0);

    expect(JSON.parse(setStdout) as unknown).toMatchObject({
      configPath,
      envPath: join(seededStoreRoot, '.env')
    });
    expect(JSON.parse(readFileSync(configPath, 'utf8')) as unknown).toMatchObject({
      storeRoot: seededStoreRoot,
      plugins: {
        foo: {
          config: {
            backend: 'local'
          }
        }
      }
    });

    const loaded = loadProject02RuntimeConfig({
      env: {
        [runtimeConfigEnvVarName]: configPath
      }
    });
    const resolved = resolveProject02RuntimeConfig({ loadedConfig: loaded });

    expect(resolved.storeRoot).toBe(seededStoreRoot);

    expect(
      await runRuntimeConfigCliFromArgs(['env-path'], {
        stdout: collect((chunk) => {
          envPathStdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {
          [runtimeConfigEnvVarName]: configPath
        }
      })
    ).toBe(0);

    expect(envPathStdout).toBe(`${join(seededStoreRoot, '.env')}\n`);
  });

  it.each([
    {
      label: 'explicit --config',
      args(configPath: string) {
        return ['--config', configPath, 'env-path'] as const;
      },
      env(configPath: string) {
        void configPath;
        return {};
      }
    },
    {
      label: 'PROJECT02_RUNTIME_CONFIG',
      args() {
        return ['env-path'] as const;
      },
      env(configPath: string) {
        return {
          [runtimeConfigEnvVarName]: configPath
        };
      }
    }
  ])(
    'infers env-path from a missing store-default config selected by $label',
    async (example) => {
      const storeRoot = mkdtempSync(
        join(tmpdir(), 'project02-config-cli-missing-env-path-store-')
      );
      const seededStoreRoot = realpathSync.native(storeRoot);
      const configPath = defaultRuntimeConfigPath(storeRoot);
      let stdout = '';
      let stderr = '';

      expect(existsSync(configPath)).toBe(false);

      expect(
        await runRuntimeConfigCliFromArgs(example.args(configPath), {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          }),
          env: example.env(configPath)
        })
      ).toBe(0);

      expect(stdout).toBe(`${join(seededStoreRoot, '.env')}\n`);
      expect(stderr).toBe('');
      expect(existsSync(configPath)).toBe(false);
    }
  );

  it('seeds cwd dotenv-selected missing store-default configs with their store root', async () => {
    const cwdRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-cli-dotenv-store-seed-')
    );
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-cli-dotenv-selected-store-')
    );
    const seededStoreRoot = realpathSync.native(storeRoot);
    const configPath = defaultRuntimeConfigPath(storeRoot);
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let setStdout = '';
    let envPathStdout = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${configPath}\n`,
      'utf8'
    );

    try {
      Reflect.deleteProperty(process.env, runtimeConfigEnvVarName);
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(
          ['set', 'plugins.foo.config.backend', 'local'],
          {
            stdout: collect((chunk) => {
              setStdout += chunk;
            }),
            stderr: collect(() => {})
          }
        )
      ).toBe(0);

      expect(JSON.parse(setStdout) as unknown).toMatchObject({
        configPath,
        envPath: join(seededStoreRoot, '.env')
      });
      expect(JSON.parse(readFileSync(configPath, 'utf8')) as unknown).toMatchObject({
        storeRoot: seededStoreRoot,
        plugins: {
          foo: {
            config: {
              backend: 'local'
            }
          }
        }
      });

      expect(
        await runRuntimeConfigCliFromArgs(['env-path'], {
          stdout: collect((chunk) => {
            envPathStdout += chunk;
          }),
          stderr: collect(() => {})
        })
      ).toBe(0);

      expect(envPathStdout).toBe(`${join(seededStoreRoot, '.env')}\n`);
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('keeps missing explicit non-default config bootstraps store-neutral', async () => {
    const configRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-cli-explicit-neutral-')
    );
    const configPath = join(configRoot, 'runtime.json');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'set', 'plugins.foo.config.backend', 'local'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(readFileSync(configPath, 'utf8')) as unknown).toEqual({
      version: runtimeConfigVersion,
      plugins: {
        foo: {
          config: {
            backend: 'local'
          }
        }
      }
    });
  });

  it('treats operands after -- as config values instead of location flags', async () => {
    const configRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-cli-delimiter-value-')
    );
    const configPath = join(configRoot, 'runtime.json');
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['set', 'plugins.foo.config.arg', '--', '--store'],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          }),
          env: {
            [runtimeConfigEnvVarName]: configPath
          }
        }
      )
    ).toBe(0);

    expect(stderr).toBe('');
    expect(JSON.parse(stdout) as unknown).toMatchObject({ configPath });
    expect(JSON.parse(readFileSync(configPath, 'utf8')) as unknown).toMatchObject({
      plugins: {
        foo: {
          config: {
            arg: '--store'
          }
        }
      }
    });
  });

  it('keeps location flags before -- while escaping later operands', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-cli-delimiter-store-')
    );
    const seededStoreRoot = realpathSync.native(storeRoot);
    const configPath = join(storeRoot, 'config.json');
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'set', 'plugins.foo.config.arg', '--', '--config'],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        }
      )
    ).toBe(0);

    expect(stderr).toBe('');
    expect(JSON.parse(stdout) as unknown).toMatchObject({ configPath });
    expect(JSON.parse(readFileSync(configPath, 'utf8')) as unknown).toMatchObject({
      storeRoot: seededStoreRoot,
      plugins: {
        foo: {
          config: {
            arg: '--config'
          }
        }
      }
    });
  });

  it('rejects location flags after runtime-config command operands have started', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-cli-late-location-store-')
    );
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['set', 'plugins.foo.config.prompt', 'hello', '--store', storeRoot],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        }
      )
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toBe('Error: set does not accept extra arguments.\n');
    expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
  });

  it.each([
    {
      label: 'explicit --config',
      args(configPath: string) {
        return [
          '--config',
          configPath,
          'set',
          'plugins.foo.config.backend',
          'remote'
        ] as const;
      },
      env(configPath: string) {
        void configPath;
        return {};
      }
    },
    {
      label: 'PROJECT02_RUNTIME_CONFIG',
      args() {
        return ['set', 'plugins.foo.config.backend', 'remote'] as const;
      },
      env(configPath: string) {
        return {
          [runtimeConfigEnvVarName]: configPath
        };
      }
    }
  ])('preserves symlinked config files for $label mutations', async (example) => {
    const configRoot = mkdtempSync(join(tmpdir(), 'project02-config-link-'));
    const targetPath = writeRuntimeConfig(join(configRoot, 'target.json'), {
      plugins: {
        foo: {
          config: {
            backend: 'local'
          }
        }
      }
    });
    const linkPath = join(configRoot, 'linked.json');
    let stdout = '';

    symlinkSync(targetPath, linkPath);

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

    expect(
      await runRuntimeConfigCliFromArgs(example.args(linkPath), {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        env: example.env(linkPath)
      })
    ).toBe(0);

    expect(JSON.parse(stdout) as unknown).toMatchObject({
      configPath: linkPath
    });
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(targetPath);
    expect(JSON.parse(readFileSync(targetPath, 'utf8')) as unknown).toMatchObject({
      plugins: {
        foo: {
          config: {
            backend: 'remote'
          }
        }
      }
    });
  });

  it.each([
    {
      label: 'explicit --config',
      args(configPath: string) {
        return [
          '--config',
          configPath,
          'set',
          'plugins.foo.config.backend',
          'remote'
        ] as const;
      },
      env(configPath: string) {
        void configPath;
        return {};
      }
    },
    {
      label: 'PROJECT02_RUNTIME_CONFIG',
      args() {
        return ['set', 'plugins.foo.config.backend', 'remote'] as const;
      },
      env(configPath: string) {
        return {
          [runtimeConfigEnvVarName]: configPath
        };
      }
    }
  ])(
    'bootstraps missing config through dangling symlink files for $label mutations',
    async (example) => {
      const configRoot = mkdtempSync(
        join(tmpdir(), 'project02-config-dangling-link-')
      );
      const targetName = 'target.json';
      const targetPath = join(configRoot, targetName);
      const linkPath = join(configRoot, 'linked.json');
      let stdout = '';

      symlinkSync(targetName, linkPath);

      expect(existsSync(linkPath)).toBe(false);
      expect(existsSync(targetPath)).toBe(false);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

      expect(
        await runRuntimeConfigCliFromArgs(example.args(linkPath), {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          env: example.env(linkPath)
        })
      ).toBe(0);

      expect(JSON.parse(stdout) as unknown).toMatchObject({
        configPath: linkPath
      });
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkPath)).toBe(targetName);
      expect(JSON.parse(readFileSync(targetPath, 'utf8')) as unknown).toEqual({
        version: runtimeConfigVersion,
        plugins: {
          foo: {
            config: {
              backend: 'remote'
            }
          }
        }
      });
    }
  );

  it.each([
    {
      label: 'explicit --config',
      args(configPath: string) {
        return [
          '--config',
          configPath,
          'set',
          'plugins.foo.config.backend',
          'remote'
        ] as const;
      },
      env(configPath: string) {
        void configPath;
        return {};
      }
    },
    {
      label: 'PROJECT02_RUNTIME_CONFIG',
      args() {
        return ['set', 'plugins.foo.config.backend', 'remote'] as const;
      },
      env(configPath: string) {
        return {
          [runtimeConfigEnvVarName]: configPath
        };
      }
    }
  ])(
    'bootstraps symlinked store-default configs from canonical target store roots for $label mutations',
    async (example) => {
      const targetStoreRoot = mkdtempSync(
        join(tmpdir(), 'project02-config-link-default-target-')
      );
      const linkStoreRoot = mkdtempSync(
        join(tmpdir(), 'project02-config-link-default-selected-')
      );
      const seededStoreRoot = realpathSync.native(targetStoreRoot);
      const targetConfigPath = defaultRuntimeConfigPath(targetStoreRoot);
      const linkConfigPath = defaultRuntimeConfigPath(linkStoreRoot);
      let stdout = '';

      symlinkSync(targetConfigPath, linkConfigPath);

      expect(existsSync(linkConfigPath)).toBe(false);
      expect(existsSync(targetConfigPath)).toBe(false);
      expect(lstatSync(linkConfigPath).isSymbolicLink()).toBe(true);

      expect(
        await runRuntimeConfigCliFromArgs(example.args(linkConfigPath), {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          env: example.env(linkConfigPath)
        })
      ).toBe(0);

      expect(JSON.parse(stdout) as unknown).toMatchObject({
        configPath: linkConfigPath,
        envPath: join(seededStoreRoot, '.env')
      });
      expect(lstatSync(linkConfigPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkConfigPath)).toBe(targetConfigPath);
      expect(JSON.parse(readFileSync(targetConfigPath, 'utf8')) as unknown).toEqual({
        version: runtimeConfigVersion,
        storeRoot: seededStoreRoot,
        plugins: {
          foo: {
            config: {
              backend: 'remote'
            }
          }
        }
      });
    }
  );

  it('writes secret env files under the configured store root', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'project02-config-file-'));
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-effective-store-'));
    const configPath = join(configRoot, 'runtime.json');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'set', 'storeRoot', storeRoot],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);
    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--config',
          configPath,
          'secret',
          'set',
          'mem0-local',
          'cloudApiKey',
          'MEM0_API_KEY'
        ],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { MEM0_API_KEY: 'stored-secret' }
        }
      )
    ).toBe(0);

    expect(readFileSync(join(storeRoot, '.env'), 'utf8')).toContain(
      'MEM0_API_KEY="stored-secret"'
    );
  });

  it.each(runtimeControlEnvVarNames)(
    'rejects reserved runtime control env var %s before creating secret files',
    async (envVar) => {
      const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-secret-reserved-'));
      let stdout = '';
      let stderr = '';

      expect(
        await runRuntimeConfigCliFromArgs(
          ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
          {
            stdout: collect((chunk) => {
              stdout += chunk;
            }),
            stderr: collect((chunk) => {
              stderr += chunk;
            }),
            env: { [envVar]: 'stored-secret' }
          }
        )
      ).toBe(1);

      expect(stdout).toBe('');
      expect(stderr).toContain(
        `Secret env var ${envVar} is reserved for Project02 runtime control`
      );
      expect(existsSync(join(storeRoot, '.env'))).toBe(false);
      expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
    }
  );

  it('rejects the role-model provider control env var without modifying existing secret files', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-secret-reserved-existing-')
    );
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'mem0-local': {
          config: {
            cloudApiKey: { $env: 'PROJECT02_EXISTING_SECRET' }
          }
        }
      }
    });
    const envPath = join(storeRoot, '.env');
    const originalConfig = readFileSync(configPath, 'utf8');
    const originalEnv = [
      '# keep existing env material',
      'PROJECT02_EXISTING_SECRET="keep-existing"',
      ''
    ].join('\n');
    let stdout = '';
    let stderr = '';

    writeFileSync(envPath, originalEnv, 'utf8');

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--store',
          storeRoot,
          'secret',
          'set',
          'mem0-local',
          'cloudApiKey',
          roleModelProviderEnvVarName
        ],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          }),
          env: { [roleModelProviderEnvVarName]: 'stored-secret' }
        }
      )
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain(
      `Secret env var ${roleModelProviderEnvVarName} is reserved for Project02 runtime control`
    );
    expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
    expect(readFileSync(envPath, 'utf8')).toBe(originalEnv);
  });

  it.each([
    {
      label: 'explicit --config',
      args(configPath: string) {
        return [
          '--config',
          configPath,
          'secret',
          'set',
          'mem0-local',
          'cloudApiKey',
          'MEM0_API_KEY'
        ] as const;
      },
      env(configPath: string) {
        void configPath;
        return { MEM0_API_KEY: 'stored-secret' };
      }
    },
    {
      label: 'PROJECT02_RUNTIME_CONFIG',
      args() {
        return [
          'secret',
          'set',
          'mem0-local',
          'cloudApiKey',
          'MEM0_API_KEY'
        ] as const;
      },
      env(configPath: string) {
        return {
          PROJECT02_RUNTIME_CONFIG: configPath,
          MEM0_API_KEY: 'stored-secret'
        };
      }
    }
  ])('rejects secret writes when $label aliases the runtime env path', async (example) => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-secret-alias-'));
    const configPath = writeRuntimeConfig(join(storeRoot, '.env'), { storeRoot });
    const originalConfig = readFileSync(configPath, 'utf8');
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(example.args(configPath), {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        env: example.env(configPath)
      })
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain(
      'selected config path and runtime env path resolve to the same file'
    );
    expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
    expect(readFileSync(configPath, 'utf8')).not.toContain('stored-secret');
  });

  it('rejects secret writes when a missing config path aliases the env path through a symlink parent', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-secret-link-store-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'project02-config-secret-link-config-'));
    const configParent = join(configRoot, 'linked-store');
    const configPath = join(configParent, '.env');
    const envPath = join(storeRoot, '.env');
    const existingPath = join(storeRoot, 'existing.txt');
    let stdout = '';
    let stderr = '';

    writeFileSync(existingPath, 'preserve existing file\n', 'utf8');
    symlinkSync(storeRoot, configParent, 'dir');

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(envPath)).toBe(false);

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--store',
          storeRoot,
          '--config',
          configPath,
          'secret',
          'set',
          'mem0-local',
          'cloudApiKey',
          'MEM0_API_KEY'
        ],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          }),
          env: { MEM0_API_KEY: 'stored-secret' }
        }
      )
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain(
      'selected config path and runtime env path resolve to the same file'
    );
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(envPath)).toBe(false);
    expect(readFileSync(existingPath, 'utf8')).toBe('preserve existing file\n');
  });

  it('rejects secret writes when a dangling config symlink targets the runtime env path', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-secret-dangling-link-store-')
    );
    const configRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-secret-dangling-link-config-')
    );
    const envPath = join(storeRoot, '.env');
    const configPath = join(configRoot, 'linked-env.json');
    let stdout = '';
    let stderr = '';

    symlinkSync(envPath, configPath);

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(envPath)).toBe(false);
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--store',
          storeRoot,
          '--config',
          configPath,
          'secret',
          'set',
          'mem0-local',
          'cloudApiKey',
          'MEM0_API_KEY'
        ],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          }),
          env: { MEM0_API_KEY: 'stored-secret' }
        }
      )
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain(
      'selected config path and runtime env path resolve to the same file'
    );
    expect(existsSync(envPath)).toBe(false);
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(configPath)).toBe(envPath);
  });

  it('reports config write failures without leaking raw filesystem exceptions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'project02-config-write-blocked-'));
    const blockedParent = join(root, 'not-a-directory');
    const configPath = join(blockedParent, 'runtime.json');
    let stdout = '';
    let stderr = '';

    writeFileSync(blockedParent, 'blocks recursive mkdir', 'utf8');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'set', 'storeRoot', 'next-store'],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        }
      )
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toBe(`Error: Could not write runtime config file at ${configPath}.\n`);
    expect(stderr).not.toContain('EEXIST');
  });

  it('reports env secret write failures and rolls back the config update', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'project02-config-env-blocked-'));
    const blockedStoreRoot = join(configRoot, 'not-a-directory');
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot: blockedStoreRoot
    });
    const originalConfig = readFileSync(configPath, 'utf8');
    let stdout = '';
    let stderr = '';

    writeFileSync(blockedStoreRoot, 'blocks recursive mkdir', 'utf8');

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--config',
          configPath,
          'secret',
          'set',
          'mem0-local',
          'cloudApiKey',
          'MEM0_API_KEY'
        ],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          }),
          env: { MEM0_API_KEY: 'stored-secret' }
        }
      )
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toBe(
      `Error: Could not write runtime config env file at ${join(blockedStoreRoot, '.env')}.\n`
    );
    expect(stderr).not.toContain('EEXIST');
    expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
  });

  it('preserves dangling config symlinks when secret env write rollback removes a created target', async () => {
    const configRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-env-blocked-dangling-link-')
    );
    const blockedStoreRoot = join(configRoot, 'not-a-directory');
    const canonicalBlockedStoreRoot = join(
      realpathSync.native(configRoot),
      'not-a-directory'
    );
    const targetName = 'target.json';
    const targetPath = join(configRoot, targetName);
    const configPath = join(configRoot, 'linked.json');
    let stdout = '';
    let stderr = '';

    writeFileSync(blockedStoreRoot, 'blocks recursive mkdir', 'utf8');
    symlinkSync(targetName, configPath);

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(targetPath)).toBe(false);
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--store',
          blockedStoreRoot,
          '--config',
          configPath,
          'secret',
          'set',
          'mem0-local',
          'cloudApiKey',
          'MEM0_API_KEY'
        ],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          }),
          env: { MEM0_API_KEY: 'stored-secret' }
        }
      )
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toBe(
      `Error: Could not write runtime config env file at ${join(canonicalBlockedStoreRoot, '.env')}.\n`
    );
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(targetPath)).toBe(false);
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(configPath)).toBe(targetName);
  });

  it('reports env secret read failures before writing config updates', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-env-read-blocked-'));
    const envPath = join(realpathSync.native(storeRoot), '.env');
    let stdout = '';
    let stderr = '';

    mkdirSync(envPath);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', 'MEM0_API_KEY'],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          }),
          env: { MEM0_API_KEY: 'stored-secret' }
        }
      )
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toBe(`Error: Could not read runtime config env file at ${envPath}.\n`);
    expect(stderr).not.toContain('EISDIR');
    expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
  });

  it('does not persist a new env secret when an explicit config write fails', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'project02-config-write-fail-'));
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-orphan-secret-'));
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot
    });
    const timestamp = 3448006099;
    const configTempPath = `${configPath}.${String(process.pid)}.${String(timestamp)}.tmp`;
    const originalConfig = readFileSync(configPath, 'utf8');
    const now = vi.spyOn(Date, 'now').mockReturnValue(timestamp);

    mkdirSync(configTempPath);

    try {
      expect(() =>
        applyRuntimeConfigMutation({
          configPath,
          operation: {
            kind: 'secret_set',
            pluginId: 'mem0-local',
            fieldName: 'cloudApiKey',
            envVar: 'MEM0_API_KEY',
            secretValue: 'stored-secret'
          }
        })
      ).toThrow();
    } finally {
      now.mockRestore();
    }

    expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
    expect(existsSync(join(storeRoot, '.env'))).toBe(false);
  });

  it('reports env paths from the post-mutation store root', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'project02-config-env-output-'));
    const initialStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-env-output-initial-')
    );
    const nextStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-env-output-next-')
    );
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot: initialStoreRoot
    });

    const setResult = applyRuntimeConfigMutation({
      configPath,
      operation: { kind: 'set', path: 'storeRoot', value: nextStoreRoot }
    });

    expect(setResult.config.storeRoot).toBe(nextStoreRoot);
    expect(setResult.envPath).toBe(join(nextStoreRoot, '.env'));

    const unsetResult = applyRuntimeConfigMutation({
      configPath,
      storeRoot: initialStoreRoot,
      operation: { kind: 'unset', path: 'storeRoot' }
    });

    expect(unsetResult.config.storeRoot).toBeUndefined();
    expect(unsetResult.envPath).toBe(join(initialStoreRoot, '.env'));
  });

  it('writes mutations to the normalized selected config path', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'project02-config-normalized-write-'));
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot: 'initial-store'
    });
    const paddedConfigPath = ' runtime.json ';
    const previousCwd = process.cwd();

    try {
      process.chdir(configRoot);

      const result = applyRuntimeConfigMutation({
        configPath: paddedConfigPath,
        operation: { kind: 'set', path: 'storeRoot', value: 'next-store' }
      });
      const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

      expect(result.configPath).toBe('runtime.json');
      expect(config).toMatchObject({ storeRoot: 'next-store' });
      expect(existsSync(join(configRoot, paddedConfigPath))).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('prints the explicit config path selected by --config', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'project02-config-path-'));
    const configPath = join(configRoot, 'runtime.json');
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'path'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(0);

    expect(stdout).toBe(`${configPath}\n`);
    expect(stderr).toBe('');
  });

  it('prints explicit location paths without reading unrelated cwd dotenv', async () => {
    const cwdRoot = mkdtempSync(join(tmpdir(), 'project02-config-path-cwd-env-'));
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-path-explicit-store-')
    );
    const configPath = join(
      mkdtempSync(join(tmpdir(), 'project02-config-path-explicit-config-')),
      'runtime.json'
    );
    const previousCwd = process.cwd();

    mkdirSync(join(cwdRoot, '.env'));

    try {
      process.chdir(cwdRoot);

      for (const example of [
        {
          args: ['--store', storeRoot, 'path'] as const,
          expected: defaultRuntimeConfigPath(storeRoot)
        },
        {
          args: ['--config', configPath, 'path'] as const,
          expected: configPath
        }
      ]) {
        let stdout = '';
        let stderr = '';

        expect(
          await runRuntimeConfigCliFromArgs(example.args, {
            stdout: collect((chunk) => {
              stdout += chunk;
            }),
            stderr: collect((chunk) => {
              stderr += chunk;
            })
          })
        ).toBe(0);

        expect(stdout).toBe(`${example.expected}\n`);
        expect(stderr).toBe('');
      }
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('prints the env-selected config path from PROJECT02_RUNTIME_CONFIG', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'project02-config-path-env-'));
    const configPath = join(configRoot, 'runtime.json');
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(['path'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        env: {
          PROJECT02_RUNTIME_CONFIG: configPath
        }
      })
    ).toBe(0);

    expect(stdout).toBe(`${configPath}\n`);
    expect(stderr).toBe('');
  });

  it('prints process-env-selected location paths without reading unreadable cwd dotenv', async () => {
    const cwdRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-process-env-cwd-dotenv-error-')
    );
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-process-env-selected-store-')
    );
    const configPath = writeRuntimeConfig(join(cwdRoot, 'runtime.json'), {
      storeRoot
    });
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];

    mkdirSync(join(cwdRoot, '.env'));

    try {
      process.env[runtimeConfigEnvVarName] = configPath;
      process.chdir(cwdRoot);

      for (const example of [
        {
          args: ['path'] as const,
          expected: configPath
        },
        {
          args: ['env-path'] as const,
          expected: join(storeRoot, '.env')
        }
      ]) {
        let stdout = '';
        let stderr = '';

        expect(
          await runRuntimeConfigCliFromArgs(example.args, {
            stdout: collect((chunk) => {
              stdout += chunk;
            }),
            stderr: collect((chunk) => {
              stderr += chunk;
            }),
            env: process.env
          })
        ).toBe(0);

        expect(stdout).toBe(`${example.expected}\n`);
        expect(stderr).toBe('');
      }
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('uses process-env-selected config for get and non-secret mutations before reading unreadable cwd dotenv', async () => {
    const cwdRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-process-env-cwd-dotenv-get-set-')
    );
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-process-env-get-set-store-')
    );
    const configRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-process-env-get-set-')
    );
    const configPath = writeRuntimeConfig(
      join(configRoot, 'runtime.json'),
      {
        storeRoot,
        plugins: {
          foo: {
            config: {
              backend: 'selected'
            }
          }
        }
      }
    );
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let getStdout = '';
    let getStderr = '';
    let setStdout = '';
    let setStderr = '';

    mkdirSync(join(cwdRoot, '.env'));

    try {
      process.env[runtimeConfigEnvVarName] = configPath;
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['get', 'plugins.foo.config.backend'], {
          stdout: collect((chunk) => {
            getStdout += chunk;
          }),
          stderr: collect((chunk) => {
            getStderr += chunk;
          })
        })
      ).toBe(0);
      expect(JSON.parse(getStdout) as unknown).toBe('selected');
      expect(getStderr).toBe('');

      expect(
        await runRuntimeConfigCliFromArgs(
          ['set', 'plugins.foo.config.backend', 'remote'],
          {
            stdout: collect((chunk) => {
              setStdout += chunk;
            }),
            stderr: collect((chunk) => {
              setStderr += chunk;
            })
          }
        )
      ).toBe(0);

      expect(JSON.parse(setStdout) as { readonly configPath: string }).toMatchObject({
        configPath,
        envPath: join(storeRoot, '.env')
      });
      expect(setStderr).toBe('');
      expect(JSON.parse(readFileSync(configPath, 'utf8')) as unknown).toMatchObject({
        plugins: {
          foo: {
            config: {
              backend: 'remote'
            }
          }
        }
      });
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('uses process-env-selected config for secret set before reading unreadable cwd dotenv when the secret is present', async () => {
    const cwdRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-process-env-cwd-dotenv-secret-')
    );
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-process-env-secret-store-')
    );
    const configRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-process-env-secret-config-')
    );
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot
    });
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    const envVar = 'PROJECT02_SECRET_PROCESS_ENV_SELECTED_3451627428';
    const previousEnvValue = process.env[envVar];
    const secretValue = 'from-process-env';
    let stdout = '';
    let stderr = '';

    mkdirSync(join(cwdRoot, '.env'));

    try {
      process.env[runtimeConfigEnvVarName] = configPath;
      process.env[envVar] = secretValue;
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(
          ['secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
          {
            stdout: collect((chunk) => {
              stdout += chunk;
            }),
            stderr: collect((chunk) => {
              stderr += chunk;
            })
          }
        )
      ).toBe(0);

      expect(stderr).toBe('');
      expect(JSON.parse(stdout) as { readonly configPath: string }).toMatchObject({
        configPath,
        envPath: join(storeRoot, '.env')
      });
      expect(JSON.parse(readFileSync(configPath, 'utf8')) as unknown).toMatchObject({
        plugins: {
          'mem0-local': {
            config: {
              cloudApiKey: { $env: envVar }
            }
          }
        }
      });
      expect(readFileSync(join(storeRoot, '.env'), 'utf8')).toBe(
        `${envVar}="${secretValue}"\n`
      );
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('uses cwd dotenv secret fallback for process-env-selected secret set when the secret is absent from process env', async () => {
    const cwdRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-process-env-secret-cwd-fallback-')
    );
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-process-env-secret-fallback-store-')
    );
    const configPath = writeRuntimeConfig(join(cwdRoot, 'runtime.json'), {
      storeRoot
    });
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    const envVar = 'PROJECT02_SECRET_CWD_FALLBACK_3451627428';
    const previousEnvValue = process.env[envVar];
    const secretValue = 'from-cwd-dotenv';
    let stdout = '';
    let stderr = '';

    writeFileSync(join(cwdRoot, '.env'), `${envVar}="${secretValue}"\n`, 'utf8');

    try {
      process.env[runtimeConfigEnvVarName] = configPath;
      Reflect.deleteProperty(process.env, envVar);
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(
          ['secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
          {
            stdout: collect((chunk) => {
              stdout += chunk;
            }),
            stderr: collect((chunk) => {
              stderr += chunk;
            })
          }
        )
      ).toBe(0);

      expect(stderr).toBe('');
      expect(JSON.parse(stdout) as { readonly configPath: string }).toMatchObject({
        configPath,
        envPath: join(storeRoot, '.env')
      });
      expect(readFileSync(join(storeRoot, '.env'), 'utf8')).toBe(
        `${envVar}="${secretValue}"\n`
      );
      expect(process.env[envVar]).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('uses explicit runtime locations for secret set before reading unreadable cwd dotenv when the secret is present', async () => {
    const cwdRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-explicit-cwd-dotenv-secret-')
    );
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-explicit-secret-store-')
    );
    const configStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-explicit-secret-config-store-')
    );
    const configPath = writeRuntimeConfig(
      join(
        mkdtempSync(join(tmpdir(), 'project02-config-explicit-secret-config-')),
        'runtime.json'
      ),
      { storeRoot: configStoreRoot }
    );
    const storeConfigPath = writeRuntimeConfig(defaultRuntimeConfigPath(storeRoot), {
      storeRoot
    });
    const previousCwd = process.cwd();
    const envVar = 'PROJECT02_SECRET_EXPLICIT_PRESENT_3451970615';
    const previousEnvValue = process.env[envVar];
    const secretValue = 'from-process-env';

    mkdirSync(join(cwdRoot, '.env'));

    try {
      process.env[envVar] = secretValue;
      process.chdir(cwdRoot);

      for (const example of [
        {
          args: ['--store', storeRoot] as const,
          configPath: storeConfigPath,
          envPath: join(storeRoot, '.env')
        },
        {
          args: ['--config', configPath] as const,
          configPath,
          envPath: join(configStoreRoot, '.env')
        }
      ]) {
        let stdout = '';
        let stderr = '';

        expect(
          await runRuntimeConfigCliFromArgs(
            [...example.args, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
            {
              stdout: collect((chunk) => {
                stdout += chunk;
              }),
              stderr: collect((chunk) => {
                stderr += chunk;
              })
            }
          )
        ).toBe(0);

        expect(stderr).toBe('');
        expect(JSON.parse(stdout) as { readonly configPath: string }).toMatchObject({
          configPath: example.configPath,
          envPath: example.envPath
        });
        expect(JSON.parse(readFileSync(example.configPath, 'utf8')) as unknown).toMatchObject({
          plugins: {
            'mem0-local': {
              config: {
                cloudApiKey: { $env: envVar }
              }
            }
          }
        });
        expect(readFileSync(example.envPath, 'utf8')).toBe(
          `${envVar}="${secretValue}"\n`
        );
      }
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('uses cwd dotenv secret fallback for explicit runtime locations when the secret is absent from process env', async () => {
    const cwdRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-explicit-secret-cwd-fallback-')
    );
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-explicit-secret-fallback-store-')
    );
    const configStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-explicit-secret-fallback-config-store-')
    );
    const configPath = writeRuntimeConfig(
      join(
        mkdtempSync(join(tmpdir(), 'project02-config-explicit-secret-fallback-config-')),
        'runtime.json'
      ),
      { storeRoot: configStoreRoot }
    );
    const storeConfigPath = writeRuntimeConfig(defaultRuntimeConfigPath(storeRoot), {
      storeRoot
    });
    const previousCwd = process.cwd();
    const envVar = 'PROJECT02_SECRET_EXPLICIT_CWD_FALLBACK_3451970615';
    const previousEnvValue = process.env[envVar];
    const secretValue = 'from-cwd-dotenv';

    writeFileSync(join(cwdRoot, '.env'), `${envVar}="${secretValue}"\n`, 'utf8');

    try {
      Reflect.deleteProperty(process.env, envVar);
      process.chdir(cwdRoot);

      for (const example of [
        {
          args: ['--store', storeRoot] as const,
          configPath: storeConfigPath,
          envPath: join(storeRoot, '.env')
        },
        {
          args: ['--config', configPath] as const,
          configPath,
          envPath: join(configStoreRoot, '.env')
        }
      ]) {
        let stdout = '';
        let stderr = '';

        expect(
          await runRuntimeConfigCliFromArgs(
            [...example.args, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
            {
              stdout: collect((chunk) => {
                stdout += chunk;
              }),
              stderr: collect((chunk) => {
                stderr += chunk;
              })
            }
          )
        ).toBe(0);

        expect(stderr).toBe('');
        expect(JSON.parse(stdout) as { readonly configPath: string }).toMatchObject({
          configPath: example.configPath,
          envPath: example.envPath
        });
        expect(readFileSync(example.envPath, 'utf8')).toBe(
          `${envVar}="${secretValue}"\n`
        );
      }

      expect(process.env[envVar]).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('uses cwd dotenv runtime config selectors for unflagged config reads and mutations', async () => {
    const cwdRoot = mkdtempSync(join(tmpdir(), 'project02-config-cli-cwd-env-'));
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-cli-cwd-store-'));
    const configPath = writeRuntimeConfig(join(cwdRoot, 'runtime.json'), {
      storeRoot,
      plugins: {
        foo: {
          config: {
            backend: 'local'
          }
        }
      }
    });
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let pathStdout = '';
    let envPathStdout = '';
    let getStdout = '';
    let setStdout = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${configPath}\n`,
      'utf8'
    );

    try {
      Reflect.deleteProperty(process.env, runtimeConfigEnvVarName);
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['path'], {
          stdout: collect((chunk) => {
            pathStdout += chunk;
          }),
          stderr: collect(() => {})
        })
      ).toBe(0);
      expect(pathStdout).toBe(`${configPath}\n`);

      expect(
        await runRuntimeConfigCliFromArgs(['env-path'], {
          stdout: collect((chunk) => {
            envPathStdout += chunk;
          }),
          stderr: collect(() => {})
        })
      ).toBe(0);
      expect(envPathStdout).toBe(`${join(storeRoot, '.env')}\n`);

      expect(
        await runRuntimeConfigCliFromArgs(['get', 'plugins.foo.config.backend'], {
          stdout: collect((chunk) => {
            getStdout += chunk;
          }),
          stderr: collect(() => {})
        })
      ).toBe(0);
      expect(JSON.parse(getStdout) as unknown).toBe('local');

      expect(
        await runRuntimeConfigCliFromArgs(
          ['set', 'plugins.foo.config.backend', 'remote'],
          {
            stdout: collect((chunk) => {
              setStdout += chunk;
            }),
            stderr: collect(() => {})
          }
        )
      ).toBe(0);

      const setOutput = JSON.parse(setStdout) as {
        readonly configPath: string;
        readonly envPath: string;
      };
      const afterSet: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

      expect(setOutput).toMatchObject({
        configPath,
        envPath: join(storeRoot, '.env')
      });
      expect(afterSet).toMatchObject({
        plugins: {
          foo: {
            config: {
              backend: 'remote'
            }
          }
        }
      });
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('keeps explicit config and store locations ahead of env runtime config selectors', async () => {
    const cwdRoot = mkdtempSync(join(tmpdir(), 'project02-config-cli-explicit-'));
    const dotenvStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-cli-dotenv-store-')
    );
    const processStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-cli-process-store-')
    );
    const explicitStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-cli-explicit-store-')
    );
    const selectedStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-cli-selected-store-')
    );
    const explicitNextStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-cli-explicit-next-')
    );
    const selectedNextStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-cli-selected-next-')
    );
    const dotenvConfigPath = writeRuntimeConfig(join(cwdRoot, 'dotenv.json'), {
      storeRoot: dotenvStoreRoot
    });
    const processConfigPath = writeRuntimeConfig(join(cwdRoot, 'process.json'), {
      storeRoot: processStoreRoot
    });
    const explicitConfigPath = writeRuntimeConfig(join(cwdRoot, 'explicit.json'), {
      storeRoot: explicitStoreRoot
    });
    const selectedConfigPath = join(selectedStoreRoot, 'config.json');
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let explicitGetStdout = '';
    let storePathStdout = '';
    let explicitSetStdout = '';
    let storeSetStdout = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${dotenvConfigPath}\n`,
      'utf8'
    );

    try {
      process.env[runtimeConfigEnvVarName] = processConfigPath;
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(
          ['--config', explicitConfigPath, 'get', 'storeRoot'],
          {
            stdout: collect((chunk) => {
              explicitGetStdout += chunk;
            }),
            stderr: collect(() => {})
          }
        )
      ).toBe(0);
      expect(JSON.parse(explicitGetStdout) as unknown).toBe(explicitStoreRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['--store', selectedStoreRoot, 'path'], {
          stdout: collect((chunk) => {
            storePathStdout += chunk;
          }),
          stderr: collect(() => {})
        })
      ).toBe(0);
      expect(storePathStdout).toBe(`${selectedConfigPath}\n`);

      expect(
        await runRuntimeConfigCliFromArgs(
          ['--config', explicitConfigPath, 'set', 'storeRoot', explicitNextStoreRoot],
          {
            stdout: collect((chunk) => {
              explicitSetStdout += chunk;
            }),
            stderr: collect(() => {})
          }
        )
      ).toBe(0);
      expect(JSON.parse(explicitSetStdout) as { readonly configPath: string }).toMatchObject({
        configPath: explicitConfigPath
      });

      expect(
        await runRuntimeConfigCliFromArgs(
          ['--store', selectedStoreRoot, 'set', 'storeRoot', selectedNextStoreRoot],
          {
            stdout: collect((chunk) => {
              storeSetStdout += chunk;
            }),
            stderr: collect(() => {})
          }
        )
      ).toBe(0);
      expect(JSON.parse(storeSetStdout) as { readonly configPath: string }).toMatchObject({
        configPath: selectedConfigPath
      });

      expect(JSON.parse(readFileSync(explicitConfigPath, 'utf8')) as unknown).toMatchObject(
        {
          storeRoot: explicitNextStoreRoot
        }
      );
      expect(JSON.parse(readFileSync(selectedConfigPath, 'utf8')) as unknown).toMatchObject(
        {
          storeRoot: selectedNextStoreRoot
        }
      );
      expect(JSON.parse(readFileSync(dotenvConfigPath, 'utf8')) as unknown).toMatchObject(
        {
          storeRoot: dotenvStoreRoot
        }
      );
      expect(JSON.parse(readFileSync(processConfigPath, 'utf8')) as unknown).toMatchObject(
        {
          storeRoot: processStoreRoot
        }
      );
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('keeps process env runtime config selectors ahead of cwd dotenv defaults', async () => {
    const cwdRoot = mkdtempSync(join(tmpdir(), 'project02-config-cli-process-env-'));
    const dotenvConfigPath = writeRuntimeConfig(join(cwdRoot, 'dotenv.json'), {
      storeRoot: 'dotenv-store'
    });
    const processConfigPath = writeRuntimeConfig(join(cwdRoot, 'process.json'), {
      storeRoot: 'process-store'
    });
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let stdout = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${dotenvConfigPath}\n`,
      'utf8'
    );

    try {
      process.env[runtimeConfigEnvVarName] = processConfigPath;
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['path'], {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {})
        })
      ).toBe(0);

      expect(stdout).toBe(`${processConfigPath}\n`);
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it.each([
    {
      args: ['--config', '   ', 'path'] as const,
      message: 'Local runtime store is missing required files.'
    },
    {
      args: ['--store', '   ', 'path'] as const,
      message: 'Local runtime store root must be non-empty.'
    }
  ])('reports invalid runtime location for %j without throwing', async (example) => {
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(example.args, {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toBe(`Error: ${example.message}\n`);
  });

  it('rejects extra set operands instead of truncating the configured value', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-set-extra-'));
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--store',
          storeRoot,
          'set',
          'plugins.foo.config.prompt',
          'hello',
          'world'
        ],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        }
      )
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toBe('Error: set does not accept extra arguments.\n');
    expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
  });

  it.each([
    {
      label: 'path',
      args: ['path', 'extra'] as const,
      message: 'path does not accept extra arguments.'
    },
    {
      label: 'env-path',
      args: ['env-path', 'extra'] as const,
      message: 'env-path does not accept extra arguments.'
    },
    {
      label: 'check',
      args: ['check', 'extra'] as const,
      message: 'check does not accept extra arguments.'
    },
    {
      label: 'get',
      args: ['get', 'storeRoot', 'extra'] as const,
      message: 'get does not accept extra arguments.'
    },
    {
      label: 'unset',
      args: ['unset', 'storeRoot', 'extra'] as const,
      message: 'unset does not accept extra arguments.'
    },
    {
      label: 'plugin enable',
      args: ['plugin', 'enable', 'foo', 'extra'] as const,
      message: 'plugin enable does not accept extra arguments.'
    },
    {
      label: 'plugin disable',
      args: ['plugin', 'disable', 'foo', 'extra'] as const,
      message: 'plugin disable does not accept extra arguments.'
    },
    {
      label: 'default-memory-provider',
      args: ['default-memory-provider', 'foo', 'extra'] as const,
      message: 'default-memory-provider does not accept extra arguments.'
    },
    {
      label: 'default-memory-provider unset',
      args: ['default-memory-provider', '--unset', 'extra'] as const,
      message: 'default-memory-provider does not accept extra arguments.'
    },
    {
      label: 'secret set',
      args: ['secret', 'set', 'foo', 'apiKey', 'PROJECT02_SECRET', 'extra'] as const,
      message:
        'secret set reads the secret from the named env var; do not pass the secret value as an argument.'
    }
  ])('rejects extra operands for $label', async (example) => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-extra-args-'));
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, ...example.args], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toBe(`Error: ${example.message}\n`);
  });

  it('prints env-path from the effective configured store root', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'project02-config-env-path-'));
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-env-store-'));
    const configPath = writeRuntimeConfig(join(configRoot, 'runtime.json'), {
      storeRoot
    });
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'env-path'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(0);

    expect(stdout).toBe(`${join(storeRoot, '.env')}\n`);
    expect(stderr).toBe('');
  });

  it('prints env-path from an inferred store-default config root', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-env-path-inferred-')
    );
    const seededStoreRoot = realpathSync.native(storeRoot);
    const configPath = writeRuntimeConfig(defaultRuntimeConfigPath(storeRoot), {});
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'env-path'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(0);

    expect(stdout).toBe(`${join(seededStoreRoot, '.env')}\n`);
    expect(stderr).toBe('');
  });

  it('keeps env-path explicit store behavior when no config exists', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-env-store-only-'));
    let stdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'env-path'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);

    expect(stdout).toBe(`${join(storeRoot, '.env')}\n`);
  });

  it('sets and unsets dotted plugin IDs through generic config paths', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-dotted-set-'));

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'set', 'plugins.memory.recall.config.backend', 'local'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    const afterSet = readFileSync(join(storeRoot, 'config.json'), 'utf8');

    expect(afterSet).toContain('"memory.recall"');
    expect(afterSet).toContain('"backend": "local"');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'unset', 'plugins.memory.recall.config.backend'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    const afterUnset = readFileSync(join(storeRoot, 'config.json'), 'utf8');

    expect(afterUnset).not.toContain('"memory.recall"');
    expect(afterUnset).not.toContain('"backend"');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'plugin', 'enable', 'memory.config'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'set', 'plugins.memory.config.config.backend', 'local'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    const afterConfigSegmentSet: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterConfigSegmentSet).toMatchObject({
      plugins: {
        'memory.config': {
          enabled: true,
          config: {
            backend: 'local'
          }
        }
      }
    });
    expect(JSON.stringify(afterConfigSegmentSet)).not.toContain('"config.backend"');
  });

  it('rejects exact wrapper mutation paths before fallback parsing', async () => {
    for (const example of [
      {
        exactPluginId: 'memory.enabled',
        args: ['set', 'plugins.memory.enabled', 'false']
      },
      {
        exactPluginId: 'memory.enabled',
        args: ['unset', 'plugins.memory.enabled']
      },
      {
        exactPluginId: 'memory.config.api',
        args: ['set', 'plugins.memory.config.api', 'remote']
      }
    ] as const) {
      const storeRoot = mkdtempSync(
        join(tmpdir(), 'project02-config-exact-wrapper-mutation-')
      );
      let stderr = '';

      expect(
        await runRuntimeConfigCliFromArgs(
          ['--store', storeRoot, 'plugin', 'enable', example.exactPluginId],
          {
            stdout: collect(() => {}),
            stderr: collect(() => {})
          }
        )
      ).toBe(0);

      expect(
        await runRuntimeConfigCliFromArgs(['--store', storeRoot, ...example.args], {
          stdout: collect(() => {}),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        })
      ).toBe(1);

      expect(stderr).toContain('Ambiguous runtime config plugin path');
      expect(stderr).toContain(example.args[1]);
      expect(stderr).toContain(example.exactPluginId);

      const configText = readFileSync(join(storeRoot, 'config.json'), 'utf8');
      const config: unknown = JSON.parse(configText);

      expect(config).toMatchObject({
        plugins: {
          [example.exactPluginId]: {
            enabled: true
          }
        }
      });
      expect(configText).not.toContain('"memory":');
    }
  });

  it('rejects exact legacy enabled plugin mutation paths before fallback parsing', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-exact-legacy-enabled-mutation-')
    );
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      storeRoot: realpathSync.native(storeRoot),
      enabledPlugins: ['memory.enabled']
    });
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'set', 'plugins.memory.enabled', 'false'],
        {
          stdout: collect(() => {}),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        }
      )
    ).toBe(1);

    expect(stderr).toContain('Ambiguous runtime config plugin path');
    expect(stderr).toContain('plugins.memory.enabled');
    expect(stderr).toContain('memory.enabled');

    const configText = readFileSync(configPath, 'utf8');
    const config: unknown = JSON.parse(configText);

    expect(config).toMatchObject({
      enabledPlugins: ['memory.enabled']
    });
    expect(configText).not.toContain('"memory":');
  });

  it('sets, gets, and unsets dotted plugin config field names', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-dotted-field-'));
    const seededStoreRoot = realpathSync.native(storeRoot);
    let stdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        [
          '--store',
          storeRoot,
          'set',
          'plugins.memory.config.api.endpoint',
          'local-endpoint'
        ],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    const afterSet: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterSet).toMatchObject({
      plugins: {
        memory: {
          config: {
            'api.endpoint': 'local-endpoint'
          }
        }
      }
    });
    expect(JSON.stringify(afterSet)).not.toContain('"memory.config.api"');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'get', 'plugins.memory.config.api.endpoint'],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);
    expect(JSON.parse(stdout) as unknown).toBe('local-endpoint');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'unset', 'plugins.memory.config.api.endpoint'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    const afterUnset: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterUnset).toEqual({
      version: runtimeConfigVersion,
      storeRoot: seededStoreRoot
    });
  });

  it('redacts dotted credential plugin config field names on get', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-dotted-credential-field-')
    );
    let stdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'set', 'plugins.memory.config.api.key', 'local-key'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    const afterSet: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterSet).toMatchObject({
      plugins: {
        memory: {
          config: {
            'api.key': 'local-key'
          }
        }
      }
    });

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'get', 'plugins.memory.config.api.key'],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);
    expect(JSON.parse(stdout) as unknown).toBe('[redacted]');
    expect(stdout).not.toContain('local-key');
  });

  it('sets, gets, and unsets plugin config fields containing config', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-config-field-'));
    const seededStoreRoot = realpathSync.native(storeRoot);
    const path = 'plugins.memory.config.api.config.key';
    let stdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'plugin', 'enable', 'memory'], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'set', path, 'local-key'], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    const afterSet: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterSet).toMatchObject({
      plugins: {
        memory: {
          enabled: true,
          config: {
            'api.config.key': 'local-key'
          }
        }
      }
    });
    expect(JSON.stringify(afterSet)).not.toContain('"memory.config.api"');

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'get', path], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);
    expect(JSON.parse(stdout) as unknown).toBe('local-key');

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'unset', path], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    const afterUnset: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterUnset).toMatchObject({
      version: runtimeConfigVersion,
      storeRoot: seededStoreRoot,
      plugins: {
        memory: {
          enabled: true
        }
      }
    });
  });

  it('rejects ambiguous first-time plugin config paths containing config segments', async () => {
    for (const path of [
      'plugins.memory.config.api.config.key',
      'plugins.memory.config.config.key',
      'plugins.memory.config.enabled'
    ]) {
      const storeRoot = mkdtempSync(
        join(tmpdir(), 'project02-config-ambiguous-config-')
      );
      let stderr = '';

      expect(
        await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'set', path, 'local-key'], {
          stdout: collect(() => {}),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        })
      ).toBe(1);

      expect(stderr).toContain('Ambiguous runtime config plugin path');
      expect(stderr).toContain(path);
      expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
    }
  });

  it('rejects ambiguous known plugin config paths instead of preferring dotted plugin ids', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-known-ambiguous-config-')
    );
    const path = 'plugins.memory.config.enabled';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'plugin', 'enable', 'memory'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);
    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'plugin', 'enable', 'memory.config'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'set', path, 'true'], {
        stdout: collect(() => {}),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(1);

    expect(stderr).toContain('Ambiguous runtime config plugin path');
    expect(stderr).toContain(path);
    expect(stderr).toContain('memory');
    expect(stderr).toContain('memory.config');

    const config: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(config).toMatchObject({
      plugins: {
        memory: {
          enabled: true
        },
        'memory.config': {
          enabled: true
        }
      }
    });
    expect(JSON.stringify(config)).not.toContain('"config":{"enabled"');
  });

  it('rejects ambiguous known plugin config paths on get', async () => {
    const configPath = writeRuntimeConfig(
      join(
        mkdtempSync(join(tmpdir(), 'project02-config-known-ambiguous-get-')),
        'config.json'
      ),
      {
        plugins: {
          memory: {
            enabled: true,
            config: {
              enabled: true
            }
          },
          'memory.config': {
            enabled: false
          }
        }
      }
    );
    const path = 'plugins.memory.config.enabled';
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'get', path], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain('Ambiguous runtime config plugin path');
    expect(stderr).toContain(path);
    expect(stderr).toContain('memory');
    expect(stderr).toContain('memory.config');
  });

  it('rejects exact-wrapper get paths that conflict with known plugin config fields', async () => {
    const path = 'plugins.memory.config.api';
    const configPath = writeRuntimeConfig(
      join(
        mkdtempSync(join(tmpdir(), 'project02-config-exact-wrapper-ambiguous-get-')),
        'config.json'
      ),
      {
        plugins: {
          memory: {
            config: {
              api: 'field-api'
            }
          },
          'memory.config.api': {
            enabled: true,
            config: {
              backend: 'wrapper-backend'
            }
          }
        }
      }
    );
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'get', path], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain('Ambiguous runtime config plugin path');
    expect(stderr).toContain(path);
    expect(stderr).toContain('memory');
    expect(stderr).toContain('memory.config.api');
  });

  it('sets, gets, unsets, and checks plugin config fields starting with config', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-leading-config-field-')
    );
    const seededStoreRoot = realpathSync.native(storeRoot);
    const path = 'plugins.memory.config.config.key';
    const plugin = requiredDottedConfigPlugin('memory', 'config.key');
    const factories = {
      memory: {
        manifest: plugin.manifest,
        create() {
          throw new Error('runtime-config check should not construct plugins');
        }
      }
    };
    let missingStdout = '';
    let getStdout = '';
    let passStdout = '';
    let afterUnsetStdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          missingStdout += chunk;
        }),
        stderr: collect(() => {}),
        factories
      })
    ).toBe(1);
    expect(missingStdout).toContain('runtime_config_required_value_missing');
    expect(missingStdout).toContain(path);

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'plugin', 'enable', 'memory'], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'set', path, 'local-key'], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    const afterSet: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterSet).toMatchObject({
      plugins: {
        memory: {
          enabled: true,
          config: {
            'config.key': 'local-key'
          }
        }
      }
    });
    expect(JSON.stringify(afterSet)).not.toContain('"memory.config"');

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          passStdout += chunk;
        }),
        stderr: collect(() => {}),
        factories
      })
    ).toBe(0);

    const passOutput = JSON.parse(passStdout) as {
      readonly activationDiagnostics: readonly { readonly code: string }[];
      readonly plugins: readonly {
        readonly pluginId: string;
        readonly activationStatus: string;
        readonly enabled: boolean;
      }[];
    };

    expect(passOutput.activationDiagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_required_value_missing'
    );
    expect(passOutput.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: 'memory',
        activationStatus: 'active',
        enabled: true
      })
    );

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'get', path], {
        stdout: collect((chunk) => {
          getStdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);
    expect(JSON.parse(getStdout) as unknown).toBe('local-key');

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'unset', path], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    const afterUnset: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterUnset).toEqual({
      version: runtimeConfigVersion,
      storeRoot: seededStoreRoot,
      plugins: {
        memory: {
          enabled: true
        }
      }
    });

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          afterUnsetStdout += chunk;
        }),
        stderr: collect(() => {}),
        factories
      })
    ).toBe(1);
    expect(afterUnsetStdout).toContain('runtime_config_required_value_missing');
    expect(afterUnsetStdout).toContain(path);
  });

  it('sets, gets, and unsets plugin IDs that contain config segments', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-plugin-config-id-'));
    const path = 'plugins.memory.config.api.config.key';
    let pluginStdout = '';
    let fieldStdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'plugin', 'enable', 'memory.config.api'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'set', path, 'local-key'], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    const afterSet: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterSet).toMatchObject({
      plugins: {
        'memory.config.api': {
          enabled: true,
          config: {
            key: 'local-key'
          }
        }
      }
    });
    expect(JSON.stringify(afterSet)).not.toContain('"memory":{"config"');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'get', 'plugins.memory.config.api'],
        {
          stdout: collect((chunk) => {
            pluginStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);
    expect(JSON.parse(pluginStdout) as unknown).toEqual({
      enabled: true,
      config: {
        key: 'local-key'
      }
    });

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'get', path], {
        stdout: collect((chunk) => {
          fieldStdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);
    expect(JSON.parse(fieldStdout) as unknown).toBe('local-key');

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'unset', path], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    const afterUnset: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterUnset).toMatchObject({
      plugins: {
        'memory.config.api': {
          enabled: true
        }
      }
    });
  });

  it('refuses to mutate malformed existing config files', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'project02-config-malformed-'));
    const configPath = join(configRoot, 'config.json');
    const malformedConfig = '{"version":';
    let stderr = '';

    writeFileSync(configPath, malformedConfig, 'utf8');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'set', 'storeRoot', 'next-store'],
        {
          stdout: collect(() => {}),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        }
      )
    ).toBe(1);

    expect(stderr).toContain('Cannot mutate runtime config because it failed to load');
    expect(stderr).toContain('Runtime config file is not valid JSON');
    expect(readFileSync(configPath, 'utf8')).toBe(malformedConfig);
  });

  it('refuses to write mutations that would fail runtime config validation', async () => {
    const emptyStoreRoot = mkdtempSync(join(tmpdir(), 'project02-config-invalid-set-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'project02-config-invalid-env-ref-'));
    const configPath = writeRuntimeConfig(join(configRoot, 'config.json'), {
      storeRoot: 'original-store'
    });
    const originalConfig = readFileSync(configPath, 'utf8');
    let enabledPluginsStderr = '';
    let envRefStderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', emptyStoreRoot, 'set', 'enabledPlugins', '[""]'],
        {
          stdout: collect(() => {}),
          stderr: collect((chunk) => {
            enabledPluginsStderr += chunk;
          })
        }
      )
    ).toBe(1);
    expect(enabledPluginsStderr).toContain(
      'Cannot mutate runtime config because the mutation would produce invalid config'
    );
    expect(enabledPluginsStderr).toContain('array of non-empty strings');
    expect(existsSync(join(emptyStoreRoot, 'config.json'))).toBe(false);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'set', 'plugins.foo.config.bar', '{"$env":""}'],
        {
          stdout: collect(() => {}),
          stderr: collect((chunk) => {
            envRefStderr += chunk;
          })
        }
      )
    ).toBe(1);
    expect(envRefStderr).toContain(
      'Cannot mutate runtime config because the mutation would produce invalid config'
    );
    expect(envRefStderr).toContain('Runtime config values must be JSON-compatible');
    expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
  });

  it('writes dotenv secrets so quotes and backslashes round-trip through env loading', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-secret-escaping-'));
    const envVar = 'PROJECT02_SECRET_ROUNDTRIP_QUOTES';
    const secretValue = String.raw`single' double" slash\ value`;

    Reflect.deleteProperty(process.env, envVar);
    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: secretValue }
        }
      )
    ).toBe(0);

    const envPath = join(storeRoot, '.env');

    expect(readFileSync(envPath, 'utf8')).toBe(`${envVar}=\`${secretValue}\`\n`);

    try {
      loadEnvFile(envPath);
      expect(process.env[envVar]).toBe(secretValue);
    } finally {
      Reflect.deleteProperty(process.env, envVar);
    }
  });

  it('writes backslash-only dotenv secrets with a non-escaping delimiter', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-secret-slashes-'));
    const envVar = 'PROJECT02_SECRET_ROUNDTRIP_SLASHES';
    const secretValue = String.raw`token\npart C:\Users\mira\AppData\Local\project02`;

    Reflect.deleteProperty(process.env, envVar);
    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: secretValue }
        }
      )
    ).toBe(0);

    const envPath = join(storeRoot, '.env');

    expect(readFileSync(envPath, 'utf8')).toBe(`${envVar}='${secretValue}'\n`);

    try {
      loadEnvFile(envPath);
      expect(process.env[envVar]).toBe(secretValue);
    } finally {
      Reflect.deleteProperty(process.env, envVar);
    }
  });

  it('rejects carriage-return dotenv secrets without changing config or env files', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-secret-crlf-'));
    const envVar = 'PROJECT02_SECRET_CRLF_PRIVATE_KEY';
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'mem0-local': {
          config: {
            cloudApiKey: { $env: 'PROJECT02_EXISTING_SECRET' }
          }
        }
      }
    });
    const envPath = join(storeRoot, '.env');
    const originalConfig = readFileSync(configPath, 'utf8');
    const originalEnv = [
      '# keep existing env material',
      'PROJECT02_EXISTING_SECRET="keep-existing"',
      ''
    ].join('\n');
    const secretValue = '-----BEGIN PRIVATE KEY-----\r\nsecret-line\r\n-----END PRIVATE KEY-----';
    let stdout = '';
    let stderr = '';

    writeFileSync(envPath, originalEnv, 'utf8');
    Reflect.deleteProperty(process.env, envVar);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          }),
          env: { [envVar]: secretValue }
        }
      )
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain('does not preserve carriage returns');
    expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
    expect(readFileSync(envPath, 'utf8')).toBe(originalEnv);
  });

  it('rejects unquoted dotenv fallback secrets that start with a quote delimiter', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-secret-quote-start-')
    );
    const envVar = 'PROJECT02_SECRET_QUOTE_START';
    const secretValue = `"starts-and-ends"with'single-and\`backtick`;
    let stdout = '';
    let stderr = '';

    Reflect.deleteProperty(process.env, envVar);
    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          }),
          env: { [envVar]: secretValue }
        }
      )
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain(
      'no non-escaping dotenv quote delimiter and cannot be safely written as an unquoted value'
    );
    expect(existsSync(join(storeRoot, '.env'))).toBe(false);
    expect(existsSync(join(storeRoot, 'config.json'))).toBe(false);
  });

  it('rotates multi-line dotenv secrets without leaving stale continuation lines', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-secret-rotate-'));
    const envVar = 'PROJECT02_SECRET_ROTATION_MULTILINE';
    const otherEnvVar = 'PROJECT02_SECRET_ROTATION_OTHER';
    const oldSecret = 'old first line\nold second line\nold third line';
    const newSecret = 'new first line\nnew second line';
    const envPath = join(storeRoot, '.env');

    Reflect.deleteProperty(process.env, envVar);
    Reflect.deleteProperty(process.env, otherEnvVar);
    writeFileSync(
      envPath,
      `# keep comment\n${otherEnvVar}="other-value"\n${envVar}="${oldSecret}"\n`,
      'utf8'
    );

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: newSecret }
        }
      )
    ).toBe(0);

    const envFile = readFileSync(envPath, 'utf8');

    expect(envFile).toContain('# keep comment');
    expect(envFile).toContain(`${otherEnvVar}="other-value"`);
    expect(envFile).toContain(`${envVar}="${newSecret}"`);
    expect(envFile).not.toContain('old first line');
    expect(envFile).not.toContain('old second line');
    expect(envFile).not.toContain('old third line');

    try {
      loadEnvFile(envPath);
      expect(process.env[envVar]).toBe(newSecret);
      expect(process.env[otherEnvVar]).toBe('other-value');
    } finally {
      Reflect.deleteProperty(process.env, envVar);
      Reflect.deleteProperty(process.env, otherEnvVar);
    }
  });

  it('preserves later dotenv entries when rotating an unclosed quoted secret', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-secret-unclosed-'));
    const envVar = 'PROJECT02_SECRET_ROTATION_UNCLOSED';
    const otherEnvVar = 'PROJECT02_SECRET_ROTATION_UNCLOSED_OTHER';
    const newSecret = 'new top-level secret';
    const envPath = join(storeRoot, '.env');

    Reflect.deleteProperty(process.env, envVar);
    Reflect.deleteProperty(process.env, otherEnvVar);
    writeFileSync(envPath, [`${envVar}='old`, `${otherEnvVar}=keep`, ''].join('\n'), 'utf8');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: newSecret }
        }
      )
    ).toBe(0);

    const envFile = readFileSync(envPath, 'utf8');

    expect(envFile).toBe(
      [`${otherEnvVar}=keep`, `${envVar}="${newSecret}"`, ''].join('\n')
    );

    try {
      loadEnvFile(envPath);
      expect(process.env[envVar]).toBe(newSecret);
      expect(process.env[otherEnvVar]).toBe('keep');
    } finally {
      Reflect.deleteProperty(process.env, envVar);
      Reflect.deleteProperty(process.env, otherEnvVar);
    }
  });

  it('preserves unrelated multiline dotenv blocks when rotating another secret', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-secret-rotate-unrelated-block-')
    );
    const envVar = 'PROJECT02_SECRET_ROTATION_API_KEY';
    const otherEnvVar = 'PROJECT02_SECRET_ROTATION_OTHER_BLOCK';
    const tailEnvVar = 'PROJECT02_SECRET_ROTATION_TAIL';
    const oldSecret = 'old top-level secret';
    const newSecret = 'new top-level secret';
    const preservedBlock = `${otherEnvVar}='first\n\n${envVar}=inside\nlast'`;
    const envPath = join(storeRoot, '.env');

    Reflect.deleteProperty(process.env, envVar);
    Reflect.deleteProperty(process.env, otherEnvVar);
    Reflect.deleteProperty(process.env, tailEnvVar);
    writeFileSync(
      envPath,
      [
        '# keep unrelated multiline block',
        preservedBlock,
        `${tailEnvVar}=visible-tail`,
        `${envVar}="${oldSecret}"`,
        ''
      ].join('\n'),
      'utf8'
    );

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: newSecret }
        }
      )
    ).toBe(0);

    const envFile = readFileSync(envPath, 'utf8');

    expect(envFile).toBe(
      [
        '# keep unrelated multiline block',
        preservedBlock,
        `${tailEnvVar}=visible-tail`,
        `${envVar}="${newSecret}"`,
        ''
      ].join('\n')
    );
    expect(envFile).not.toContain(oldSecret);

    try {
      loadEnvFile(envPath);
      expect(process.env[envVar]).toBe(newSecret);
      expect(process.env[otherEnvVar]).toBe(`first\n\n${envVar}=inside\nlast`);
      expect(process.env[tailEnvVar]).toBe('visible-tail');
    } finally {
      Reflect.deleteProperty(process.env, envVar);
      Reflect.deleteProperty(process.env, otherEnvVar);
      Reflect.deleteProperty(process.env, tailEnvVar);
    }
  });

  it('rotates exported dotenv secrets without preserving stale assignment blocks', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-secret-export-'));
    const envVar = 'PROJECT02_SECRET_ROTATION_EXPORTED';
    const otherEnvVar = 'PROJECT02_SECRET_ROTATION_EXPORTED_OTHER';
    const oldSecret = 'old exported first line\nold exported second line';
    const newSecret = 'new exported first line\nnew exported second line';
    const envPath = join(storeRoot, '.env');

    Reflect.deleteProperty(process.env, envVar);
    Reflect.deleteProperty(process.env, otherEnvVar);
    writeFileSync(
      envPath,
      [
        '# keep exported comment',
        `export ${envVar}=old-unquoted-exported`,
        `${otherEnvVar}="other-exported-value"`,
        `  export ${envVar}="${oldSecret}"`,
        ''
      ].join('\n'),
      'utf8'
    );

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'secret', 'set', 'mem0-local', 'cloudApiKey', envVar],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          env: { [envVar]: newSecret }
        }
      )
    ).toBe(0);

    const envFile = readFileSync(envPath, 'utf8');

    expect(envFile).toContain('# keep exported comment');
    expect(envFile).toContain(`${otherEnvVar}="other-exported-value"`);
    expect(envFile).toContain(`${envVar}="${newSecret}"`);
    expect(envFile).not.toContain(`export ${envVar}=`);
    expect(envFile).not.toContain(`export ${envVar}="`);
    expect(envFile).not.toContain('old-unquoted-exported');
    expect(envFile).not.toContain('old exported first line');
    expect(envFile).not.toContain('old exported second line');

    try {
      loadEnvFile(envPath);
      expect(process.env[envVar]).toBe(newSecret);
      expect(process.env[otherEnvVar]).toBe('other-exported-value');
    } finally {
      Reflect.deleteProperty(process.env, envVar);
      Reflect.deleteProperty(process.env, otherEnvVar);
    }
  });

  it('fails get when config loading reports errors', async () => {
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-invalid-get-')), 'config.json'),
      {
        storeRoot: 42
      }
    );
    let stdout = '';
    let stderr = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'get', 'storeRoot'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(1);

    expect(stdout).toBe('');
    expect(stderr).toContain('Runtime config field must be a non-empty string.');
  });

  it('gets dotted plugin ID config paths', async () => {
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-dotted-get-')), 'config.json'),
      {
        plugins: {
          'memory.recall': {
            config: {
              backend: 'local'
            }
          }
        }
      }
    );
    let stdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'plugins.memory.recall.config.backend'],
        {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(stdout) as unknown).toBe('local');
  });

  it('gets terminal plugin config objects for plain and dotted plugin IDs', async () => {
    const configPath = writeRuntimeConfig(
      join(
        mkdtempSync(join(tmpdir(), 'project02-config-object-get-')),
        'config.json'
      ),
      {
        plugins: {
          foo: {
            config: {
              backend: 'local',
              options: {
                mode: 'sync'
              }
            }
          },
          'memory.recall': {
            config: {
              backend: 'vector',
              topK: 5
            }
          }
        }
      }
    );
    let plainStdout = '';
    let dottedStdout = '';
    let pluginStdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'plugins.foo.config'],
        {
          stdout: collect((chunk) => {
            plainStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(plainStdout) as unknown).toEqual({
      backend: 'local',
      options: {
        mode: 'sync'
      }
    });

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'plugins.memory.recall.config'],
        {
          stdout: collect((chunk) => {
            dottedStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(dottedStdout) as unknown).toEqual({
      backend: 'vector',
      topK: 5
    });

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'get', 'plugins.foo'], {
        stdout: collect((chunk) => {
          pluginStdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);

    expect(JSON.parse(pluginStdout) as unknown).toEqual({
      config: {
        backend: 'local',
        options: {
          mode: 'sync'
        }
      }
    });
  });

  it('sets and unsets plugin config fields named enabled literally', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-enabled-field-'));
    const seededStoreRoot = realpathSync.native(storeRoot);

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'plugin', 'enable', 'memory'], {
        stdout: collect(() => {}),
        stderr: collect(() => {})
      })
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'set', 'plugins.memory.config.enabled', 'true'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    const afterSet: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterSet).toMatchObject({
      plugins: {
        memory: {
          enabled: true,
          config: {
            enabled: true
          }
        }
      }
    });
    expect(JSON.stringify(afterSet)).not.toContain('"memory.config"');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'unset', 'plugins.memory.config.enabled'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    const afterUnset: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterUnset).toEqual({
      version: runtimeConfigVersion,
      storeRoot: seededStoreRoot,
      plugins: {
        memory: {
          enabled: true
        }
      }
    });
  });

  it('drops empty plugin wrappers after unsetting the last plugin field', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-unset-empty-'));
    const seededStoreRoot = realpathSync.native(storeRoot);
    let enabledUnsetCheckStdout = '';
    let configUnsetCheckStdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'plugin', 'enable', 'typo'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'unset', 'plugins.typo.enabled'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(readFileSync(join(storeRoot, 'config.json'), 'utf8')) as unknown)
      .toEqual({ version: runtimeConfigVersion, storeRoot: seededStoreRoot });

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          enabledUnsetCheckStdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);
    expect(enabledUnsetCheckStdout).not.toContain('runtime_config_unknown_plugin');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'set', 'plugins.typo.config.backend', 'local'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'unset', 'plugins.typo.config.backend'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(readFileSync(join(storeRoot, 'config.json'), 'utf8')) as unknown)
      .toEqual({ version: runtimeConfigVersion, storeRoot: seededStoreRoot });

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          configUnsetCheckStdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);
    expect(configUnsetCheckStdout).not.toContain('runtime_config_unknown_plugin');
  });

  it('reports activation warnings from runtime config check', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-check-'));
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'unknown-plugin': {
          enabled: true
        }
      }
    });

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);
    expect(stdout).toContain('"activationDiagnostics"');
    expect(stdout).toContain('"runtime_config_unknown_plugin"');
  });

  it('reports check config load errors before runtime env file errors', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-check-load-error-before-env-')
    );
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      storeRoot: 42
    });
    mkdirSync(join(storeRoot, '.env'));

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      })
    ).toBe(1);

    const output = JSON.parse(stdout) as {
      readonly runtimeConfig: {
        readonly diagnostics: readonly {
          readonly code: string;
          readonly path?: string;
        }[];
      };
      readonly activationDiagnostics: readonly {
        readonly code: string;
        readonly path?: string;
      }[];
    };

    expect(stderr).toBe('');
    expect(output.runtimeConfig.diagnostics[0]).toMatchObject({
      code: 'runtime_config_string_invalid',
      path: 'storeRoot'
    });
    expect(output.activationDiagnostics[0]).toMatchObject({
      code: 'runtime_config_string_invalid',
      path: 'storeRoot'
    });
    expect(stdout).not.toContain('Could not load runtime config env file');
    expect(stderr).not.toContain('Could not load runtime config env file');
  });

  it('reports check activation config errors before runtime env file errors', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-check-activation-before-env-')
    );
    const plugin = requiredDottedConfigPlugin('memory.required-config', 'endpoint');
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true
        }
      }
    });
    mkdirSync(join(storeRoot, '.env'));

    expect(
      await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              throw new Error('runtime-config check should not construct plugins');
            }
          }
        }
      })
    ).toBe(1);

    const output = JSON.parse(stdout) as {
      readonly activationDiagnostics: readonly {
        readonly code: string;
        readonly path?: string;
      }[];
    };

    expect(stderr).toBe('');
    expect(output.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_value_missing',
          path: `plugins.${plugin.manifest.id}.config.endpoint`
        })
      ])
    );
    expect(stdout).not.toContain('Could not load runtime config env file');
  });

  it('reports explicit check config load errors before unrelated cwd dotenv errors', async () => {
    const cwdRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-check-cwd-dotenv-error-')
    );
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-check-selected-store-error-')
    );
    const configPath = join(
      mkdtempSync(join(tmpdir(), 'project02-config-check-selected-path-error-')),
      'runtime.json'
    );
    const previousCwd = process.cwd();

    writeRuntimeConfig(defaultRuntimeConfigPath(storeRoot), {
      storeRoot: 42
    });
    writeRuntimeConfig(configPath, {
      storeRoot: 42
    });
    mkdirSync(join(cwdRoot, '.env'));

    try {
      process.chdir(cwdRoot);

      for (const example of [
        ['--store', storeRoot, 'check'],
        ['--config', configPath, 'check']
      ] as const) {
        let stdout = '';
        let stderr = '';

        expect(
          await runRuntimeConfigCliFromArgs(example, {
            stdout: collect((chunk) => {
              stdout += chunk;
            }),
            stderr: collect((chunk) => {
              stderr += chunk;
            })
          })
        ).toBe(1);

        const output = JSON.parse(stdout) as {
          readonly runtimeConfig: {
            readonly diagnostics: readonly {
              readonly code: string;
              readonly path?: string;
            }[];
          };
          readonly activationDiagnostics: readonly {
            readonly code: string;
            readonly path?: string;
          }[];
        };

        expect(stderr).toBe('');
        expect(output.runtimeConfig.diagnostics[0]).toMatchObject({
          code: 'runtime_config_string_invalid',
          path: 'storeRoot'
        });
        expect(output.activationDiagnostics[0]).toMatchObject({
          code: 'runtime_config_string_invalid',
          path: 'storeRoot'
        });
        expect(stdout).not.toContain('Could not load .env file');
        expect(stderr).not.toContain('Could not load .env file');
      }
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('reports env-selected check config load errors before unrelated cwd dotenv errors', async () => {
    const cwdRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-check-env-cwd-dotenv-error-')
    );
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-check-env-selected-store-error-')
    );
    const configPath = defaultRuntimeConfigPath(storeRoot);
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(configPath, {
      storeRoot: 42
    });
    mkdirSync(join(cwdRoot, '.env'));

    try {
      process.env[runtimeConfigEnvVarName] = configPath;
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['check'], {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect((chunk) => {
            stderr += chunk;
          })
        })
      ).toBe(1);

      const output = JSON.parse(stdout) as {
        readonly runtimeConfig: {
          readonly diagnostics: readonly {
            readonly code: string;
            readonly path?: string;
          }[];
        };
        readonly activationDiagnostics: readonly {
          readonly code: string;
          readonly path?: string;
        }[];
      };

      expect(stderr).toBe('');
      expect(output.runtimeConfig.diagnostics[0]).toMatchObject({
        code: 'runtime_config_string_invalid',
        path: 'storeRoot'
      });
      expect(output.activationDiagnostics[0]).toMatchObject({
        code: 'runtime_config_string_invalid',
        path: 'storeRoot'
      });
      expect(stdout).not.toContain('Could not load .env file');
      expect(stderr).not.toContain('Could not load .env file');
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
    }
  });

  it('resolves check secrets from each runtime env file without leaking to later stores', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-check-env-'));
    const laterStoreRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-check-env-later-')
    );
    const envVar = 'PROJECT02_CHECK_ENV_FILE_SECRET_3447850555';
    const secretValue = 'from-runtime-env-file';
    const plugin = requiredSecretPlugin();
    let stdout = '';
    let laterStdout = '';
    let factoryCalls = 0;
    let laterFactoryCalls = 0;

    Reflect.deleteProperty(process.env, envVar);
    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });
    writeFileSync(join(storeRoot, '.env'), `${envVar}="${secretValue}"\n`, 'utf8');
    writeRuntimeConfig(join(laterStoreRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });

    try {
      expect(
        await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error('runtime-config check should not construct plugins');
              }
            }
          }
        })
      ).toBe(0);

      const output = JSON.parse(stdout) as {
        readonly activationDiagnostics: readonly { readonly code: string }[];
        readonly plugins: readonly {
          readonly pluginId: string;
          readonly activationStatus: string;
          readonly enabled: boolean;
        }[];
      };

      expect(factoryCalls).toBe(0);
      expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
        'runtime_config_required_secret_missing'
      );
      expect(output.plugins).toContainEqual(
        expect.objectContaining({
          pluginId: plugin.manifest.id,
          activationStatus: 'active',
          enabled: true
        })
      );
      expect(stdout).not.toContain(secretValue);
      expect(process.env[envVar]).toBeUndefined();

      expect(
        await runRuntimeConfigCliFromArgs(['--store', laterStoreRoot, 'check'], {
          stdout: collect((chunk) => {
            laterStdout += chunk;
          }),
          stderr: collect(() => {}),
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                laterFactoryCalls += 1;
                throw new Error('missing-secret check should not construct plugins');
              }
            }
          }
        })
      ).toBe(1);
      expect(laterFactoryCalls).toBe(0);
      expect(laterStdout).toContain('runtime_config_required_secret_missing');
      expect(laterStdout).not.toContain(secretValue);
    } finally {
      Reflect.deleteProperty(process.env, envVar);
    }
  });

  it('uses cwd dotenv defaults for unflagged runtime config check secrets', async () => {
    const cwdRoot = mkdtempSync(join(tmpdir(), 'project02-config-check-cwd-env-'));
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-check-cwd-store-'));
    const previousCwd = process.cwd();
    const previousRuntimeConfig = process.env[runtimeConfigEnvVarName];
    const envVar = 'PROJECT02_CHECK_CWD_DOTENV_SECRET_3449004103';
    const previousEnvValue = process.env[envVar];
    const secretValue = 'from-cwd-dotenv';
    const plugin = requiredSecretPlugin();
    let stdout = '';
    let factoryCalls = 0;

    Reflect.deleteProperty(process.env, envVar);
    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });
    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${join(storeRoot, 'config.json')}\n${envVar}="${secretValue}"\n`,
      'utf8'
    );

    try {
      Reflect.deleteProperty(process.env, runtimeConfigEnvVarName);
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['check'], {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error('runtime-config check should not construct plugins');
              }
            }
          }
        })
      ).toBe(0);

      const output = JSON.parse(stdout) as {
        readonly activationDiagnostics: readonly { readonly code: string }[];
        readonly plugins: readonly {
          readonly pluginId: string;
          readonly activationStatus: string;
          readonly enabled: boolean;
        }[];
      };

      expect(factoryCalls).toBe(0);
      expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
        'runtime_config_required_secret_missing'
      );
      expect(output.plugins).toContainEqual(
        expect.objectContaining({
          pluginId: plugin.manifest.id,
          activationStatus: 'active',
          enabled: true
        })
      );
      expect(stdout).not.toContain(secretValue);
      expect(process.env[envVar]).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(runtimeConfigEnvVarName, previousRuntimeConfig);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('does not use cwd dotenv secrets for explicit runtime config check locations', async () => {
    const cwdRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-check-explicit-cwd-env-')
    );
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-check-explicit-store-')
    );
    const configPath = join(storeRoot, 'config.json');
    const previousCwd = process.cwd();
    const envVar = 'PROJECT02_CHECK_EXPLICIT_CWD_DOTENV_SECRET_3450049746';
    const previousEnvValue = process.env[envVar];
    const plugin = requiredSecretPlugin();

    Reflect.deleteProperty(process.env, envVar);
    writeRuntimeConfig(configPath, {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });
    writeFileSync(join(cwdRoot, '.env'), `${envVar}="from-cwd-dotenv"\n`, 'utf8');

    try {
      process.chdir(cwdRoot);

      for (const args of [
        ['--store', storeRoot, 'check'],
        ['--config', configPath, 'check']
      ] as const) {
        let stdout = '';
        let factoryCalls = 0;

        expect(
          await runRuntimeConfigCliFromArgs(args, {
            stdout: collect((chunk) => {
              stdout += chunk;
            }),
            stderr: collect(() => {}),
            factories: {
              [plugin.manifest.id]: {
                manifest: plugin.manifest,
                create() {
                  factoryCalls += 1;
                  throw new Error('runtime-config check should not construct plugins');
                }
              }
            }
          })
        ).toBe(1);

        expect(factoryCalls).toBe(0);
        expect(stdout).toContain('runtime_config_required_secret_missing');
        expect(stdout).not.toContain('from-cwd-dotenv');
      }
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('keeps runtime env file values ahead of cwd dotenv defaults during check', async () => {
    const cwdRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-check-cwd-env-override-')
    );
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-check-store-env-override-')
    );
    const previousCwd = process.cwd();
    const envVar = 'PROJECT02_CHECK_STORE_OVER_CWD_SECRET_3449004103';
    const previousEnvValue = process.env[envVar];
    const secretValue = 'from-cwd-dotenv';
    const plugin = requiredSecretPlugin();
    let stdout = '';
    let factoryCalls = 0;

    Reflect.deleteProperty(process.env, envVar);
    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });
    writeFileSync(join(cwdRoot, '.env'), `${envVar}="${secretValue}"\n`, 'utf8');
    writeFileSync(join(storeRoot, '.env'), `${envVar}=\n`, 'utf8');

    try {
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error('runtime-config check should not construct plugins');
              }
            }
          }
        })
      ).toBe(1);

      expect(factoryCalls).toBe(0);
      expect(stdout).toContain('runtime_config_required_secret_missing');
      expect(stdout).not.toContain(secretValue);
      expect(process.env[envVar]).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('keeps process env values ahead of cwd dotenv defaults during check', async () => {
    const cwdRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-check-process-env-')
    );
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-check-process-store-')
    );
    const previousCwd = process.cwd();
    const envVar = 'PROJECT02_CHECK_PROCESS_OVER_CWD_SECRET_3449004103';
    const previousEnvValue = process.env[envVar];
    const secretValue = 'from-process-env';
    const plugin = requiredSecretPlugin();
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });
    writeFileSync(join(cwdRoot, '.env'), `${envVar}=\n`, 'utf8');

    try {
      process.env[envVar] = secretValue;
      process.chdir(cwdRoot);

      expect(
        await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error('runtime-config check should not construct plugins');
              }
            }
          }
        })
      ).toBe(0);

      const output = JSON.parse(stdout) as {
        readonly activationDiagnostics: readonly { readonly code: string }[];
        readonly plugins: readonly {
          readonly pluginId: string;
          readonly activationStatus: string;
          readonly enabled: boolean;
        }[];
      };

      expect(factoryCalls).toBe(0);
      expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
        'runtime_config_required_secret_missing'
      );
      expect(output.plugins).toContainEqual(
        expect.objectContaining({
          pluginId: plugin.manifest.id,
          activationStatus: 'active',
          enabled: true
        })
      );
      expect(stdout).not.toContain(secretValue);
    } finally {
      process.chdir(previousCwd);
      restoreProcessEnvValue(envVar, previousEnvValue);
    }
  });

  it('keeps supplied check env values ahead of runtime env file values', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-check-env-precedence-'));
    const envVar = 'PROJECT02_CHECK_SUPPLIED_ENV_SECRET_3447850555';
    const suppliedSecretValue = 'from-supplied-env';
    const plugin = requiredSecretPlugin();
    let stdout = '';
    let factoryCalls = 0;

    Reflect.deleteProperty(process.env, envVar);
    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });
    writeFileSync(join(storeRoot, '.env'), `${envVar}=\n`, 'utf8');

    try {
      expect(
        await runRuntimeConfigCliFromArgs(['--store', storeRoot, 'check'], {
          stdout: collect((chunk) => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
          env: { [envVar]: suppliedSecretValue },
          factories: {
            [plugin.manifest.id]: {
              manifest: plugin.manifest,
              create() {
                factoryCalls += 1;
                throw new Error('runtime-config check should not construct plugins');
              }
            }
          }
        })
      ).toBe(0);

      const output = JSON.parse(stdout) as {
        readonly activationDiagnostics: readonly { readonly code: string }[];
        readonly plugins: readonly {
          readonly pluginId: string;
          readonly activationStatus: string;
          readonly enabled: boolean;
        }[];
      };

      expect(factoryCalls).toBe(0);
      expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
        'runtime_config_required_secret_missing'
      );
      expect(output.plugins).toContainEqual(
        expect.objectContaining({
          pluginId: plugin.manifest.id,
          activationStatus: 'active',
          enabled: true
        })
      );
      expect(stdout).not.toContain(suppliedSecretValue);
    } finally {
      Reflect.deleteProperty(process.env, envVar);
    }
  });

  it('redacts get secrets while preserving non-secret values', async () => {
    const rawSecret = 'runtime-config-get-plaintext-secret';
    const rawLegacySecret = 'runtime-config-get-legacy-secret';
    const rawExactPluginSecret = 'runtime-config-get-exact-plugin-secret';
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-get-secret-')), 'config.json'),
      {
        plugins: {
          foo: {
            config: {
              apiKey: {
                $plaintextSecret: rawSecret,
                allowPlaintextSecret: true,
                justification: 'test-only plaintext override'
              },
              legacyApiKey: rawLegacySecret,
              backend: 'local'
            }
          },
          'memory.config.api': {
            enabled: true,
            config: {
              apiKey: rawExactPluginSecret,
              backend: 'remote'
            }
          }
        }
      }
    );
    let secretStdout = '';
    let legacySecretStdout = '';
    let backendStdout = '';
    let configStdout = '';
    let exactPluginStdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'plugins.foo.config.apiKey'],
        {
          stdout: collect((chunk) => {
            secretStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(secretStdout) as unknown).toBe('[redacted]');
    expect(secretStdout).not.toContain(rawSecret);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'plugins.foo.config.legacyApiKey'],
        {
          stdout: collect((chunk) => {
            legacySecretStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(legacySecretStdout) as unknown).toBe('[redacted]');
    expect(legacySecretStdout).not.toContain(rawLegacySecret);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'plugins.foo.config.backend'],
        {
          stdout: collect((chunk) => {
            backendStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(backendStdout) as unknown).toBe('local');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'plugins.foo.config'],
        {
          stdout: collect((chunk) => {
            configStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(configStdout) as unknown).toEqual({
      apiKey: '[redacted]',
      legacyApiKey: '[redacted]',
      backend: 'local'
    });
    expect(configStdout).not.toContain(rawSecret);
    expect(configStdout).not.toContain(rawLegacySecret);

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--config', configPath, 'get', 'plugins.memory.config.api'],
        {
          stdout: collect((chunk) => {
            exactPluginStdout += chunk;
          }),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    expect(JSON.parse(exactPluginStdout) as unknown).toEqual({
      enabled: true,
      config: {
        apiKey: '[redacted]',
        backend: 'remote'
      }
    });
    expect(exactPluginStdout).not.toContain(rawExactPluginSecret);
  });
});

function requiredSecretPlugin(id = 'memory.required') {
  return createRuntimePlugin({
    manifest: {
      id,
      displayName: 'Required Memory',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Test plugin with required secret config.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'project02'
      },
      declaredPlugins: ['plugin_discovery'],
      config: {
        fields: [
          {
            name: 'apiKey',
            description: 'API key.',
            required: true,
            secret: true,
            valueType: 'secret',
            redactionLabels: ['secret']
          }
        ]
      },
      localTrustLevel: 'trusted_adapter',
      runtimePolicy: {
        requiredForTurn: false,
        sideEffectLevel: 'runtime_read',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'degrade',
          afterTurnCommitted: 'log_failure',
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: true,
        reasons: ['test_required_secret']
      },
      requestedApis: []
    }
  });
}

function requiredSecretPluginWithManifestEnvVar(id: string, envVar: string) {
  const plugin = requiredSecretPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      config: {
        fields: plugin.manifest.config.fields.map((field) =>
          field.name === 'apiKey' ? { ...field, envVar } : field
        )
      }
    }
  });
}

function requiredDottedConfigPlugin(id = 'memory', fieldName = 'api.config.key') {
  const plugin = requiredSecretPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      description: 'Test plugin with required dotted config.',
      config: {
        fields: [
          {
            name: fieldName,
            description: 'Nested compatibility API key.',
            required: true,
            secret: false,
            valueType: 'string',
            redactionLabels: []
          }
        ]
      },
      activation: {
        defaultEnabled: true,
        reasons: ['test_required_dotted_config']
      }
    }
  });
}

function structuredConfigPlugin(id: string) {
  const plugin = requiredSecretPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      description: 'Test plugin with structured non-secret config.',
      config: {
        fields: [
          {
            name: 'settings',
            description: 'Structured settings.',
            required: true,
            secret: false,
            valueType: 'object',
            redactionLabels: []
          },
          {
            name: 'endpoints',
            description: 'Endpoint list.',
            required: true,
            secret: false,
            valueType: 'array',
            redactionLabels: []
          }
        ]
      },
      activation: {
        defaultEnabled: true,
        reasons: ['test_structured_config']
      }
    }
  });
}

function memoryProviderPlugin(id: string) {
  return createMemoryProviderRuntimePlugin({
    id,
    displayName: id,
    recall() {
      return Promise.resolve({ items: [] });
    }
  });
}

function writeRuntimeConfig(
  path: string,
  config: Readonly<Record<string, unknown>>
): string {
  writeFileSync(
    path,
    `${JSON.stringify({ version: runtimeConfigVersion, ...config }, null, 2)}\n`,
    'utf8'
  );
  return path;
}

function restoreProcessEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }

  process.env[name] = value;
}

function collect(write: (chunk: string) => void): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      write(String(chunk));
      callback();
    }
  });
}
