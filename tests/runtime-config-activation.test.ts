import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { runRuntimeConfigCliFromArgs } from '../src/cli/config.ts';
import { runtimeConfigVersion } from '../src/runtime/config/index.ts';
import {
  createRuntimePlugin,
  runtimePluginContractVersion
} from '../src/plugins/index.ts';

describe('runtime config activation diagnostics', () => {
  it('fails check for config-enabled legacy function factories without constructing them', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-legacy-unchecked-')
    );
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'legacy.required': {
          enabled: true
        }
      }
    });

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          'legacy.required': () => {
            factoryCalls += 1;
            throw new Error('runtime-config check must not construct legacy plugins');
          }
        }
      }
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'runtime_config_legacy_factory_unchecked',
          path: 'plugins.legacy.required.enabled',
          pluginId: 'legacy.required'
        })
      ])
    );
  });

  it('keeps explicitly disabled legacy function factories passing check', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-legacy-disabled-')
    );
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      enabledPlugins: ['legacy.required'],
      plugins: {
        'legacy.required': {
          enabled: false
        }
      }
    });

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          'legacy.required': () => {
            factoryCalls += 1;
            throw new Error('disabled legacy plugins must not be constructed');
          }
        }
      }
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_legacy_factory_unchecked'
    );
    expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_unknown_plugin'
    );
  });

  it('keeps manifest-backed factories eligible for non-instantiating checks', async () => {
    const storeRoot = mkdtempSync(
      join(tmpdir(), 'project02-config-manifest-backed-check-')
    );
    const envVar = 'PROJECT02_MANIFEST_BACKED_CHECK_SECRET_3448479333';
    const plugin = requiredSecretPlugin('legacy.required');
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'legacy.required': {
          enabled: true,
          config: {
            apiKey: { $env: envVar }
          }
        }
      }
    });

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--store', storeRoot, 'check'],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {
          [envVar]: 'manifest-backed-secret'
        },
        factories: {
          'legacy.required': {
            manifest: plugin.manifest,
            create() {
              factoryCalls += 1;
              throw new Error('runtime-config check must not construct factories');
            }
          }
        }
      }
    );
    const output = parseActivationOutput(stdout);

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics.map((item) => item.code)).not.toContain(
      'runtime_config_legacy_factory_unchecked'
    );
    expect(output.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: 'legacy.required',
        activationStatus: 'active',
        enabled: true
      })
    );
    expect(stdout).not.toContain('manifest-backed-secret');
  });
});

function requiredSecretPlugin(id: string) {
  return createRuntimePlugin({
    manifest: {
      id,
      displayName: 'Required Secret',
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

function parseActivationOutput(stdout: string): {
  readonly activationDiagnostics: readonly {
    readonly severity: string;
    readonly code: string;
    readonly path?: string;
    readonly pluginId?: string;
  }[];
  readonly plugins: readonly {
    readonly pluginId: string;
    readonly activationStatus: string;
    readonly enabled: boolean;
  }[];
} {
  return JSON.parse(stdout) as {
    readonly activationDiagnostics: readonly {
      readonly severity: string;
      readonly code: string;
      readonly path?: string;
      readonly pluginId?: string;
    }[];
    readonly plugins: readonly {
      readonly pluginId: string;
      readonly activationStatus: string;
      readonly enabled: boolean;
    }[];
  };
}
