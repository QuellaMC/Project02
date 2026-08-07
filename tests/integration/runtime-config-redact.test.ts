import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';
import {
  writeRuntimeConfig,
  runtimeConfigSnapshotForTest,
  loadRuntimeConfigForTest,
} from '../support/runtime-config.ts';
import {collect} from '../support/streams.ts';

import {runRuntimeConfigCliFromArgs} from '../../src/cli/config/main.ts';
import {resolveProject02RuntimeConfig} from '../../src/runtime/config/index.ts';
import {
  createRuntimePlugin,
  runtimePluginContractVersion,
  type RuntimePluginManifest,
} from '../../src/plugins/index.ts';

describe('runtime config redaction', () => {
  it('redacts dotted credential field names in resolved config', () => {
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-dotted-redact-'),
        'config.json',
      ),
      {
        plugins: {
          'memory.dotted-redaction': {
            enabled: true,
            config: {
              'api.key': 'resolved-api-key-secret',
              'display.name': 'visible display name',
              metadata: {
                'cloud.api.key': 'nested-api-key-secret',
                'display.name': 'nested visible display name',
              },
            },
          },
        },
      },
    );

    const resolved = resolveProject02RuntimeConfig({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({configPath}),
      }),

      pluginManifests: [dottedConfigManifest()],
    });
    const redacted = resolved.redactedPluginConfigs['memory.dotted-redaction'];

    expect(redacted?.['api.key']).toMatchObject({
      secret: false,
      value: '[redacted]',
    });
    expect(redacted?.['display.name']).toMatchObject({
      secret: false,
      value: 'visible display name',
    });
    expect(redacted?.['metadata']?.value).toEqual({
      'cloud.api.key': '[redacted]',
      'display.name': 'nested visible display name',
    });
    expect(JSON.stringify(redacted)).not.toContain('resolved-api-key-secret');
    expect(JSON.stringify(redacted)).not.toContain('nested-api-key-secret');
  });

  it('redacts nested credential object paths in resolved config', () => {
    const configPath = writeRuntimeConfig(
      join(
        createTestTempRoot('project02-config-nested-redact-'),
        'config.json',
      ),
      {
        plugins: {
          'memory.dotted-redaction': {
            enabled: true,
            config: {
              metadata: {
                api: {
                  key: 'nested-api-key-secret',
                  url: 'visible-api-url',
                },
                ordinary: {
                  key: 'visible ordinary key',
                },
                providers: [
                  {
                    api: {
                      key: 'array-api-key-secret',
                      url: 'visible-array-api-url',
                    },
                    ordinary: {
                      key: 'visible array ordinary key',
                    },
                  },
                ],
              },
            },
          },
        },
      },
    );

    const resolved = resolveProject02RuntimeConfig({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({configPath}),
      }),

      pluginManifests: [dottedConfigManifest()],
    });
    const redacted = resolved.redactedPluginConfigs['memory.dotted-redaction'];

    expect(redacted?.['metadata']?.value).toEqual({
      api: {
        key: '[redacted]',
        url: 'visible-api-url',
      },
      ordinary: {
        key: 'visible ordinary key',
      },
      providers: [
        {
          api: {
            key: '[redacted]',
            url: 'visible-array-api-url',
          },
          ordinary: {
            key: 'visible array ordinary key',
          },
        },
      ],
    });
    expect(JSON.stringify(redacted)).not.toContain('nested-api-key-secret');
    expect(JSON.stringify(redacted)).not.toContain('array-api-key-secret');
  });

  it('fails closed for manifest-declared auth secrets on runtime-config get', async () => {
    const manifest = authSecretConfigManifest();
    const plugin = createRuntimePlugin({manifest});
    const plaintextSecret = 'plaintext-auth-secret';
    const configPath = writeRuntimeConfig(
      join(createTestTempRoot('project02-config-auth-get-'), 'config.json'),
      {
        plugins: {
          [manifest.id]: {
            config: {auth: plaintextSecret},
          },
        },
      },
    );
    let stdout = '';
    let stderr = '';

    const exitCode = await runRuntimeConfigCliFromArgs(
      ['--config', configPath, 'get', `plugins.${manifest.id}.config.auth`],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        factories: {
          [manifest.id]: {
            manifest,
            create: () => plugin,
          },
        },
      },
    );

    expect({
      exitCode,
      stdout,
      leakedSecret: `${stdout}${stderr}`.includes(plaintextSecret),
    }).toEqual({
      exitCode: 1,
      stdout: '',
      leakedSecret: false,
    });
  });
});

function authSecretConfigManifest(): RuntimePluginManifest {
  const base = dottedConfigManifest();

  return Object.freeze({
    ...base,
    id: 'memory.auth-secret',
    displayName: 'Auth Secret',
    description: 'Test manifest for a secret field outside name heuristics.',
    declaredPlugins: ['plugin_discovery'],
    config: {
      scope: 'global_with_character_overrides',
      fields: [
        {
          name: 'auth',
          description: 'Authentication material.',
          required: false,
          secret: true,
          valueType: 'secret',
          redactionLabels: ['secret'],
        },
      ],
    },
  } satisfies RuntimePluginManifest);
}

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
    },
    declaredPlugins: [],
    config: {
      scope: 'global_with_character_overrides',
      fields: [
        {
          name: 'api.key',
          description: 'Compatibility API key field.',
          required: false,
          secret: false,
          valueType: 'string',
          redactionLabels: [],
        },
        {
          name: 'display.name',
          description: 'Visible display name.',
          required: false,
          secret: false,
          valueType: 'string',
          redactionLabels: [],
        },
        {
          name: 'metadata',
          description: 'Structured metadata.',
          required: false,
          secret: false,
          valueType: 'object',
          redactionLabels: [],
        },
      ],
    },
    firstParty: false,
    runtimePolicy: {
      timeoutMs: 1000,
      redactionLabels: [],
      failureBehavior: {
        beforeRoleModelCall: 'degrade',
        handleToolCall: 'degrade',
        health: 'degrade',
      },
    },
    activation: {
      defaultEnabled: true,
      reasons: ['test_dotted_redaction'],
    },
    requestedAccess: {},
  } satisfies RuntimePluginManifest);
}
