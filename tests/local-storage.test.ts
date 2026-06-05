import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createLocalRuntimeSessionMetadata,
  createLocalRuntimeSessionPaths,
  createLocalRuntimeStorageLayout,
  createLocalRuntimeStorageSchemaMarker,
  decodeConversationLogRecord,
  decodeRawEventLogRecord,
  decodeRuntimeTraceEntry,
  decodeStorageSchemaMarker,
  defaultLocalRuntimeSessionId,
  defaultLocalRuntimeStoreRoot,
  encodeConversationLogRecord,
  encodeRawEventLogRecord,
  encodeRuntimeTraceEntry,
  encodeStorageSchemaMarker,
  LocalRuntimeStorageContractError,
  localRuntimeStorageSchemaVersion,
  normalizeLocalRuntimeSessionId,
  type ConversationLogRecord,
  type LocalRuntimeStorageContractErrorCode,
  type RawEventLogRecord,
  type RuntimeTraceEntry
} from '../src/index.ts';

const createdAt = '2026-06-04T00:00:00.000Z';

describe('local runtime storage contract', () => {
  it('defines shared typed errors for downstream local storage boundaries', () => {
    const errorCodes = [
      'invalid_session_id',
      'malformed_record',
      'malformed_schema_marker',
      'missing_file',
      'partial_write',
      'read_failed',
      'unsupported_schema_version',
      'write_failed'
    ] as const satisfies readonly LocalRuntimeStorageContractErrorCode[];

    expect(errorCodes).toEqual([
      'invalid_session_id',
      'malformed_record',
      'malformed_schema_marker',
      'missing_file',
      'partial_write',
      'read_failed',
      'unsupported_schema_version',
      'write_failed'
    ]);

    for (const code of errorCodes) {
      const error = new LocalRuntimeStorageContractError(
        code,
        `Example local runtime storage error: ${code}.`
      );

      expect(error.code).toBe(code);
      expect(error.name).toBe('LocalRuntimeStorageContractError');
    }
  });

  it('defines the default store root, schema marker, and per-session path layout', () => {
    const layout = createLocalRuntimeStorageLayout();
    const sessionPaths = createLocalRuntimeSessionPaths({
      sessionId: 'mira-local'
    });

    expect(defaultLocalRuntimeStoreRoot).toBe('.project02-runtime');
    expect(defaultLocalRuntimeSessionId).toBe('local-session');
    expect(layout).toEqual({
      storeRoot: '.project02-runtime',
      schemaPath: join('.project02-runtime', 'schema.json'),
      sessionCatalogPath: join('.project02-runtime', 'sessions.jsonl'),
      sessionsRoot: join('.project02-runtime', 'sessions')
    });
    expect(sessionPaths).toEqual({
      sessionId: 'mira-local',
      sessionRoot: join('.project02-runtime', 'sessions', 'mira-local'),
      tracePath: join('.project02-runtime', 'sessions', 'mira-local', 'trace.jsonl'),
      rawEventsPath: join(
        '.project02-runtime',
        'sessions',
        'mira-local',
        'raw-events.jsonl'
      ),
      conversationPath: join(
        '.project02-runtime',
        'sessions',
        'mira-local',
        'conversation.jsonl'
      )
    });
    expect(createLocalRuntimeStorageLayout({ storeRoot: '/tmp/project02-store' })).toEqual({
      storeRoot: '/tmp/project02-store',
      schemaPath: join('/tmp/project02-store', 'schema.json'),
      sessionCatalogPath: join('/tmp/project02-store', 'sessions.jsonl'),
      sessionsRoot: join('/tmp/project02-store', 'sessions')
    });
    expect(
      readFileSync(join(process.cwd(), '.gitignore'), 'utf8')
    ).toContain('.project02-runtime/');
  });

  it('validates storage-safe session IDs before they affect file paths', () => {
    expect(normalizeLocalRuntimeSessionId('  mira.local-01  ')).toBe('mira.local-01');
    expect(normalizeLocalRuntimeSessionId(undefined)).toBe(defaultLocalRuntimeSessionId);

    for (const unsafeSessionId of ['', '   ', '.', '..', 'a/b', 'a\\b', 'a b']) {
      expect(() => normalizeLocalRuntimeSessionId(unsafeSessionId)).toThrow(
        LocalRuntimeStorageContractError
      );
    }

    try {
      normalizeLocalRuntimeSessionId('a/b');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(LocalRuntimeStorageContractError);

      if (!(error instanceof LocalRuntimeStorageContractError)) {
        throw new Error('Expected LocalRuntimeStorageContractError.', {
          cause: error
        });
      }

      expect(error.code).toBe('invalid_session_id');
      expect(error.message).toBe(
        'Local runtime session ID must use only letters, numbers, dots, underscores, or hyphens.'
      );
      return;
    }

    throw new Error('Expected unsafe session ID to be rejected.');
  });

  it('creates deterministic session metadata and schema markers', () => {
    const session = createLocalRuntimeSessionMetadata({
      sessionId: 'mira-local',
      createdAt,
      updatedAt: '2026-06-04T00:05:00.000Z'
    });
    const schema = createLocalRuntimeStorageSchemaMarker({
      createdAt
    });

    expect(session).toEqual({
      sessionId: 'mira-local',
      createdAt,
      updatedAt: '2026-06-04T00:05:00.000Z'
    });
    expect(schema).toEqual({
      schemaVersion: localRuntimeStorageSchemaVersion,
      createdAt
    });
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(schema)).toBe(true);
  });

  it('encodes and decodes the schema marker with unsupported-version errors', () => {
    const encoded = encodeStorageSchemaMarker(
      createLocalRuntimeStorageSchemaMarker({
        createdAt
      })
    );

    expect(decodeStorageSchemaMarker(encoded)).toEqual({
      schemaVersion: localRuntimeStorageSchemaVersion,
      createdAt
    });
    expect(() =>
      decodeStorageSchemaMarker(
        JSON.stringify({
          schemaVersion: localRuntimeStorageSchemaVersion + 1,
          createdAt
        })
      )
    ).toThrow(LocalRuntimeStorageContractError);

    try {
      decodeStorageSchemaMarker('{"schemaVersion":999,"createdAt":"2026-06-04T00:00:00.000Z"}');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(LocalRuntimeStorageContractError);

      if (!(error instanceof LocalRuntimeStorageContractError)) {
        throw new Error('Expected LocalRuntimeStorageContractError.', {
          cause: error
        });
      }

      expect(error.code).toBe('unsupported_schema_version');
      return;
    }

    throw new Error('Expected unsupported schema version to be rejected.');
  });

  it('encodes and decodes MVP-003 runtime trace, raw event, and conversation records', () => {
    const trace: RuntimeTraceEntry = {
      eventId: 'evt_001',
      traceId: 'trace_001',
      createdAt,
      step: 'runtime_event_received'
    };
    const rawEvent: RawEventLogRecord = {
      eventId: 'evt_001',
      traceId: 'trace_001',
      createdAt,
      kind: 'runtime_turn_completed',
      eventType: 'USER_MESSAGE',
      status: 'completed',
      visibleMessageIds: ['local-session:message-1', 'local-session:message-2'],
      payloadSummary: {
        rawInput: ' hello ',
        normalizedCurrentUserMessage: 'hello'
      }
    };
    const conversation: ConversationLogRecord = {
      eventId: 'evt_001',
      traceId: 'trace_001',
      createdAt,
      id: 'local-session:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'hello',
      committedAt: '2026-06-04T00:00:01.000Z'
    };

    const decodedRawEvent = decodeRawEventLogRecord(encodeRawEventLogRecord(rawEvent));

    expect(decodeRuntimeTraceEntry(encodeRuntimeTraceEntry(trace))).toEqual(trace);
    expect(decodedRawEvent).toEqual(rawEvent);
    expect(decodeConversationLogRecord(encodeConversationLogRecord(conversation))).toEqual(
      conversation
    );
    expect(Object.isFrozen(decodedRawEvent)).toBe(true);
    expect(Object.isFrozen(decodedRawEvent.visibleMessageIds)).toBe(true);
    expect(Object.isFrozen(decodedRawEvent.payloadSummary)).toBe(true);
  });

  it('preserves empty payload summary strings used by rejected runtime turns', () => {
    const rawEvent: RawEventLogRecord = {
      eventId: 'evt_rejected_empty',
      traceId: 'trace_rejected_empty',
      createdAt,
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Provide exactly one non-empty message.',
      payloadSummary: {
        rawInput: '',
        normalizedCurrentUserMessage: ''
      }
    };

    expect(decodeRawEventLogRecord(encodeRawEventLogRecord(rawEvent))).toEqual(rawEvent);
  });

  it('rejects terminal raw events without stored turn status', () => {
    expect(() =>
      decodeRawEventLogRecord(
        JSON.stringify({
          eventId: 'evt_missing_status',
          traceId: 'trace_missing_status',
          createdAt,
          kind: 'runtime_turn_completed',
          eventType: 'USER_MESSAGE'
        })
      )
    ).toThrow(LocalRuntimeStorageContractError);
  });

  it('rejects stored visible message text that is not already normalized', () => {
    for (const text of [' hello ', 'line one\nline two']) {
      expect(() =>
        decodeConversationLogRecord(
          JSON.stringify({
            eventId: 'evt_001',
            traceId: 'trace_001',
            createdAt,
            id: 'local-session:message-1',
            role: 'user',
            speakerId: 'local-user',
            speakerName: 'You',
            text,
            committedAt: '2026-06-04T00:00:01.000Z'
          })
        )
      ).toThrow(LocalRuntimeStorageContractError);
    }
  });

  it('rejects malformed stored records without silently skipping them', () => {
    expect(() => decodeRuntimeTraceEntry('{not json')).toThrow(
      LocalRuntimeStorageContractError
    );
    expect(() =>
      decodeRawEventLogRecord(
        JSON.stringify({
          eventId: 'evt_001',
          traceId: 'trace_001',
          createdAt,
          kind: 'runtime_turn_completed',
          eventType: 'UNKNOWN'
        })
      )
    ).toThrow(LocalRuntimeStorageContractError);
    expect(() =>
      decodeConversationLogRecord(
        JSON.stringify({
          eventId: 'evt_001',
          traceId: 'trace_001',
          createdAt,
          id: 'local-session:message-1',
          role: 'system',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'hello',
          committedAt: '2026-06-04T00:00:01.000Z'
        })
      )
    ).toThrow(LocalRuntimeStorageContractError);
  });
});
