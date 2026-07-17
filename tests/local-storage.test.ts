import { describe, expect, it } from 'vitest';

import {
  createLocalRuntimeSessionPaths,
  decodeStorageSchemaMarker,
  localRuntimeStorageSchemaVersion
} from '../src/runtime/storage/layout-contract.ts';
import { decodeConversationLogRecord } from '../src/runtime/storage/conversation-codec.ts';
import { decodeRawEventLogRecord } from '../src/runtime/storage/raw-event-codec.ts';
import { decodeRuntimeTraceEntry } from '../src/runtime/storage/trace-codec.ts';

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
    const record = decodeRawEventLogRecord(
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
    );

    expect(record).toMatchObject({
      kind: 'tool_call_finished',
      toolPluginId: 'character-state',
      toolResult: {
        status: 'rejected'
      }
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
      dispatchedToHost: true
    });
  });

  it.each([
    ['event ID', { eventId: 'evt_other' }],
    ['trace ID', { traceId: 'trace_other' }],
    ['creation time', { createdAt: '2026-06-15T00:01:00.000Z' }],
    ['plugin ID', { pluginId: 'other-plugin' }]
  ])(
    'rejects persisted tool result evidence with a mismatched %s',
    (_field, mismatchedIdentity) => {
      const identity = {
        eventId: 'evt_storage_tool_identity',
        traceId: 'trace_storage_tool_identity',
        createdAt: '2026-06-15T00:00:00.000Z'
      } as const;

      expect(() =>
        decodeRawEventLogRecord(
          JSON.stringify({
            ...identity,
            kind: 'tool_call_finished',
            eventType: 'USER_MESSAGE',
            toolCallId: 'round-1.1.memory.search',
            toolRound: 1,
            toolName: 'memory.search',
            toolPluginId: 'memory.fixture',
            toolResult: {
              status: 'accepted',
              output: { matches: [] },
              evidence: [
                {
                  ...identity,
                  kind: 'runtime_plugin_evidence_snapshot',
                  pluginId: 'memory.fixture',
                  evidenceKind: 'tool_invocation',
                  status: 'accepted',
                  summary: 'Search completed.',
                  redactionLabels: [],
                  ...mismatchedIdentity
                }
              ]
            }
          })
        )
      ).toThrow(
        expect.objectContaining({
          code: 'malformed_record'
        })
      );
    }
  );

  it.each([
    [
      'trace',
      () =>
        decodeRuntimeTraceEntry(
          JSON.stringify({
            eventId: 'same-id',
            traceId: 'same-id',
            createdAt: '2026-06-15T00:00:00.000Z',
            step: 'runtime_event_received'
          })
        )
    ],
    [
      'conversation',
      () =>
        decodeConversationLogRecord(
          JSON.stringify({
            eventId: 'same-id',
            traceId: 'same-id',
            createdAt: '2026-06-15T00:00:00.000Z',
            id: 'session:message-1',
            role: 'user',
            speakerId: 'local-user',
            speakerName: 'You',
            text: 'Hello',
            committedAt: '2026-06-15T00:00:01.000Z'
          })
        )
    ],
    [
      'raw event',
      () =>
        decodeRawEventLogRecord(
          JSON.stringify({
            eventId: 'same-id',
            traceId: 'same-id',
            createdAt: '2026-06-15T00:00:00.000Z',
            kind: 'runtime_event_received',
            eventType: 'USER_MESSAGE'
          })
        )
    ]
  ])('rejects equal event and trace IDs in the %s decoder', (_name, decode) => {
    expect(decode).toThrow(
      expect.objectContaining({
        code: 'malformed_record'
      })
    );
  });

  it('rejects trace entries with an unknown step', () => {
    expect(() =>
      decodeRuntimeTraceEntry(
        JSON.stringify({
          eventId: 'evt_unknown_trace_step',
          traceId: 'trace_unknown_trace_step',
          createdAt: '2026-06-15T00:00:00.000Z',
          step: 'unknown_step'
        })
      )
    ).toThrow(
      expect.objectContaining({
        code: 'malformed_record'
      })
    );
  });
});
