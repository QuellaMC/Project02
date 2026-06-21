import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createConfiguredProject02PluginHost,
  loadProject02RuntimeConfig,
  resolveProject02RuntimeConfig,
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
            'config.json'
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
            'config.json'
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

  it('rejects unknown config fields for enabled or default-enabled plugins', async () => {
    const envVar = 'PROJECT02_UNKNOWN_FIELD_SECRET_3447705094';
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
        'memory.required': () => requiredSecretPlugin()
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
    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      factories: {
        'memory.required': () => requiredSecretPlugin()
      }
    });

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

  it('calls legacy function plugin factories once when creating a configured host', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-legacy-factory-'));
    let factoryCalls = 0;
    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ storeRoot }),
      factories: {
        'memory.required': () => {
          factoryCalls += 1;

          return requiredSecretPlugin();
        }
      }
    });

    expect(factoryCalls).toBe(1);
    expect(configured.plugins.map((plugin) => plugin.manifest.id)).toEqual([
      'memory.required'
    ]);
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
          'memory.required': () => requiredSecretPlugin()
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

  it('passes config-resolved store roots to legacy function plugin factories', async () => {
    const cliStoreRoot = mkdtempSync(join(tmpdir(), 'project02-config-cli-root-'));
    const configuredStoreRoot = mkdtempSync(join(tmpdir(), 'project02-config-file-root-'));
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-legacy-root-')), 'config.json'),
      {
        storeRoot: configuredStoreRoot
      }
    );
    let legacyFactoryStoreRoot: string | undefined;

    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      storeRoot: cliStoreRoot,
      factories: {
        'memory.required': (input) => {
          legacyFactoryStoreRoot = input.storeRoot;

          return requiredSecretPlugin();
        }
      }
    });

    expect(legacyFactoryStoreRoot).toBe(configuredStoreRoot);
    expect(configured.resolvedConfig.storeRoot).toBe(configuredStoreRoot);
  });

  it('blocks automatic memory activation when multiple providers are enabled without a default', async () => {
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-memory-ambiguous-')), 'config.json'),
      {
        plugins: {
          'memory.one': {
            enabled: true
          },
          'memory.two': {
            enabled: true
          }
        }
      }
    );
    const configured = await createConfiguredProject02PluginHost({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      factories: {
        'memory.one': () => memoryProviderPlugin('memory.one'),
        'memory.two': () => memoryProviderPlugin('memory.two')
      }
    });

    expect(configured.activation.enabledPluginIds).toEqual([]);
    expect(configured.activation.diagnostics.map((item) => item.code)).toContain(
      'ambiguous_memory_provider_selection'
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

    expect(afterUnset).toContain('"memory.recall"');
    expect(afterUnset).not.toContain('"backend"');

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
          config: {
            backend: 'local'
          }
        }
      }
    });
    expect(JSON.stringify(afterConfigSegmentSet)).not.toContain('"config.backend"');
  });

  it('sets, gets, and unsets dotted plugin config field names', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-dotted-field-'));
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
    expect(JSON.stringify(afterSet)).not.toContain('"memory.config.api"');

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
    expect(JSON.parse(stdout) as unknown).toBe('local-key');

    expect(
      await runRuntimeConfigCliFromArgs(
        ['--store', storeRoot, 'unset', 'plugins.memory.config.api.key'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {})
        }
      )
    ).toBe(0);

    const afterUnset: unknown = JSON.parse(
      readFileSync(join(storeRoot, 'config.json'), 'utf8')
    );

    expect(afterUnset).toMatchObject({
      plugins: {
        memory: {
          config: {}
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

  it('sets and unsets plugin config fields named enabled literally', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-config-enabled-field-'));

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

    expect(afterUnset).toMatchObject({
      plugins: {
        memory: {
          config: {}
        }
      }
    });
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

function collect(write: (chunk: string) => void): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      write(String(chunk));
      callback();
    }
  });
}
