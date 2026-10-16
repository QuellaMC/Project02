import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';
import {
  writeRuntimeConfig,
  runtimeConfigSnapshotForTest,
  loadRuntimeConfigForTest,
} from '../support/runtime-config.ts';
import {resolveLayeredProject02RuntimeConfig} from '../../src/runtime/config/index.ts';
import {
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

    const resolved = resolveLayeredProject02RuntimeConfig({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({configPath}),
      }),

      sections: {plugins: [dottedConfigManifest()], connectors: []},
    });
    const redacted =
      resolved.redactedSectionConfigs.plugins['memory.dotted-redaction'];

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

    const resolved = resolveLayeredProject02RuntimeConfig({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({configPath}),
      }),

      sections: {plugins: [dottedConfigManifest()], connectors: []},
    });
    const redacted =
      resolved.redactedSectionConfigs.plugins['memory.dotted-redaction'];

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
