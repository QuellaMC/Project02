import { describe, expect, it } from 'vitest';

import {
  createConversationSession,
  createRuntimeLogStore,
  createUserMessageRuntimeEvent,
  runLocalUserMessageEvent,
  type CharacterAgent,
  type RuntimeTraceEntry,
  type RuntimeTraceStepName,
  type UserMessageRuntimeEvent
} from '../src/index.ts';

describe('local runtime turn adapter', () => {
  it('runs one USER_MESSAGE event through the conversation core and records runtime logs', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const event = createTestUserMessageEvent('hello', 'evt_success', 'trace_success');

    const result = await runLocalUserMessageEvent({
      event,
      session,
      logStore
    });

    expect(result.status).toBe('completed');

    if (result.status !== 'completed') {
      throw new Error('Expected completed runtime result.');
    }

    expect(result.turn.reply.text).toBe("I'm here. Tell me what you need.");
    expect(result.conversationMessages).toEqual([
      {
        ...result.turn.userMessage,
        eventId: 'evt_success',
        traceId: 'trace_success',
        createdAt: '2026-06-04T10:00:00.000Z',
        committedAt: '2026-06-04T10:00:00.000Z'
      },
      {
        ...result.turn.characterMessage,
        eventId: 'evt_success',
        traceId: 'trace_success',
        createdAt: '2026-06-04T10:00:00.000Z',
        committedAt: '2026-06-04T10:00:00.000Z'
      }
    ]);
    expect(logStore.conversationMessages()).toEqual(result.conversationMessages);
    expect(logStore.rawEvents()).toEqual([
      {
        eventId: 'evt_success',
        traceId: 'trace_success',
        createdAt: '2026-06-04T10:00:00.000Z',
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE'
      },
      {
        eventId: 'evt_success',
        traceId: 'trace_success',
        createdAt: '2026-06-04T10:00:00.000Z',
        kind: 'runtime_event_normalized',
        eventType: 'USER_MESSAGE'
      },
      {
        eventId: 'evt_success',
        traceId: 'trace_success',
        createdAt: '2026-06-04T10:00:00.000Z',
        kind: 'visible_reply_committed',
        eventType: 'USER_MESSAGE',
        visibleMessageIds: ['local-session:message-1', 'local-session:message-2']
      },
      {
        eventId: 'evt_success',
        traceId: 'trace_success',
        createdAt: '2026-06-04T10:00:00.000Z',
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed',
        visibleMessageIds: ['local-session:message-1', 'local-session:message-2']
      }
    ]);
    expect(stepNames(result.traceEntries)).toEqual([
      'runtime_event_received',
      'runtime_event_normalized',
      'runtime_turn_started',
      'visible_reply_committed',
      'raw_event_log_appended',
      'runtime_turn_completed'
    ]);
    expect(logStore.traceEntries()).toEqual(result.traceEntries);
    expect(session.visibleTranscript).toEqual([
      result.turn.userMessage,
      result.turn.characterMessage
    ]);
  });

  it('preserves recent visible context across runtime turns by reusing runCharacterTurn', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();

    await runLocalUserMessageEvent({
      event: createTestUserMessageEvent('first', 'evt_first', 'trace_first'),
      session,
      logStore
    });
    const secondResult = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent('second', 'evt_second', 'trace_second'),
      session,
      logStore
    });

    expect(secondResult.status).toBe('completed');

    if (secondResult.status !== 'completed') {
      throw new Error('Expected completed second runtime result.');
    }

    expect(secondResult.turn.reply.text).toBe(
      'I remember you said "first" Stay with me for a minute.'
    );
    expect(session.visibleTranscript.map((message) => message.text)).toEqual([
      'first',
      "I'm here. Tell me what you need.",
      'second',
      'I remember you said "first" Stay with me for a minute.'
    ]);
    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'first',
      "I'm here. Tell me what you need.",
      'second',
      'I remember you said "first" Stay with me for a minute.'
    ]);
  });

  it('records a rejected raw outcome without visible conversation logs when event payload input is invalid', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const event: UserMessageRuntimeEvent = Object.freeze({
      eventId: 'evt_invalid_input',
      traceId: 'trace_invalid_input',
      createdAt: '2026-06-04T10:00:00.000Z',
      type: 'USER_MESSAGE',
      payload: Object.freeze({
        currentUserMessage: ''
      })
    });

    const result = await runLocalUserMessageEvent({
      event,
      session,
      logStore
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'input_validation_rejected',
      message: 'Provide exactly one non-empty message.'
    });
    expect(session.visibleTranscript).toEqual([]);
    expect(logStore.conversationMessages()).toEqual([]);
    expect(logStore.rawEvents()).toContainEqual({
      eventId: 'evt_invalid_input',
      traceId: 'trace_invalid_input',
      createdAt: '2026-06-04T10:00:00.000Z',
      kind: 'input_validation_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Provide exactly one non-empty message.'
    });
    expect(logStore.rawEvents()).toContainEqual({
      eventId: 'evt_invalid_input',
      traceId: 'trace_invalid_input',
      createdAt: '2026-06-04T10:00:00.000Z',
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Provide exactly one non-empty message.'
    });
    expect(stepNames(result.traceEntries)).toEqual([
      'runtime_event_received',
      'runtime_event_normalized',
      'runtime_turn_started',
      'input_validation_rejected',
      'raw_event_log_appended',
      'runtime_turn_rejected'
    ]);
  });

  it('records a rejected raw outcome without visible conversation logs when the character reply is invalid', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const agent: CharacterAgent = {
      reply() {
        return {
          text: 'line one\nline two'
        };
      }
    };

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'hello',
        'evt_invalid_reply',
        'trace_invalid_reply'
      ),
      session,
      logStore,
      agent
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'character_reply_rejected',
      message: 'Character agent returned a multi-line reply.'
    });
    expect(session.visibleTranscript).toEqual([]);
    expect(logStore.conversationMessages()).toEqual([]);
    expect(logStore.rawEvents()).toContainEqual({
      eventId: 'evt_invalid_reply',
      traceId: 'trace_invalid_reply',
      createdAt: '2026-06-04T10:00:00.000Z',
      kind: 'character_reply_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Character agent returned a multi-line reply.'
    });
    expect(logStore.rawEvents()).toContainEqual({
      eventId: 'evt_invalid_reply',
      traceId: 'trace_invalid_reply',
      createdAt: '2026-06-04T10:00:00.000Z',
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Character agent returned a multi-line reply.'
    });
    expect(stepNames(result.traceEntries)).toEqual([
      'runtime_event_received',
      'runtime_event_normalized',
      'runtime_turn_started',
      'character_reply_rejected',
      'raw_event_log_appended',
      'runtime_turn_rejected'
    ]);
  });
});

function createTestUserMessageEvent(
  message: string,
  eventId: string,
  traceId: string
): UserMessageRuntimeEvent {
  return createUserMessageRuntimeEvent(message, {
    eventId,
    traceId,
    createdAt: '2026-06-04T10:00:00.000Z'
  });
}

function stepNames(entries: readonly RuntimeTraceEntry[]): RuntimeTraceStepName[] {
  return entries.map((entry) => entry.step);
}
