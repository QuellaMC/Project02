import { describe, expect, it } from 'vitest';

import {
  createLocalRuntimeSessionPaths,
  decodeStorageSchemaMarker,
  decodeRawEventLogRecord,
  localRuntimeStorageSchemaVersion
} from '../src/runtime/storage/layout.ts';

describe('local storage plugin schema', () => {
  it('uses schema version 3 and no top-level character state path', () => {
    expect(localRuntimeStorageSchemaVersion).toBe(3);
    expect(createLocalRuntimeSessionPaths()).not.toHaveProperty(
      'characterStatePath'
    );
  });

  it('decodes MVP-006 schema 1 markers as a compatible local store', () => {
    expect(
      decodeStorageSchemaMarker(
        JSON.stringify({
          schemaVersion: 1,
          createdAt: '2026-06-04T00:00:00.000Z'
        })
      )
    ).toEqual({
      schemaVersion: 1,
      createdAt: '2026-06-04T00:00:00.000Z'
    });
  });

  it('decodes plugin tool call records', () => {
    expect(
      decodeRawEventLogRecord(
        JSON.stringify({
          eventId: 'evt_storage_tool',
          traceId: 'trace_storage_tool',
          createdAt: '2026-06-15T00:00:00.000Z',
          kind: 'tool_call_finished',
          eventType: 'USER_MESSAGE',
          toolCallId: 'round-1.1.character_state.patch',
          toolRound: 1,
          toolName: 'character_state.patch',
          toolPluginId: 'character-state',
          toolResult: {
            status: 'rejected',
            reason: 'invalid_state_value',
            message: 'Invalid value.',
            evidence: []
          }
        })
      )
    ).toMatchObject({
      kind: 'tool_call_finished',
      toolPluginId: 'character-state',
      toolResult: {
        status: 'rejected'
      }
    });
  });
});
