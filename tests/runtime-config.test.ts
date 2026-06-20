import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
            enabled: false
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
    expect(configured.activation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_secret_missing'
        })
      ])
    );
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

function requiredSecretPlugin() {
  return createRuntimePlugin({
    manifest: {
      id: 'memory.required',
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
