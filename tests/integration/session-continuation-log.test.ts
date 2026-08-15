import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';

import {createRuntimeLogStore} from '../../src/runtime/evidence/index.ts';
import {createSessionContinuationSnapshot} from '../../src/runtime/evidence/records.ts';
import {
  decodeRawEventLogRecord,
  encodeRawEventLogRecord,
} from '../../src/runtime/storage/raw-event-codec.ts';
import {LocalRuntimeStorageContractError} from '../../src/runtime/storage/layout-contract.ts';
import type {ConversationTurn} from '../../src/role-model/index.ts';

const carriedTurn: ConversationTurn = {
  eventId: 'evt_carried',
  traceId: 'trace_carried',
  createdAt: '2026-06-15T00:00:00.000Z',
  userMessage: {
    id: 'first:message-9',
    role: 'user',
    speakerId: 'local-user',
    speakerName: 'You',
    text: 'which weekend works?',
  },
  toolRounds: [
    {
      round: 1,
      interimReplies: [],
      toolCalls: [
        {
          toolCallId: 'evt_carried.round-1.1',
          pluginId: 'session-history',
          toolName: 'sessions.search',
          input: {query: 'hike'},
          result: {status: 'accepted', output: {totalSessionsWithHits: 1}},
        },
      ],
    },
  ],
  finalReplies: [
    {
      id: 'first:message-10',
      role: 'character',
      speakerId: 'mira',
      speakerName: 'Mira',
      text: 'The one after next.',
    },
  ],
};

function continuation(sessionId: string) {
  return createSessionContinuationSnapshot({
    eventId: 'evt_continued',
    traceId: 'trace_continued',
    createdAt: '2026-06-15T00:05:00.000Z',
    sessionId,
    continuedFrom: {sessionId: 'first', lastEventId: 'evt_carried'},
    summary: 'Mike is planning a September hike; I suggested Ridge Loop.',
    summarizedTurnCount: 14,
    carriedTurns: [carriedTurn],
    summarizer: {status: 'model', provider: {name: 'nvidia', model: 'test'}},
  });
}

describe('session continuation records', () => {
  it('opens a session as its first record and lets ordinary turns follow', () => {
    const logStore = createRuntimeLogStore({
      sessionId: 'first.2',
      boundCharacter: testCharacterProfile,
    });
    const snapshot = continuation('first.2');

    logStore.appendRawEvent({
      eventId: snapshot.eventId,
      traceId: snapshot.traceId,
      createdAt: snapshot.createdAt,
      kind: 'session_continued',
      eventType: 'USER_MESSAGE',
      sessionContinuation: snapshot,
    });
    logStore.appendRawEvent({
      eventId: 'evt_next',
      traceId: 'trace_next',
      createdAt: '2026-06-15T00:06:00.000Z',
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
    });

    expect(logStore.rawEvents().map(record => record.kind)).toEqual([
      'session_continued',
      'runtime_event_received',
    ]);
    expect(logStore.rawEvents()[0]?.sessionContinuation).toEqual(snapshot);
  });

  it('refuses a continuation anywhere but first, one naming another session, and a mismatched kind or field', () => {
    const logStore = createRuntimeLogStore({
      sessionId: 'first.2',
      boundCharacter: testCharacterProfile,
    });
    const foreign = continuation('other.2');

    expect(() =>
      logStore.appendRawEvent({
        eventId: foreign.eventId,
        traceId: foreign.traceId,
        createdAt: foreign.createdAt,
        kind: 'session_continued',
        eventType: 'USER_MESSAGE',
        sessionContinuation: foreign,
      }),
    ).toThrow(/names session "other.2" inside session "first.2"/u);

    logStore.appendRawEvent({
      eventId: 'evt_first',
      traceId: 'trace_first',
      createdAt: '2026-06-15T00:04:00.000Z',
      kind: 'runtime_event_received',
      eventType: 'USER_MESSAGE',
    });

    const snapshot = continuation('first.2');

    expect(() =>
      logStore.appendRawEvent({
        eventId: snapshot.eventId,
        traceId: snapshot.traceId,
        createdAt: snapshot.createdAt,
        kind: 'session_continued',
        eventType: 'USER_MESSAGE',
        sessionContinuation: snapshot,
      }),
    ).toThrow(LocalRuntimeStorageContractError);
    expect(() =>
      decodeRawEventLogRecord(
        JSON.stringify({
          eventId: snapshot.eventId,
          traceId: snapshot.traceId,
          createdAt: snapshot.createdAt,
          kind: 'runtime_event_received',
          eventType: 'USER_MESSAGE',
          sessionContinuation: snapshot,
        }),
      ),
    ).toThrow(LocalRuntimeStorageContractError);
    expect(() =>
      decodeRawEventLogRecord(
        JSON.stringify({
          eventId: snapshot.eventId,
          traceId: snapshot.traceId,
          createdAt: snapshot.createdAt,
          kind: 'session_continued',
          eventType: 'USER_MESSAGE',
        }),
      ),
    ).toThrow(LocalRuntimeStorageContractError);
  });

  it('round-trips the opening record through the codec, carried tool results included', () => {
    const snapshot = continuation('first.2');
    const record = {
      eventId: snapshot.eventId,
      traceId: snapshot.traceId,
      createdAt: snapshot.createdAt,
      kind: 'session_continued' as const,
      eventType: 'USER_MESSAGE' as const,
      sessionContinuation: snapshot,
    };

    expect(decodeRawEventLogRecord(encodeRawEventLogRecord(record))).toEqual(
      record,
    );
    expect(() =>
      createSessionContinuationSnapshot({...snapshot, summary: '   '}),
    ).toThrow('Session continuation summary must be 1 to 6000 characters.');
    expect(() =>
      createSessionContinuationSnapshot({
        ...snapshot,
        continuedFrom: {sessionId: 'first.2', lastEventId: 'evt_carried'},
      }),
    ).toThrow('must name a different session');
  });
});
