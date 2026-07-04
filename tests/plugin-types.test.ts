import { describe, expect, it } from 'vitest';

import {
  createRuntimePlugin,
  createRuntimePluginManifest,
  createRuntimePluginContextItem,
  createRuntimePluginEvidenceSnapshot,
  minRuntimePluginApiAccess,
  requestedRuntimePluginApiAccess,
  runtimePluginApiAccessAllows,
  runtimePluginContractVersion
} from '../src/plugins/types.ts';

describe('runtime plugin source references', () => {
  it('accepts external source reference IDs that are not plugin identifiers', () => {
    const references = [
      {
        kind: 'memory',
        id: '1234567890',
        title: 'numeric database key'
      },
      {
        kind: 'resource',
        id: '1f4e2d3c-9a8b-4c7d-8123-abcdefabcdef',
        title: 'UUID beginning with a digit'
      },
      {
        kind: 'resource',
        id: 'resources/users/42/profile.json',
        title: 'path-like resource ID'
      }
    ] as const;

    const contextItem = createRuntimePluginContextItem({
      pluginId: 'memory.external_source.fixture',
      id: 'memory-context',
      kind: 'memory',
      text: 'Retrieved memory context.',
      budget: {
        estimatedTokens: 8,
        priority: 1
      },
      sourceReferences: references,
      redactionLabels: []
    });
    const evidence = createRuntimePluginEvidenceSnapshot({
      eventId: 'evt_external_source_reference',
      traceId: 'trace_external_source_reference',
      createdAt: '2026-06-16T00:00:00.000Z',
      kind: 'runtime_plugin_evidence_snapshot',
      pluginId: 'memory.external_source.fixture',
      evidenceKind: 'tool_invocation',
      status: 'accepted',
      summary: 'Memory search completed.',
      sourceReferences: references,
      redactionLabels: []
    });

    const expectedIds = [
      '1234567890',
      '1f4e2d3c-9a8b-4c7d-8123-abcdefabcdef',
      'resources/users/42/profile.json'
    ];

    expect(contextItem.sourceReferences.map((reference) => reference.id)).toEqual(
      expectedIds
    );
    expect(evidence.sourceReferences?.map((reference) => reference.id)).toEqual(
      expectedIds
    );
  });

  it('rejects empty source reference IDs', () => {
    for (const id of ['', '   ']) {
      expect(() =>
        createRuntimePluginContextItem({
          pluginId: 'memory.external_source.fixture',
          id: 'memory-context',
          kind: 'memory',
          text: 'Retrieved memory context.',
          budget: {
            estimatedTokens: 8,
            priority: 1
          },
          sourceReferences: [
            {
              kind: 'memory',
              id
            }
          ],
          redactionLabels: []
        })
      ).toThrow('Plugin field "id" must be a non-empty string.');

      expect(() =>
        createRuntimePluginEvidenceSnapshot({
          eventId: 'evt_external_source_reference',
          traceId: 'trace_external_source_reference',
          createdAt: '2026-06-16T00:00:00.000Z',
          kind: 'runtime_plugin_evidence_snapshot',
          pluginId: 'memory.external_source.fixture',
          evidenceKind: 'tool_invocation',
          status: 'accepted',
          summary: 'Memory search completed.',
          sourceReferences: [
            {
              kind: 'memory',
              id
            }
          ],
          redactionLabels: []
        })
      ).toThrow('Plugin field "id" must be a non-empty string.');
    }
  });
});

describe('runtime plugin API permissions', () => {
  it('defaults absent requestedApis to an empty permission object', () => {
    const manifest = createRuntimePluginManifest(runtimePluginManifestFixture());

    expect(manifest.requestedApis).toEqual({});
    expect(requestedRuntimePluginApiAccess(manifest.requestedApis, 'file_store')).toBe(
      'none'
    );
  });

  it('accepts requestedApis permission objects', () => {
    expect(
      createRuntimePluginManifest(
        runtimePluginManifestFixture({
          requestedApis: {}
        })
      ).requestedApis
    ).toEqual({});
    expect(
      createRuntimePluginManifest(
        runtimePluginManifestFixture({
          requestedApis: { file_store: 'read' }
        })
      ).requestedApis
    ).toEqual({ file_store: 'read' });
    expect(
      createRuntimePluginManifest(
        runtimePluginManifestFixture({
          requestedApis: {
            file_store: 'write',
            conversation_history: 'read'
          }
        })
      ).requestedApis
    ).toEqual({ file_store: 'write', conversation_history: 'read' });
  });

  it('rejects legacy arrays and malformed requestedApis values', () => {
    for (const requestedApis of [
      [],
      ['file_store'],
      { unknown_api: 'read' },
      { file_store: 'admin' },
      null,
      'file_store',
      true,
      1
    ]) {
      expect(() =>
        createRuntimePluginManifest(
          runtimePluginManifestFixture({
            requestedApis
          })
        )
      ).toThrow(/requestedApis/u);
    }
  });

  it('orders access levels for min and allow checks', () => {
    expect(runtimePluginApiAccessAllows('write', 'read')).toBe(true);
    expect(runtimePluginApiAccessAllows('read', 'write')).toBe(false);
    expect(runtimePluginApiAccessAllows('read', 'none')).toBe(true);
    expect(minRuntimePluginApiAccess('write', 'read')).toBe('read');
    expect(minRuntimePluginApiAccess('write', 'none')).toBe('none');
    expect(minRuntimePluginApiAccess('read', 'write')).toBe('read');
  });
});

describe('runtime plugin config metadata', () => {
  it('accepts optional config metadata fields without resolved config values', () => {
    const plugin = createRuntimePlugin({
      manifest: {
        id: 'metadata.fixture',
        displayName: 'Metadata Fixture',
        version: '1.0.0',
        kind: 'tool_provider',
        description: 'Config metadata fixture.',
        contractVersion: runtimePluginContractVersion,
        compatibility: {
          hostContractVersions: [runtimePluginContractVersion],
          sourceSystem: 'test'
        },
        declaredPlugins: ['plugin_discovery'],
        config: {
          fields: [
            {
              name: 'backend',
              description: 'Backend selection.',
              required: true,
              secret: false,
              valueType: 'enum',
              defaultValueSummary: 'local',
              allowedValues: ['local', 'cloud'],
              redactionLabels: [],
              configFingerprint: 'declared-backend-v1'
            },
            {
              name: 'apiKey',
              description: 'API key.',
              required: false,
              secret: true,
              valueType: 'secret',
              envVar: 'MEMORY_API_KEY',
              redactionLabels: ['secret']
            }
          ],
          fingerprint: 'declared-config-v1'
        },
        localTrustLevel: 'test_fixture',
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
          defaultEnabled: false,
          reasons: ['test']
        },
        requestedApis: {}
      }
    });

    expect(plugin.manifest.config.fields[0]).toMatchObject({
      name: 'backend',
      valueType: 'enum',
      allowedValues: ['local', 'cloud'],
      configFingerprint: 'declared-backend-v1'
    });
    expect(JSON.stringify(plugin.manifest)).not.toContain('resolvedConfig');
    expect(JSON.stringify(plugin.manifest)).not.toContain('MEMORY_API_KEY=');
  });
});

function runtimePluginManifestFixture(
  overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: 'api-permissions.fixture',
    displayName: 'API Permissions Fixture',
    version: '1.0.0',
    kind: 'tool_provider',
    description: 'API permissions fixture.',
    contractVersion: runtimePluginContractVersion,
    compatibility: {
      hostContractVersions: [runtimePluginContractVersion],
      sourceSystem: 'test'
    },
    declaredPlugins: ['plugin_discovery'],
    config: {
      fields: []
    },
    localTrustLevel: 'test_fixture',
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
      defaultEnabled: false,
      reasons: ['test']
    },
    ...overrides
  });
}
