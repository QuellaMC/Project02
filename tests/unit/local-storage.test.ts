import {describe, expect, it} from 'vitest';

import type {CreateFileRuntimeLogStoreOptions} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {
  createLocalRuntimeSessionPaths,
  decodeStorageSchemaMarker,
  localRuntimeStorageSchemaVersion,
} from '../../src/runtime/storage/layout-contract.ts';
import {decodeRawEventLogRecord} from '../../src/runtime/storage/raw-event-codec.ts';

type FileRuntimeLogStoreRequiresCharacter =
  CreateFileRuntimeLogStoreOptions extends {
    readonly characterId: string;
  }
    ? true
    : false;

describe('local storage plugin schema', () => {
  it('requires a character at the bounded file log store boundary', () => {
    const requiresCharacter: FileRuntimeLogStoreRequiresCharacter = true;

    expect(requiresCharacter).toBe(true);
  });

  it('uses scoped schema version 12 and no top-level character state path', () => {
    expect(localRuntimeStorageSchemaVersion).toBe(12);
    expect(
      createLocalRuntimeSessionPaths({storeRoot: 'store'}),
    ).not.toHaveProperty('characterStatePath');
  });

  it('round-trips scoped schema markers and rejects pre-split versions', () => {
    expect(
      decodeStorageSchemaMarker(
        JSON.stringify({
          schemaVersion: localRuntimeStorageSchemaVersion,
          scope: 'character-data',
          characterId: 'mira',
          createdAt: '2026-06-04T00:00:00.000Z',
        }),
      ),
    ).toEqual({
      schemaVersion: localRuntimeStorageSchemaVersion,
      scope: 'character-data',
      characterId: 'mira',
      createdAt: '2026-06-04T00:00:00.000Z',
    });
    expect(
      decodeStorageSchemaMarker(
        JSON.stringify({
          schemaVersion: localRuntimeStorageSchemaVersion,
          scope: 'character-data',
          characterId: 'mira',
          createdAt: '2026-06-04T00:00:00.000Z',
          materializedCharacterPackageVersion: '2.3.4',
        }),
      ),
    ).toMatchObject({
      schemaVersion: localRuntimeStorageSchemaVersion,
      materializedCharacterPackageVersion: '2.3.4',
    });
    expect(
      decodeStorageSchemaMarker(
        JSON.stringify({
          schemaVersion: localRuntimeStorageSchemaVersion,
          scope: 'home',
          createdAt: '2026-06-04T00:00:00.000Z',
        }),
      ).scope,
    ).toBe('home');
    // Clean cut: pre-split single-store markers are not readable.
    expect(() =>
      decodeStorageSchemaMarker(
        JSON.stringify({
          schemaVersion: 3,
          createdAt: '2026-06-04T00:00:00.000Z',
        }),
      ),
    ).toThrow(expect.objectContaining({code: 'unsupported_schema_version'}));
    expect(() =>
      decodeStorageSchemaMarker(
        JSON.stringify({
          schemaVersion: localRuntimeStorageSchemaVersion,
          scope: 'other',
          createdAt: '2026-06-04T00:00:00.000Z',
        }),
      ),
    ).toThrow(expect.objectContaining({code: 'malformed_schema_marker'}));
  });

  it('classifies invalid stored character identities as malformed markers', () => {
    expect(() =>
      decodeStorageSchemaMarker(
        JSON.stringify({
          schemaVersion: localRuntimeStorageSchemaVersion,
          scope: 'character-data',
          characterId: '../mira',
          createdAt: '2026-06-04T00:00:00.000Z',
        }),
      ),
    ).toThrow(expect.objectContaining({code: 'malformed_schema_marker'}));
  });

  it('decodes plugin tool call records', () => {
    const record = decodeRawEventLogRecord(
      JSON.stringify({
        eventId: 'evt_storage_tool',
        traceId: 'trace_storage_tool',
        createdAt: '2026-06-15T00:00:00.000Z',
        kind: 'tool_call_finished',
        eventType: 'USER_MESSAGE',
        toolCallId: 'round-1.1.character_state.patch',
        round: 1,
        toolName: 'character_state.patch',
        toolPluginId: 'character-state',
        toolResult: {
          status: 'rejected',
          reason: 'invalid_state_value',
          message: 'Invalid value.',
          evidence: [],
        },
      }),
    );

    expect(record).toMatchObject({
      kind: 'tool_call_finished',
      toolPluginId: 'character-state',
      toolResult: {
        status: 'rejected',
      },
    });
    expect(record).not.toHaveProperty('dispatchedToHost');
  });

  it('decodes the optional host-dispatch signal on finished tool calls', () => {
    expect(
      decodeRawEventLogRecord(
        JSON.stringify({
          eventId: 'evt_storage_dispatched_tool',
          traceId: 'trace_storage_dispatched_tool',
          createdAt: '2026-06-15T00:00:00.000Z',
          kind: 'tool_call_finished',
          eventType: 'USER_MESSAGE',
          toolCallId: 'round-1.1.character_state.patch',
          dispatchedToHost: true,
          round: 1,
          toolName: 'character_state.patch',
          toolPluginId: 'character-state',
          toolResult: {
            status: 'rejected',
            reason: 'invalid_state_value',
            message: 'Invalid value.',
            evidence: [],
          },
        }),
      ),
    ).toMatchObject({
      kind: 'tool_call_finished',
      dispatchedToHost: true,
    });
  });

  it.each([
    ['event ID', {eventId: 'evt_other'}],
    ['trace ID', {traceId: 'trace_other'}],
    ['creation time', {createdAt: '2026-06-15T00:01:00.000Z'}],
    ['plugin ID', {pluginId: 'other-plugin'}],
  ])(
    'rejects persisted tool result evidence with a mismatched %s',
    (_field, mismatchedIdentity) => {
      const identity = {
        eventId: 'evt_storage_tool_identity',
        traceId: 'trace_storage_tool_identity',
        createdAt: '2026-06-15T00:00:00.000Z',
      } as const;

      expect(() =>
        decodeRawEventLogRecord(
          JSON.stringify({
            ...identity,
            kind: 'tool_call_finished',
            eventType: 'USER_MESSAGE',
            toolCallId: 'round-1.1.memory.search',
            round: 1,
            toolName: 'memory.search',
            toolPluginId: 'memory.fixture',
            toolResult: {
              status: 'accepted',
              output: {matches: []},
              evidence: [
                {
                  ...identity,
                  kind: 'runtime_plugin_evidence_snapshot',
                  pluginId: 'memory.fixture',
                  evidenceKind: 'tool_invocation',
                  status: 'accepted',
                  summary: 'Search completed.',
                  redactionLabels: [],
                  ...mismatchedIdentity,
                },
              ],
            },
          }),
        ),
      ).toThrow(
        expect.objectContaining({
          code: 'malformed_record',
        }),
      );
    },
  );

  it('rejects equal event and trace IDs in the raw event decoder', () => {
    expect(() =>
      decodeRawEventLogRecord(
        JSON.stringify({
          eventId: 'same-id',
          traceId: 'same-id',
          createdAt: '2026-06-15T00:00:00.000Z',
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE',
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'malformed_record',
      }),
    );
  });
});
