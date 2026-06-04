import { describe, expect, it } from 'vitest';

import {
  createConversationSession,
  createRuntimeLogStore,
  createUserMessageRuntimeEvent,
  recordLocalUserMessageInputRejection,
  runLocalUserMessageEvent,
  type CharacterAgent,
  type CharacterAgentReply,
  type RuntimeTraceEntry,
  type RuntimeTraceStepName,
  type UserMessageRuntimeEvent
} from '../src/index.ts';

type DeferredReply = {
  readonly promise: Promise<CharacterAgentReply>;
  readonly resolve: (reply: CharacterAgentReply) => void;
};

describe('local runtime turn adapter', () => {
  it('runs one USER_MESSAGE event through the conversation core and records runtime logs', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const event = createTestUserMessageEvent(' hello ', 'evt_success', 'trace_success');

    const result = await runLocalUserMessageEvent({
      event,
      session,
      logStore,
      rawInput: ' hello '
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
        eventType: 'USER_MESSAGE',
        payloadSummary: {
          rawInput: ' hello ',
          normalizedCurrentUserMessage: 'hello'
        }
      },
      {
        eventId: 'evt_success',
        traceId: 'trace_success',
        createdAt: '2026-06-04T10:00:00.000Z',
        kind: 'runtime_event_normalized',
        eventType: 'USER_MESSAGE',
        payloadSummary: {
          rawInput: ' hello ',
          normalizedCurrentUserMessage: 'hello'
        }
      },
      {
        eventId: 'evt_success',
        traceId: 'trace_success',
        createdAt: '2026-06-04T10:00:00.000Z',
        kind: 'visible_reply_committed',
        eventType: 'USER_MESSAGE',
        visibleMessageIds: ['local-session:message-1', 'local-session:message-2'],
        payloadSummary: {
          rawInput: ' hello ',
          normalizedCurrentUserMessage: 'hello'
        }
      },
      {
        eventId: 'evt_success',
        traceId: 'trace_success',
        createdAt: '2026-06-04T10:00:00.000Z',
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed',
        visibleMessageIds: ['local-session:message-1', 'local-session:message-2'],
        payloadSummary: {
          rawInput: ' hello ',
          normalizedCurrentUserMessage: 'hello'
        }
      }
    ]);
    expect(Object.isFrozen(result.rawEvent.payloadSummary)).toBe(true);
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

  it('freezes a snapshot of rejected-input identity before returning it', () => {
    const logStore = createRuntimeLogStore();
    const mutableIdentity = {
      eventId: 'evt_mutable_rejection',
      traceId: 'trace_mutable_rejection',
      createdAt: '2026-06-04T10:00:00.000Z'
    };

    const result = recordLocalUserMessageInputRejection({
      identity: mutableIdentity,
      logStore,
      message: 'Provide exactly one non-empty message.',
      rawInput: ''
    });

    mutableIdentity.eventId = 'evt_mutated_after_result';
    mutableIdentity.traceId = 'trace_mutated_after_result';
    mutableIdentity.createdAt = '2026-06-04T10:00:01.000Z';

    expect(result.identity).toEqual({
      eventId: 'evt_mutable_rejection',
      traceId: 'trace_mutable_rejection',
      createdAt: '2026-06-04T10:00:00.000Z'
    });
    expect(Object.isFrozen(result.identity)).toBe(true);
    expect(logStore.rawEvents()).toContainEqual({
      eventId: 'evt_mutable_rejection',
      traceId: 'trace_mutable_rejection',
      createdAt: '2026-06-04T10:00:00.000Z',
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Provide exactly one non-empty message.',
      payloadSummary: {
        rawInput: ''
      }
    });
    expect(Object.isFrozen(result.rawEvent.payloadSummary)).toBe(true);
  });

  it('serializes runtime trace start logging with queued turns for one session', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const firstReply = createDeferredReply();
    const observedMessages: string[] = [];
    const agent: CharacterAgent = {
      reply(input) {
        observedMessages.push(input.message);

        if (input.message === 'first') {
          return firstReply.promise;
        }

        return {
          text: 'reply 2'
        };
      }
    };

    const firstTurn = runLocalUserMessageEvent({
      event: createTestUserMessageEvent('first', 'evt_first', 'trace_first'),
      session,
      logStore,
      agent
    });
    const secondTurn = runLocalUserMessageEvent({
      event: createTestUserMessageEvent('second', 'evt_second', 'trace_second'),
      session,
      logStore,
      agent
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(observedMessages).toEqual(['first']);
    expect(logStore.traceEntries().map((entry) => entry.eventId)).toEqual([
      'evt_first',
      'evt_first',
      'evt_first'
    ]);

    firstReply.resolve({
      text: 'reply 1'
    });

    await expect(firstTurn).resolves.toMatchObject({
      status: 'completed'
    });
    await expect(secondTurn).resolves.toMatchObject({
      status: 'completed'
    });
    expect(observedMessages).toEqual(['first', 'second']);
    expect(
      logStore
        .traceEntries()
        .map((entry) => `${entry.eventId}:${entry.step}`)
    ).toEqual([
      'evt_first:runtime_event_received',
      'evt_first:runtime_event_normalized',
      'evt_first:runtime_turn_started',
      'evt_first:visible_reply_committed',
      'evt_first:raw_event_log_appended',
      'evt_first:runtime_turn_completed',
      'evt_second:runtime_event_received',
      'evt_second:runtime_event_normalized',
      'evt_second:runtime_turn_started',
      'evt_second:visible_reply_committed',
      'evt_second:raw_event_log_appended',
      'evt_second:runtime_turn_completed'
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
      reason: 'Provide exactly one non-empty message.',
      payloadSummary: {
        normalizedCurrentUserMessage: ''
      }
    });
    expect(logStore.rawEvents()).toContainEqual({
      eventId: 'evt_invalid_input',
      traceId: 'trace_invalid_input',
      createdAt: '2026-06-04T10:00:00.000Z',
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Provide exactly one non-empty message.',
      payloadSummary: {
        normalizedCurrentUserMessage: ''
      }
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
      reason: 'Character agent returned a multi-line reply.',
      payloadSummary: {
        normalizedCurrentUserMessage: 'hello'
      }
    });
    expect(logStore.rawEvents()).toContainEqual({
      eventId: 'evt_invalid_reply',
      traceId: 'trace_invalid_reply',
      createdAt: '2026-06-04T10:00:00.000Z',
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Character agent returned a multi-line reply.',
      payloadSummary: {
        normalizedCurrentUserMessage: 'hello'
      }
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

  it('records a terminal rejected trace before rethrowing unexpected agent failures', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const agent: CharacterAgent = {
      reply() {
        throw new Error('agent transport unavailable');
      }
    };

    await expect(
      runLocalUserMessageEvent({
        event: createTestUserMessageEvent('hello', 'evt_throw', 'trace_throw'),
        session,
        logStore,
        agent
      })
    ).rejects.toThrow('agent transport unavailable');

    expect(session.visibleTranscript).toEqual([]);
    expect(logStore.conversationMessages()).toEqual([]);
    expect(logStore.rawEvents()).toContainEqual({
      eventId: 'evt_throw',
      traceId: 'trace_throw',
      createdAt: '2026-06-04T10:00:00.000Z',
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Runtime turn failed before producing a reply.',
      payloadSummary: {
        normalizedCurrentUserMessage: 'hello'
      }
    });
    expect(stepNames(logStore.traceEntries())).toEqual([
      'runtime_event_received',
      'runtime_event_normalized',
      'runtime_turn_started',
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

function createDeferredReply(): DeferredReply {
  let resolveReply: ((reply: CharacterAgentReply) => void) | undefined;
  const promise = new Promise<CharacterAgentReply>((resolve) => {
    resolveReply = resolve;
  });

  if (resolveReply === undefined) {
    throw new Error('Expected deferred reply resolver to be initialized.');
  }

  return {
    promise,
    resolve: resolveReply
  };
}
