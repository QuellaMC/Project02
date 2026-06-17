import { describe, expect, it } from 'vitest';

import {
  createRuntimePluginContextItem,
  createRuntimePluginEvidenceSnapshot
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
