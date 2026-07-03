import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { runRuntimeConfigCliFromArgs } from '../src/cli/config.ts';
import {
  loadProject02RuntimeConfig,
  resolveProject02RuntimeConfig,
  runtimeConfigVersion
} from '../src/runtime/config/index.ts';
import {
  runtimePluginContractVersion,
  type RuntimePluginManifest
} from '../src/plugins/index.ts';

describe('runtime config redaction', () => {
  it('redacts dotted credential field names in resolved config', () => {
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-dotted-redact-')), 'config.json'),
      {
        plugins: {
          'memory.dotted-redaction': {
            enabled: true,
            config: {
              'api.key': 'resolved-api-key-secret',
              'display.name': 'visible display name',
              metadata: {
                'cloud.api.key': 'nested-api-key-secret',
                'display.name': 'nested visible display name'
              }
            }
          }
        }
      }
    );

    const resolved = resolveProject02RuntimeConfig({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      pluginManifests: [dottedConfigManifest()]
    });
    const redacted = resolved.redactedPluginConfigs['memory.dotted-redaction'];

    expect(redacted?.['api.key']).toMatchObject({
      secret: false,
      value: '[redacted]'
    });
    expect(redacted?.['display.name']).toMatchObject({
      secret: false,
      value: 'visible display name'
    });
    expect(redacted?.['metadata']?.value).toEqual({
      'cloud.api.key': '[redacted]',
      'display.name': 'nested visible display name'
    });
    expect(JSON.stringify(redacted)).not.toContain('resolved-api-key-secret');
    expect(JSON.stringify(redacted)).not.toContain('nested-api-key-secret');
  });

  it('redacts nested credential object paths in resolved config', () => {
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-nested-redact-')), 'config.json'),
      {
        plugins: {
          'memory.dotted-redaction': {
            enabled: true,
            config: {
              metadata: {
                api: {
                  key: 'nested-api-key-secret',
                  url: 'visible-api-url'
                },
                ordinary: {
                  key: 'visible ordinary key'
                },
                providers: [
                  {
                    api: {
                      key: 'array-api-key-secret',
                      url: 'visible-array-api-url'
                    },
                    ordinary: {
                      key: 'visible array ordinary key'
                    }
                  }
                ]
              }
            }
          }
        }
      }
    );

    const resolved = resolveProject02RuntimeConfig({
      loadedConfig: loadProject02RuntimeConfig({ configPath }),
      pluginManifests: [dottedConfigManifest()]
    });
    const redacted = resolved.redactedPluginConfigs['memory.dotted-redaction'];

    expect(redacted?.['metadata']?.value).toEqual({
      api: {
        key: '[redacted]',
        url: 'visible-api-url'
      },
      ordinary: {
        key: 'visible ordinary key'
      },
      providers: [
        {
          api: {
            key: '[redacted]',
            url: 'visible-array-api-url'
          },
          ordinary: {
            key: 'visible array ordinary key'
          }
        }
      ]
    });
    expect(JSON.stringify(redacted)).not.toContain('nested-api-key-secret');
    expect(JSON.stringify(redacted)).not.toContain('array-api-key-secret');
  });

  it('redacts dotted credential keys from aggregate runtime-config get output', async () => {
    const configPath = writeRuntimeConfig(
      join(mkdtempSync(join(tmpdir(), 'project02-config-dotted-get-redact-')), 'config.json'),
      {
        plugins: {
          foo: {
            enabled: true,
            config: {
              'api.key': 'aggregate-api-key-secret',
              'display.name': 'visible aggregate display name',
              nested: {
                'api.key': 'nested-aggregate-api-key-secret',
                'display.name': 'nested visible aggregate display name'
              }
            }
          }
        }
      }
    );
    let stdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'get', 'plugins.foo'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);

    expect(JSON.parse(stdout) as unknown).toEqual({
      enabled: true,
      config: {
        'api.key': '[redacted]',
        'display.name': 'visible aggregate display name',
        nested: {
          'api.key': '[redacted]',
          'display.name': 'nested visible aggregate display name'
        }
      }
    });
    expect(stdout).not.toContain('aggregate-api-key-secret');
    expect(stdout).not.toContain('nested-aggregate-api-key-secret');
  });

  it('redacts nested credential object paths from aggregate runtime-config get output', async () => {
    const configPath = writeRuntimeConfig(
      join(
        mkdtempSync(join(tmpdir(), 'project02-config-nested-get-redact-')),
        'config.json'
      ),
      {
        plugins: {
          foo: {
            enabled: true,
            config: {
              settings: {
                api: {
                  key: 'aggregate-nested-api-key-secret',
                  url: 'visible aggregate api url'
                },
                ordinary: {
                  key: 'visible aggregate ordinary key'
                },
                providers: [
                  {
                    api: {
                      key: 'aggregate-array-api-key-secret',
                      url: 'visible aggregate array api url'
                    },
                    ordinary: {
                      key: 'visible aggregate array ordinary key'
                    }
                  }
                ]
              }
            }
          }
        }
      }
    );
    let stdout = '';

    expect(
      await runRuntimeConfigCliFromArgs(['--config', configPath, 'get', 'plugins.foo'], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {})
      })
    ).toBe(0);

    expect(JSON.parse(stdout) as unknown).toEqual({
      enabled: true,
      config: {
        settings: {
          api: {
            key: '[redacted]',
            url: 'visible aggregate api url'
          },
          ordinary: {
            key: 'visible aggregate ordinary key'
          },
          providers: [
            {
              api: {
                key: '[redacted]',
                url: 'visible aggregate array api url'
              },
              ordinary: {
                key: 'visible aggregate array ordinary key'
              }
            }
          ]
        }
      }
    });
    expect(stdout).not.toContain('aggregate-nested-api-key-secret');
    expect(stdout).not.toContain('aggregate-array-api-key-secret');
  });
});

function dottedConfigManifest(): RuntimePluginManifest {
  return Object.freeze({
    id: 'memory.dotted-redaction',
    displayName: 'Dotted Redaction',
    version: '1.0.0',
    kind: 'memory_provider',
    description: 'Test manifest for dotted config redaction.',
    contractVersion: runtimePluginContractVersion,
    compatibility: {
      hostContractVersions: [runtimePluginContractVersion],
      sourceSystem: 'project02'
    },
    declaredPlugins: [],
    config: {
      fields: [
        {
          name: 'api.key',
          description: 'Compatibility API key field.',
          required: false,
          secret: false,
          valueType: 'string',
          redactionLabels: []
        },
        {
          name: 'display.name',
          description: 'Visible display name.',
          required: false,
          secret: false,
          valueType: 'string',
          redactionLabels: []
        },
        {
          name: 'metadata',
          description: 'Structured metadata.',
          required: false,
          secret: false,
          valueType: 'object',
          redactionLabels: []
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
      reasons: ['test_dotted_redaction']
    },
    requestedApis: []
  } satisfies RuntimePluginManifest);
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
