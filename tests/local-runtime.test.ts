import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CharacterReplyValidationError,
  agentCapabilityContractVersion,
  createAgentCapability,
  createAgentCapabilityEvidenceSnapshot,
  createConversationSession,
  createDefaultCharacterRuntimeState,
  createFileCharacterStateStore,
  createFileRuntimeLogStore,
  createInMemoryCharacterStateStore,
  createLocalRuntimeSessionStore,
  createRuntimeCapabilityHost,
  createRuntimeLogStore,
  createUserMessageRuntimeEvent,
  recordLocalUserMessageInputRejection,
  runtimeCapabilityBeforeRoleModelCallRejectionReason,
  roleModelDecisionContractVersion,
  roleModelCapabilityToolRejectedRejectionReason,
  roleModelInvalidCharacterStatePatchRejectionReason,
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelVisibleReplyActionName,
  runLocalUserMessageEvent,
  type AgentCapability,
  type AgentCapabilityContextItem,
  type AgentCapabilityLifecycleHooks,
  type CharacterAgent,
  type CharacterAgentReply,
  type CharacterStateStore,
  type RawEventLogRecord,
  type RawEventLogRecordKind,
  type RuntimeLogStore,
  type RoleModelAdapter,
  type RuntimeTraceEntry,
  type RuntimeTraceStepName,
  type UserMessageRuntimeEvent
} from '../src/index.ts';

const tempStoreRoots: string[] = [];

type DeferredReply = {
  readonly promise: Promise<CharacterAgentReply>;
  readonly resolve: (reply: CharacterAgentReply) => void;
};

describe('local runtime turn adapter', () => {
  afterEach(() => {
    for (const storeRoot of tempStoreRoots.splice(0)) {
      rmSync(storeRoot, {
        recursive: true,
        force: true
      });
    }
  });

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
    const rawEvents = logStore.rawEvents();

    expect(rawEvents).toHaveLength(4);
    expect(rawEvents.slice(0, 2)).toEqual([
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
    ]);

    const visibleReplyCommitted = findRawEvent(
      rawEvents,
      'visible_reply_committed'
    );
    const terminalCompleted = findRawEvent(rawEvents, 'runtime_turn_completed');

    expect(visibleReplyCommitted).toMatchObject({
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
    });
    expect(visibleReplyCommitted.roleModelIOSnapshot).toMatchObject({
      eventId: 'evt_success',
      traceId: 'trace_success',
      sessionId: 'local-session',
      rawOutputText: JSON.stringify({
        version: 'mvp-006.tool_calls.v1',
        toolCalls: [
          {
            name: roleModelVisibleReplyActionName,
            input: {
              text: "I'm here. Tell me what you need."
            }
          }
        ]
      })
    });
    expect(
      visibleReplyCommitted.parsedRoleModelDecisionSnapshot?.result
    ).toEqual({
      status: 'accepted',
      decision: {
        version: 'mvp-006.tool_calls.v1',
        toolCalls: [
          {
            name: roleModelVisibleReplyActionName,
            input: {
              text: "I'm here. Tell me what you need."
            }
          }
        ]
      }
    });
    expect(visibleReplyCommitted.commitValidation?.result).toEqual({
      status: 'accepted',
      acceptedVisibleReplyText: "I'm here. Tell me what you need."
    });
    expect(terminalCompleted).toEqual({
      ...visibleReplyCommitted,
      kind: 'runtime_turn_completed',
      status: 'completed'
    });
    expect(result.rawEvent).toEqual(terminalCompleted);
    expect(result.rawEventLogRecords).toEqual(rawEvents);
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

  it('normalizes caller-built USER_MESSAGE events before role-model input and persisted evidence', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const event: UserMessageRuntimeEvent = Object.freeze({
      eventId: 'evt_api_whitespace',
      traceId: 'trace_api_whitespace',
      createdAt: '2026-06-04T10:00:00.000Z',
      type: 'USER_MESSAGE',
      payload: Object.freeze({
        currentUserMessage: ' hello '
      })
    });
    const observedRoleModelMessages: string[] = [];
    const roleModelAdapter: RoleModelAdapter = {
      invoke(inputEnvelope) {
        const currentUserMessage =
          inputEnvelope.event.payload.currentUserMessage;

        observedRoleModelMessages.push(currentUserMessage);

        return {
          rawOutputText: JSON.stringify({
            action: {
              type: roleModelVisibleReplyActionName,
              text: `reply to ${currentUserMessage}`
            }
          })
        };
      }
    };

    const result = await runLocalUserMessageEvent({
      event,
      session,
      logStore,
      rawInput: ' hello ',
      roleModelAdapter
    });

    expect(result.status).toBe('completed');

    if (result.status !== 'completed') {
      throw new Error('Expected completed runtime result.');
    }

    const visibleReplyCommitted = findRawEvent(
      result.rawEventLogRecords,
      'visible_reply_committed'
    );
    const terminalCompleted = findRawEvent(
      result.rawEventLogRecords,
      'runtime_turn_completed'
    );

    expect(event.payload.currentUserMessage).toBe(' hello ');
    expect(result.event.payload.currentUserMessage).toBe('hello');
    expect(observedRoleModelMessages).toEqual(['hello']);
    expect(result.conversationMessages.map((message) => message.text)).toEqual([
      'hello',
      'reply to hello'
    ]);
    expect(terminalCompleted.payloadSummary).toEqual({
      rawInput: ' hello ',
      normalizedCurrentUserMessage: 'hello'
    });
    expect(
      visibleReplyCommitted.roleModelIOSnapshot?.inputEnvelope.event.payload
        .currentUserMessage
    ).toBe('hello');
    expect(
      terminalCompleted.roleModelIOSnapshot?.inputEnvelope.event.payload
        .currentUserMessage
    ).toBe('hello');
    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'hello',
      'reply to hello'
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
      reason: roleModelInvalidVisibleReplyRejectionReason,
      message: 'Character agent returned a multi-line reply.'
    });
    expect(session.visibleTranscript).toEqual([]);
    expect(logStore.conversationMessages()).toEqual([]);
    const commitValidationRejected = findRawEvent(
      logStore.rawEvents(),
      'commit_validation_rejected'
    );
    const terminalRejected = findRawEvent(
      logStore.rawEvents(),
      'runtime_turn_rejected'
    );

    expect(commitValidationRejected).toMatchObject({
      eventId: 'evt_invalid_reply',
      traceId: 'trace_invalid_reply',
      createdAt: '2026-06-04T10:00:00.000Z',
      kind: 'commit_validation_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: roleModelInvalidVisibleReplyRejectionReason,
      payloadSummary: {
        normalizedCurrentUserMessage: 'hello'
      }
    });
    expect(commitValidationRejected.roleModelIOSnapshot).toBeDefined();
    expect(
      commitValidationRejected.parsedRoleModelDecisionSnapshot?.result
    ).toMatchObject({
      status: 'accepted'
    });
    expect(commitValidationRejected.commitValidation?.result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelInvalidVisibleReplyRejectionReason
      }
    });
    expect(terminalRejected).toEqual({
      ...commitValidationRejected,
      kind: 'runtime_turn_rejected',
      status: 'rejected'
    });
    expect(stepNames(result.traceEntries)).toEqual([
      'runtime_event_received',
      'runtime_event_normalized',
      'runtime_turn_started',
      'commit_validation_rejected',
      'raw_event_log_appended',
      'runtime_turn_rejected'
    ]);
  });

  it('records pre-role-model reply validation failures without partial role-model evidence', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const agent: CharacterAgent = {
      reply() {
        throw new CharacterReplyValidationError(
          'Character agent returned a multi-line reply.'
        );
      }
    };

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'hello',
        'evt_pre_role_model_invalid_reply',
        'trace_pre_role_model_invalid_reply'
      ),
      session,
      logStore,
      agent
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: roleModelInvalidVisibleReplyRejectionReason,
      message: 'Character agent returned a multi-line reply.'
    });
    expect(session.visibleTranscript).toEqual([]);
    expect(logStore.conversationMessages()).toEqual([]);

    const characterReplyRejected = findRawEvent(
      logStore.rawEvents(),
      'character_reply_rejected'
    );
    const terminalRejected = findRawEvent(
      logStore.rawEvents(),
      'runtime_turn_rejected'
    );

    expect(characterReplyRejected).toEqual({
      eventId: 'evt_pre_role_model_invalid_reply',
      traceId: 'trace_pre_role_model_invalid_reply',
      createdAt: '2026-06-04T10:00:00.000Z',
      kind: 'character_reply_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: roleModelInvalidVisibleReplyRejectionReason,
      payloadSummary: {
        normalizedCurrentUserMessage: 'hello'
      }
    });
    expect(terminalRejected).toEqual({
      ...characterReplyRejected,
      kind: 'runtime_turn_rejected'
    });
    expect(
      logStore.rawEvents().every((record) =>
        record.roleModelIOSnapshot === undefined &&
        record.parsedRoleModelDecisionSnapshot === undefined &&
        record.commitValidation === undefined
      )
    ).toBe(true);
    expect(stepNames(result.traceEntries)).toEqual([
      'runtime_event_received',
      'runtime_event_normalized',
      'runtime_turn_started',
      'character_reply_rejected',
      'raw_event_log_appended',
      'runtime_turn_rejected'
    ]);
  });

  it('records malformed custom character-agent replies as character reply rejections', async () => {
    const malformedReplies: readonly unknown[] = [null, {}, { text: 42 }];

    for (const [index, malformedReply] of malformedReplies.entries()) {
      const session = createConversationSession();
      const logStore = createRuntimeLogStore();
      const agent: CharacterAgent = {
        reply() {
          // Bypass the static agent contract to exercise runtime boundary validation.
          return malformedReply as CharacterAgentReply;
        }
      };

      const result = await runLocalUserMessageEvent({
        event: createTestUserMessageEvent(
          'hello',
          `evt_malformed_reply_${String(index)}`,
          `trace_malformed_reply_${String(index)}`
        ),
        session,
        logStore,
        agent
      });

      expect(result).toMatchObject({
        status: 'rejected',
        reason: roleModelInvalidVisibleReplyRejectionReason,
        message: 'Character agent returned an invalid reply.'
      });
      expect(session.visibleTranscript).toEqual([]);
      expect(logStore.conversationMessages()).toEqual([]);

      const characterReplyRejected = findRawEvent(
        logStore.rawEvents(),
        'character_reply_rejected'
      );
      const terminalRejected = findRawEvent(
        logStore.rawEvents(),
        'runtime_turn_rejected'
      );

      expect(characterReplyRejected).toEqual({
        eventId: `evt_malformed_reply_${String(index)}`,
        traceId: `trace_malformed_reply_${String(index)}`,
        createdAt: '2026-06-04T10:00:00.000Z',
        kind: 'character_reply_rejected',
        eventType: 'USER_MESSAGE',
        status: 'rejected',
        reason: roleModelInvalidVisibleReplyRejectionReason,
        payloadSummary: {
          normalizedCurrentUserMessage: 'hello'
        }
      });
      expect(terminalRejected).toEqual({
        ...characterReplyRejected,
        kind: 'runtime_turn_rejected'
      });
      expect(
        logStore.rawEvents().every((record) =>
          record.roleModelIOSnapshot === undefined &&
          record.parsedRoleModelDecisionSnapshot === undefined &&
          record.commitValidation === undefined
        )
      ).toBe(true);
      expect(stepNames(result.traceEntries)).toEqual([
        'runtime_event_received',
        'runtime_event_normalized',
        'runtime_turn_started',
        'character_reply_rejected',
        'raw_event_log_appended',
        'runtime_turn_rejected'
      ]);
    }
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

  it('commits visible reply plus valid character state patch after validation', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const characterStateStore = createInMemoryCharacterStateStore();

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'hello',
        'evt_state_patch',
        'trace_state_patch'
      ),
      session,
      logStore,
      characterStateStore,
      roleModelAdapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'stateful reply'
              }
            },
            {
              name: 'character_state.patch',
              input: {
                mood: 'curious',
                currentActivity: 'chatting'
              }
            }
          ]
        })
      )
    });

    expect(result.status).toBe('completed');

    if (result.status !== 'completed') {
      throw new Error('Expected completed runtime result.');
    }

    expect(characterStateStore.readCurrentState().current).toMatchObject({
      mood: 'curious',
      currentActivity: 'chatting'
    });
    expect(result.rawEvent.characterStatePatchSnapshot?.result).toMatchObject({
      status: 'accepted',
      patch: {
        mood: 'curious',
        currentActivity: 'chatting'
      },
      appliedChanges: [
        {
          field: 'mood',
          before: 'steady',
          after: 'curious'
        },
        {
          field: 'currentActivity',
          before: 'idle',
          after: 'chatting'
        }
      ]
    });
  });

  it('writes accepted character state only after visible conversation logging succeeds', async () => {
    const session = createConversationSession();
    const baseLogStore = createRuntimeLogStore();
    const characterStateStore = createInMemoryCharacterStateStore();
    const observedOrder: string[] = [];
    const logStore = Object.freeze({
      appendTrace(entry) {
        return baseLogStore.appendTrace(entry);
      },
      appendRawEvent(record) {
        return baseLogStore.appendRawEvent(record);
      },
      appendConversationMessage(record) {
        observedOrder.push('conversation');
        return baseLogStore.appendConversationMessage(record);
      },
      traceEntries() {
        return baseLogStore.traceEntries();
      },
      rawEvents() {
        return baseLogStore.rawEvents();
      },
      conversationMessages() {
        return baseLogStore.conversationMessages();
      }
    } satisfies RuntimeLogStore);
    const orderedStateStore = Object.freeze({
      readCurrentState() {
        return characterStateStore.readCurrentState();
      },
      writeCurrentState(state) {
        observedOrder.push('state');
        return characterStateStore.writeCurrentState(state);
      }
    } satisfies CharacterStateStore);

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'hello',
        'evt_state_order',
        'trace_state_order'
      ),
      session,
      logStore,
      characterStateStore: orderedStateStore,
      roleModelAdapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'stateful reply'
              }
            },
            {
              name: 'character_state.patch',
              input: {
                mood: 'curious'
              }
            }
          ]
        })
      )
    });

    expect(result.status).toBe('completed');
    expect(observedOrder).toEqual(['conversation', 'conversation', 'state']);
  });

  it('accepts no-op character state patches and logs empty applied changes', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const characterStateStore = createInMemoryCharacterStateStore();

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'hello',
        'evt_state_noop',
        'trace_state_noop'
      ),
      session,
      logStore,
      characterStateStore,
      roleModelAdapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'noop reply'
              }
            },
            {
              name: 'character_state.patch',
              input: {
                mood: 'steady'
              }
            }
          ]
        })
      )
    });

    expect(result.status).toBe('completed');

    if (result.status !== 'completed') {
      throw new Error('Expected completed runtime result.');
    }

    expect(result.rawEvent.characterStatePatchSnapshot?.result).toMatchObject({
      status: 'accepted',
      appliedChanges: []
    });
  });

  it('rejects invalid character state patches before visible messages are committed', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const characterStateStore = createInMemoryCharacterStateStore();

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'hello',
        'evt_state_rejected',
        'trace_state_rejected'
      ),
      session,
      logStore,
      characterStateStore,
      roleModelAdapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'rejected reply'
              }
            },
            {
              name: 'character_state.patch',
              input: {
                mood: 'ecstatic'
              }
            }
          ]
        })
      )
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: roleModelInvalidCharacterStatePatchRejectionReason
    });
    expect(session.visibleTranscript).toEqual([]);
    expect(logStore.conversationMessages()).toEqual([]);
    expect(characterStateStore.readCurrentState().current.mood).toBe('steady');
    expect(result.rawEvent.characterStatePatchSnapshot?.result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: 'invalid_state_value'
      }
    });
  });

  it('rolls back character state when visible conversation logging fails', async () => {
    const session = createConversationSession();
    const baseLogStore = createRuntimeLogStore();
    const logStore = createConversationAppendFailingLogStore(baseLogStore);
    const characterStateStore = createInMemoryCharacterStateStore();

    await expect(
      runLocalUserMessageEvent({
        event: createTestUserMessageEvent(
          'hello',
          'evt_state_log_failure',
          'trace_state_log_failure'
        ),
        session,
        logStore,
        characterStateStore,
        roleModelAdapter: createRawOutputAdapter(
          JSON.stringify({
            version: roleModelDecisionContractVersion,
            toolCalls: [
              {
                name: roleModelVisibleReplyActionName,
                input: {
                  text: 'stateful reply'
                }
              },
              {
                name: 'character_state.patch',
                input: {
                  mood: 'curious'
                }
              }
            ]
          })
        )
      })
    ).rejects.toThrow('conversation append failed');

    expect(characterStateStore.readCurrentState().current.mood).toBe('steady');
    expect(baseLogStore.conversationMessages()).toEqual([]);
    expect(baseLogStore.rawEvents()).toContainEqual({
      eventId: 'evt_state_log_failure',
      traceId: 'trace_state_log_failure',
      createdAt: '2026-06-04T10:00:00.000Z',
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Runtime turn failed before producing a reply.',
      payloadSummary: {
        normalizedCurrentUserMessage: 'hello'
      }
    });
  });

  it('rolls back durable character state when final completed raw-event append fails', async () => {
    const storeRoot = createTempStoreRoot();
    const sessionId = 'mira-local';
    await createCatalogedSession(storeRoot, sessionId);

    const session = createConversationSession({
      id: sessionId
    });
    const baseLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    });
    const logStore = createCompletedRawEventAppendFailingLogStore(baseLogStore);
    const characterStateStore = createFileCharacterStateStore({
      storeRoot,
      sessionId
    });

    await expect(
      runLocalUserMessageEvent({
        event: createTestUserMessageEvent(
          'hello',
          'evt_state_terminal_failure',
          'trace_state_terminal_failure'
        ),
        session,
        logStore,
        characterStateStore,
        roleModelAdapter: createRawOutputAdapter(
          JSON.stringify({
            version: roleModelDecisionContractVersion,
            toolCalls: [
              {
                name: roleModelVisibleReplyActionName,
                input: {
                  text: 'stateful reply'
                }
              },
              {
                name: 'character_state.patch',
                input: {
                  mood: 'curious'
                }
              }
            ]
          })
        )
      })
    ).rejects.toThrow('Conversation message lacks terminal raw-event evidence');

    expect(characterStateStore.readCurrentState()).toEqual(
      createDefaultCharacterRuntimeState()
    );
    expect(
      () =>
        createFileRuntimeLogStore({
          storeRoot,
          sessionId
        }).rawEvents()
    ).not.toThrow(
      'Stored character state does not match accepted character state patch evidence.'
    );
  });

  it('pairs omitted character state store with a file-backed log store', async () => {
    const storeRoot = createTempStoreRoot();
    const sessionId = 'mira-local';
    await createCatalogedSession(storeRoot, sessionId);

    const session = createConversationSession({
      id: sessionId
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    });

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'hello',
        'evt_default_file_state',
        'trace_default_file_state'
      ),
      session,
      logStore,
      roleModelAdapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'stateful durable reply'
              }
            },
            {
              name: 'character_state.patch',
              input: {
                mood: 'curious'
              }
            }
          ]
        })
      )
    });

    expect(result.status).toBe('completed');
    expect(
      createFileCharacterStateStore({
        storeRoot,
        sessionId
      }).readCurrentState().current.mood
    ).toBe('curious');
    expect(() =>
      createFileRuntimeLogStore({
        storeRoot,
        sessionId
      }).rawEvents()
    ).not.toThrow(
      'Stored character state does not match accepted character state patch evidence.'
    );
  });

  it('does not reuse an in-memory default for a later file-backed log store', async () => {
    const sessionId = 'mira-local';
    const session = createConversationSession({
      id: sessionId
    });

    const warmupResult = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'warmup',
        'evt_memory_state_warmup',
        'trace_memory_state_warmup'
      ),
      session,
      logStore: createRuntimeLogStore(),
      roleModelAdapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'memory reply'
              }
            },
            {
                name: 'character_state.patch',
                input: {
                  mood: 'ecstatic'
                }
              }
            ]
        })
      )
    });

    expect(warmupResult.status).toBe('rejected');

    expect(session.visibleTranscript).toEqual([]);

    const storeRoot = createTempStoreRoot();
    await createCatalogedSession(storeRoot, sessionId);
    const fileLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    });

    await expect(
      runLocalUserMessageEvent({
        event: createTestUserMessageEvent(
          'file turn',
          'evt_file_state_after_memory',
          'trace_file_state_after_memory'
        ),
        session,
        logStore: fileLogStore,
        roleModelAdapter: createRawOutputAdapter(
          JSON.stringify({
            version: roleModelDecisionContractVersion,
            toolCalls: [
              {
                name: roleModelVisibleReplyActionName,
                input: {
                  text: 'file reply'
                }
              },
              {
                name: 'character_state.patch',
                input: {
                  mood: 'curious'
                }
              }
            ]
          })
        )
      })
    ).resolves.toMatchObject({ status: 'completed' });

    expect(
      createFileCharacterStateStore({
        storeRoot,
        sessionId
      }).readCurrentState().current.mood
    ).toBe('curious');
  });

  it('keeps the default in-memory character state store scoped to the session', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const observedMoods: string[] = [];
    let turnIndex = 0;
    const roleModelAdapter: RoleModelAdapter = {
      invoke(inputEnvelope) {
        observedMoods.push(
          inputEnvelope.decisionContext.livingStateBrief?.current.mood ??
            'missing'
        );
        turnIndex += 1;

        return {
          rawOutputText: JSON.stringify({
            version: roleModelDecisionContractVersion,
            toolCalls: [
              {
                name: roleModelVisibleReplyActionName,
                input: {
                  text: `reply ${String(turnIndex)}`
                }
              },
              ...(turnIndex === 1
                ? [
                    {
                      name: 'character_state.patch',
                      input: {
                        mood: 'curious'
                      }
                    }
                  ]
                : [])
            ]
          })
        };
      }
    };

    await expect(
      runLocalUserMessageEvent({
        event: createTestUserMessageEvent(
          'first',
          'evt_default_state_first',
          'trace_default_state_first'
        ),
        session,
        logStore,
        roleModelAdapter
      })
    ).resolves.toMatchObject({ status: 'completed' });
    await expect(
      runLocalUserMessageEvent({
        event: createTestUserMessageEvent(
          'second',
          'evt_default_state_second',
          'trace_default_state_second'
        ),
        session,
        logStore,
        roleModelAdapter
      })
    ).resolves.toMatchObject({ status: 'completed' });

    expect(observedMoods).toEqual(['steady', 'curious']);
  });

  it('does not append accepted raw-event evidence when accepted state writes fail', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const characterStateStore = createWriteFailingCharacterStateStore();

    await expect(
      runLocalUserMessageEvent({
        event: createTestUserMessageEvent(
          'hello',
          'evt_state_write_failure',
          'trace_state_write_failure'
        ),
        session,
        logStore,
        characterStateStore,
        roleModelAdapter: createRawOutputAdapter(
          JSON.stringify({
            version: roleModelDecisionContractVersion,
            toolCalls: [
              {
                name: roleModelVisibleReplyActionName,
                input: {
                  text: 'stateful reply'
                }
              },
              {
                name: 'character_state.patch',
                input: {
                  mood: 'curious'
                }
              }
            ]
          })
        )
      })
    ).rejects.toThrow('state write failed');

    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'hello',
      'stateful reply'
    ]);
    expect(session.visibleTranscript).toEqual([]);
    expect(
      logStore
        .rawEvents()
        .some((record) => record.kind === 'visible_reply_committed')
    ).toBe(false);
    expect(logStore.rawEvents()).toContainEqual({
      eventId: 'evt_state_write_failure',
      traceId: 'trace_state_write_failure',
      createdAt: '2026-06-04T10:00:00.000Z',
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Runtime turn failed before producing a reply.',
      payloadSummary: {
        normalizedCurrentUserMessage: 'hello'
      }
    });
  });

  it('runs optional before-model hooks before the role-model adapter and degrades with evidence', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const order: string[] = [];
    const capabilityHost = createRuntimeCapabilityHost({
      capabilities: [
        createRuntimeTestCapability({
          id: 'memory.optional_before_runtime',
          displayName: 'Optional runtime before hook',
          beforeRoleModelCall() {
            order.push('before');
            throw new Error('recall unavailable');
          }
        })
      ]
    });
    const roleModelAdapter: RoleModelAdapter = {
      invoke(inputEnvelope) {
        order.push('adapter');
        expect(inputEnvelope.event.payload.currentUserMessage).toBe('hello');

        return {
          rawOutputText: JSON.stringify({
            version: roleModelDecisionContractVersion,
            toolCalls: [
              {
                name: roleModelVisibleReplyActionName,
                input: {
                  text: 'reply after optional degradation'
                }
              }
            ]
          })
        };
      }
    };

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'hello',
        'evt_optional_before',
        'trace_optional_before'
      ),
      session,
      logStore,
      roleModelAdapter,
      capabilityHost
    });

    expect(result.status).toBe('completed');

    if (result.status !== 'completed') {
      throw new Error('Expected completed runtime result.');
    }

    const visibleReplyCommitted = findRawEvent(
      result.rawEventLogRecords,
      'visible_reply_committed'
    );
    const terminalCompleted = findRawEvent(
      result.rawEventLogRecords,
      'runtime_turn_completed'
    );

    expect(order).toEqual(['before', 'adapter']);
    expect(result.turn.reply.text).toBe('reply after optional degradation');
    expect(visibleReplyCommitted.agentCapabilityEvidence).toMatchObject([
      {
        capabilityId: 'memory.optional_before_runtime',
        evidenceKind: 'before_role_model_call',
        status: 'degraded',
        policyOutcome: 'optional_degraded'
      }
    ]);
    expect(terminalCompleted.agentCapabilityEvidence).toEqual(
      visibleReplyCommitted.agentCapabilityEvidence
    );
  });

  it('rejects required before-model hook failures before visible commit', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    let adapterCalls = 0;
    const capabilityHost = createRuntimeCapabilityHost({
      capabilities: [
        createRuntimeTestCapability({
          id: 'memory.required_before_runtime',
          displayName: 'Required runtime before hook',
          requiredForTurn: true,
          beforeRoleModelCall() {
            throw new Error('required recall unavailable');
          }
        })
      ]
    });
    const roleModelAdapter: RoleModelAdapter = {
      invoke() {
        adapterCalls += 1;

        return {
          rawOutputText: JSON.stringify({
            version: roleModelDecisionContractVersion,
            toolCalls: [
              {
                name: roleModelVisibleReplyActionName,
                input: {
                  text: 'should not commit'
                }
              }
            ]
          })
        };
      }
    };

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'hello',
        'evt_required_before',
        'trace_required_before'
      ),
      session,
      logStore,
      roleModelAdapter,
      capabilityHost
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: runtimeCapabilityBeforeRoleModelCallRejectionReason,
      message: 'required recall unavailable'
    });
    expect(adapterCalls).toBe(0);
    expect(session.visibleTranscript).toEqual([]);
    expect(logStore.conversationMessages()).toEqual([]);

    const capabilityRejected = findRawEvent(
      result.rawEventLogRecords,
      'capability_before_role_model_call_rejected'
    );
    const terminalRejected = findRawEvent(
      result.rawEventLogRecords,
      'runtime_turn_rejected'
    );

    expect(capabilityRejected.agentCapabilityEvidence).toMatchObject([
      {
        capabilityId: 'memory.required_before_runtime',
        evidenceKind: 'before_role_model_call',
        status: 'rejected',
        policyOutcome: 'required_rejected'
      }
    ]);
    expect(terminalRejected.agentCapabilityEvidence).toEqual(
      capabilityRejected.agentCapabilityEvidence
    );
    expect(stepNames(result.traceEntries)).toEqual([
      'runtime_event_received',
      'runtime_event_normalized',
      'runtime_turn_started',
      'capability_before_role_model_call_rejected',
      'raw_event_log_appended',
      'runtime_turn_rejected'
    ]);
  });

  it('rejects required capability context without source references before model call', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    let adapterCalls = 0;
    const capabilityHost = createRuntimeCapabilityHost({
      capabilities: [
        createRuntimeTestCapability({
          id: 'memory.required_source_refs_runtime',
          displayName: 'Required source refs runtime',
          requiredForTurn: true,
          sourceReferencesRequired: true,
          beforeRoleModelCall() {
            return {
              contextItems: [
                createRuntimeTestContextItem({
                  capabilityId: 'memory.required_source_refs_runtime',
                  sourceReferences: []
                })
              ],
              runtimeNotes: [],
              evidence: []
            };
          }
        })
      ]
    });

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'hello',
        'evt_required_source_refs',
        'trace_required_source_refs'
      ),
      session,
      logStore,
      capabilityHost,
      roleModelAdapter: {
        invoke() {
          adapterCalls += 1;
          return {
            rawOutputText: JSON.stringify({
              version: roleModelDecisionContractVersion,
              toolCalls: [
                {
                  name: roleModelVisibleReplyActionName,
                  input: {
                    text: 'should not commit'
                  }
                }
              ]
            })
          };
        }
      }
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: runtimeCapabilityBeforeRoleModelCallRejectionReason
    });
    expect(adapterCalls).toBe(0);
    expect(session.visibleTranscript).toEqual([]);
    expect(logStore.conversationMessages()).toEqual([]);
    expect(result.rawEvent.agentCapabilityEvidence).toMatchObject([
      {
        capabilityId: 'memory.required_source_refs_runtime',
        status: 'rejected',
        policyOutcome: 'required_rejected'
      }
    ]);
  });

  it('runs after-commit hooks after visible commit evidence and keeps accepted turns on failure', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    let observedRawKindsDuringAfter: readonly RawEventLogRecordKind[] = [];
    let observedCommittedVisibleMessageIds: readonly string[] = [];
    let observedCommittedVisibleTexts: readonly string[] = [];
    const capabilityHost = createRuntimeCapabilityHost({
      capabilities: [
        createRuntimeTestCapability({
          id: 'memory.after_runtime',
          displayName: 'After runtime hook',
          afterTurnCommitted(context) {
            observedRawKindsDuringAfter = logStore
              .rawEvents()
              .map((record) => record.kind);
            observedCommittedVisibleMessageIds =
              context.committedTurn.visibleMessageIds;
            observedCommittedVisibleTexts =
              context.committedTurn.visibleMessages.map((message) => message.text);
            throw new Error('capture unavailable');
          }
        })
      ]
    });

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'hello',
        'evt_after_failure',
        'trace_after_failure'
      ),
      session,
      logStore,
      capabilityHost,
      roleModelAdapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'committed before capture'
              }
            }
          ]
        })
      )
    });

    expect(result.status).toBe('completed');

    if (result.status !== 'completed') {
      throw new Error('Expected completed runtime result.');
    }

    expect(observedRawKindsDuringAfter).toEqual([
      'runtime_event_received',
      'runtime_event_normalized',
      'visible_reply_committed'
    ]);
    expect(observedCommittedVisibleMessageIds).toHaveLength(2);
    expect(observedCommittedVisibleTexts).toEqual([
      'hello',
      'committed before capture'
    ]);
    expect(session.visibleTranscript.map((message) => message.text)).toEqual([
      'hello',
      'committed before capture'
    ]);
    expect(result.rawEvent.agentCapabilityEvidence).toMatchObject([
      {
        capabilityId: 'memory.after_runtime',
        evidenceKind: 'after_turn_committed',
        status: 'failed',
        policyOutcome: 'after_commit_failed'
      }
    ]);
  });

  it('persists full capability turn evidence with listings and context items', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const capabilityHost = createRuntimeCapabilityHost({
      capabilities: [
        createRuntimeTestCapability({
          id: 'memory.context_runtime',
          displayName: 'Runtime context capability',
          beforeRoleModelCall(context) {
            return {
              contextItems: [
                createRuntimeTestContextItem({
                  capabilityId: 'memory.context_runtime'
                })
              ],
              runtimeNotes: ['memory context injected'],
              evidence: [
                createAgentCapabilityEvidenceSnapshot({
                  eventId: context.eventId,
                  traceId: context.traceId,
                  createdAt: context.timestamp,
                  kind: 'agent_capability_evidence_snapshot',
                  capabilityId: 'memory.context_runtime',
                  evidenceKind: 'before_role_model_call',
                  status: 'accepted',
                  summary: 'memory context accepted',
                  policyOutcome: 'available_for_turn',
                  redactionLabels: []
                })
              ]
            };
          }
        })
      ]
    });

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'remember',
        'evt_capability_turn_evidence',
        'trace_capability_turn_evidence'
      ),
      session,
      logStore,
      capabilityHost,
      roleModelAdapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'I found context.'
              }
            }
          ]
        })
      )
    });

    expect(result.status).toBe('completed');

    if (result.status !== 'completed') {
      throw new Error('Expected completed runtime result.');
    }

    const turnEvidence = result.rawEvent.agentCapabilityTurnEvidence;

    expect(turnEvidence).toMatchObject({
      contractVersion: agentCapabilityContractVersion,
      contextItems: [
        {
          capabilityId: 'memory.context_runtime',
          text: 'Remembered runtime context.'
        }
      ]
    });
    expect(turnEvidence?.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: 'memory.context_runtime',
          enabled: true,
          availableForTurn: true
        })
      ])
    );
    expect(turnEvidence?.contextItems[0]?.sourceReferences).toEqual([
      {
        kind: 'memory',
        id: 'mem_runtime'
      }
    ]);
    expect(turnEvidence?.evidence).toEqual(result.rawEvent.agentCapabilityEvidence);
  });

  it('records returned degraded capability health evidence in completed turn evidence', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const capabilityHost = createRuntimeCapabilityHost({
      capabilities: [
        createRuntimeTestCapability({
          id: 'memory.health_completed_runtime',
          displayName: 'Completed runtime health capability',
          beforeRoleModelCall(context) {
            return {
              contextItems: [],
              runtimeNotes: [],
              evidence: [
                createAgentCapabilityEvidenceSnapshot({
                  eventId: context.eventId,
                  traceId: context.traceId,
                  createdAt: context.timestamp,
                  kind: 'agent_capability_evidence_snapshot',
                  capabilityId: 'memory.health_completed_runtime',
                  evidenceKind: 'before_role_model_call',
                  status: 'accepted',
                  summary: 'context hook accepted',
                  policyOutcome: 'available_for_turn',
                  redactionLabels: []
                })
              ]
            };
          },
          health(context) {
            return {
              capabilityId: 'memory.health_completed_runtime',
              status: 'degraded',
              checkedAt: context.timestamp,
              summary: 'memory health degraded',
              redactionLabels: []
            };
          }
        })
      ]
    });

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'health',
        'evt_health_completed',
        'trace_health_completed'
      ),
      session,
      logStore,
      capabilityHost,
      roleModelAdapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'health recorded'
              }
            }
          ]
        })
      )
    });

    expect(result.status).toBe('completed');

    if (result.status !== 'completed') {
      throw new Error('Expected completed runtime result.');
    }

    const turnEvidence = result.rawEvent.agentCapabilityTurnEvidence;

    expect(result.rawEvent.agentCapabilityEvidence).toMatchObject([
      {
        capabilityId: 'memory.health_completed_runtime',
        evidenceKind: 'before_role_model_call',
        status: 'accepted',
        summary: 'context hook accepted'
      },
      {
        capabilityId: 'memory.health_completed_runtime',
        evidenceKind: 'health',
        status: 'degraded',
        summary: 'Capability health degraded: memory health degraded',
        policyOutcome: 'health_degraded'
      }
    ]);
    expect(turnEvidence?.evidence).toEqual(result.rawEvent.agentCapabilityEvidence);
    expect(turnEvidence?.health).toEqual([
      {
        capabilityId: 'memory.health_completed_runtime',
        status: 'degraded',
        checkedAt: '2026-06-04T10:00:00.000Z',
        summary: 'memory health degraded',
        redactionLabels: []
      }
    ]);
    expect(
      turnEvidence?.capabilities.find(
        (capability) =>
          capability.capabilityId === 'memory.health_completed_runtime'
      )
    ).toMatchObject({
      capabilityId: 'memory.health_completed_runtime',
      enabled: true,
      availableForTurn: true,
      healthStatus: 'degraded'
    });
  });

  it('records failed capability health evidence in rejected turn evidence', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const capabilityHost = createRuntimeCapabilityHost({
      capabilities: [
        createRuntimeTestCapability({
          id: 'memory.health_rejected_runtime',
          displayName: 'Rejected runtime health capability',
          beforeRoleModelCall(context) {
            return {
              contextItems: [],
              runtimeNotes: [],
              evidence: [
                createAgentCapabilityEvidenceSnapshot({
                  eventId: context.eventId,
                  traceId: context.traceId,
                  createdAt: context.timestamp,
                  kind: 'agent_capability_evidence_snapshot',
                  capabilityId: 'memory.health_rejected_runtime',
                  evidenceKind: 'before_role_model_call',
                  status: 'accepted',
                  summary: 'context hook survived rejection',
                  policyOutcome: 'available_for_turn',
                  redactionLabels: []
                })
              ]
            };
          },
          health() {
            throw new Error('health fixture unavailable');
          }
        })
      ]
    });

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'health rejection',
        'evt_health_rejected',
        'trace_health_rejected'
      ),
      session,
      logStore,
      capabilityHost,
      roleModelAdapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'line one\nline two'
              }
            }
          ]
        })
      )
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: roleModelInvalidVisibleReplyRejectionReason
    });

    const terminalRejected = findRawEvent(
      result.rawEventLogRecords,
      'runtime_turn_rejected'
    );
    const turnEvidence = terminalRejected.agentCapabilityTurnEvidence;

    expect(terminalRejected.agentCapabilityEvidence).toMatchObject([
      {
        capabilityId: 'memory.health_rejected_runtime',
        evidenceKind: 'before_role_model_call',
        status: 'accepted',
        summary: 'context hook survived rejection'
      },
      {
        capabilityId: 'memory.health_rejected_runtime',
        evidenceKind: 'health',
        status: 'degraded',
        summary: 'Capability health hook failed: health fixture unavailable',
        policyOutcome: 'health_degraded'
      }
    ]);
    expect(turnEvidence?.evidence).toEqual(
      terminalRejected.agentCapabilityEvidence
    );
    expect(turnEvidence?.health).toEqual([
      {
        capabilityId: 'memory.health_rejected_runtime',
        status: 'unavailable',
        checkedAt: '2026-06-04T10:00:00.000Z',
        summary: 'health fixture unavailable',
        redactionLabels: []
      }
    ]);
    expect(
      turnEvidence?.capabilities.find(
        (capability) =>
          capability.capabilityId === 'memory.health_rejected_runtime'
      )
    ).toMatchObject({
      capabilityId: 'memory.health_rejected_runtime',
      healthStatus: 'unavailable'
    });
  });

  it('rejects required health failures before visible output is committed', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    let healthCalls = 0;
    let afterCalls = 0;
    const capabilityHost = createRuntimeCapabilityHost({
      capabilities: [
        createRuntimeTestCapability({
          id: 'memory.health_required_runtime',
          displayName: 'Required runtime health capability',
          healthFailureBehavior: 'reject_turn',
          afterTurnCommitted() {
            afterCalls += 1;

            return {
              status: 'completed',
              evidence: []
            };
          },
          health() {
            healthCalls += 1;
            throw new Error('required health unavailable');
          }
        })
      ]
    });

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'health gate',
        'evt_health_required',
        'trace_health_required'
      ),
      session,
      logStore,
      capabilityHost,
      roleModelAdapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'should not commit'
              }
            }
          ]
        })
      )
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'capability_health_rejected',
      message: 'Capability health hook failed: required health unavailable'
    });
    expect(healthCalls).toBe(1);
    expect(afterCalls).toBe(0);
    expect(session.visibleTranscript).toEqual([]);
    expect(logStore.conversationMessages()).toEqual([]);
    expect(
      logStore
        .rawEvents()
        .some((record) => record.kind === 'visible_reply_committed')
    ).toBe(false);

    const commitRejected = findRawEvent(
      result.rawEventLogRecords,
      'commit_validation_rejected'
    );
    const terminalRejected = findRawEvent(
      result.rawEventLogRecords,
      'runtime_turn_rejected'
    );

    expect(commitRejected.agentCapabilityEvidence).toMatchObject([
      {
        capabilityId: 'memory.health_required_runtime',
        evidenceKind: 'health',
        status: 'failed',
        summary: 'Capability health hook failed: required health unavailable',
        policyOutcome: 'health_degraded'
      }
    ]);
    expect(terminalRejected.agentCapabilityEvidence).toEqual(
      commitRejected.agentCapabilityEvidence
    );
    expect(terminalRejected.agentCapabilityTurnEvidence?.health).toEqual([
      {
        capabilityId: 'memory.health_required_runtime',
        status: 'unavailable',
        checkedAt: '2026-06-04T10:00:00.000Z',
        summary: 'required health unavailable',
        redactionLabels: []
      }
    ]);
    expect(
      terminalRejected.agentCapabilityTurnEvidence?.capabilities.find(
        (capability) =>
          capability.capabilityId === 'memory.health_required_runtime'
      )
    )
      .toMatchObject({
        capabilityId: 'memory.health_required_runtime',
        healthStatus: 'unavailable'
      });
    expect(stepNames(result.traceEntries)).toEqual([
      'runtime_event_received',
      'runtime_event_normalized',
      'runtime_turn_started',
      'commit_validation_rejected',
      'raw_event_log_appended',
      'runtime_turn_rejected'
    ]);
  });

  it('rejects unavailable required health snapshots before visible output is committed', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    let healthCalls = 0;
    let afterCalls = 0;
    const capabilityHost = createRuntimeCapabilityHost({
      capabilities: [
        createRuntimeTestCapability({
          id: 'memory.health_unavailable_runtime',
          displayName: 'Unavailable runtime health capability',
          healthFailureBehavior: 'reject_turn',
          afterTurnCommitted() {
            afterCalls += 1;

            return {
              status: 'completed',
              evidence: []
            };
          },
          health(context) {
            healthCalls += 1;

            return {
              capabilityId: 'memory.health_unavailable_runtime',
              status: 'unavailable',
              checkedAt: context.timestamp,
              summary: 'gateway unavailable',
              redactionLabels: []
            };
          }
        })
      ]
    });

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'health unavailable',
        'evt_health_unavailable',
        'trace_health_unavailable'
      ),
      session,
      logStore,
      capabilityHost,
      roleModelAdapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'should not commit'
              }
            }
          ]
        })
      )
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'capability_health_rejected',
      message: 'Capability health unavailable: gateway unavailable'
    });
    expect(healthCalls).toBe(1);
    expect(afterCalls).toBe(0);
    expect(session.visibleTranscript).toEqual([]);
    expect(logStore.conversationMessages()).toEqual([]);
    expect(
      logStore
        .rawEvents()
        .some((record) => record.kind === 'visible_reply_committed')
    ).toBe(false);

    const commitRejected = findRawEvent(
      result.rawEventLogRecords,
      'commit_validation_rejected'
    );
    const terminalRejected = findRawEvent(
      result.rawEventLogRecords,
      'runtime_turn_rejected'
    );

    expect(commitRejected.agentCapabilityEvidence).toMatchObject([
      {
        capabilityId: 'memory.health_unavailable_runtime',
        evidenceKind: 'health',
        status: 'failed',
        summary: 'Capability health unavailable: gateway unavailable',
        policyOutcome: 'health_degraded'
      }
    ]);
    expect(terminalRejected.agentCapabilityEvidence).toEqual(
      commitRejected.agentCapabilityEvidence
    );
    expect(terminalRejected.agentCapabilityTurnEvidence?.health).toEqual([
      {
        capabilityId: 'memory.health_unavailable_runtime',
        status: 'unavailable',
        checkedAt: '2026-06-04T10:00:00.000Z',
        summary: 'gateway unavailable',
        redactionLabels: []
      }
    ]);
    expect(
      terminalRejected.agentCapabilityTurnEvidence?.capabilities.find(
        (capability) =>
          capability.capabilityId === 'memory.health_unavailable_runtime'
      )
    )
      .toMatchObject({
        capabilityId: 'memory.health_unavailable_runtime',
        healthStatus: 'unavailable'
      });
  });

  it('persists accepted capability tool invocation evidence with the committed turn', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const capabilityHost = createRuntimeCapabilityHost({
      capabilities: [
        createRuntimeTestCapability({
          id: 'memory.tool_runtime',
          displayName: 'Runtime tool capability',
          providedTools: [createRuntimeTestTool('memory.search')],
          handleToolCall(call, context) {
            expect(call).toMatchObject({
              capabilityId: 'memory.tool_runtime',
              toolName: 'memory.search',
              input: {
                query: 'preference'
              }
            });

            return {
              status: 'accepted',
              output: {
                matches: ['Mira prefers concise answers.']
              },
              evidence: [
                createAgentCapabilityEvidenceSnapshot({
                  eventId: context.eventId,
                  traceId: context.traceId,
                  createdAt: context.timestamp,
                  kind: 'agent_capability_evidence_snapshot',
                  capabilityId: 'memory.tool_runtime',
                  evidenceKind: 'tool_invocation',
                  status: 'accepted',
                  summary: 'memory search accepted',
                  sourceReferences: [
                    {
                      kind: 'memory',
                      id: 'mem_tool_runtime'
                    }
                  ],
                  redactionLabels: []
                })
              ]
            };
          }
        })
      ]
    });

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'search memory',
        'evt_capability_tool_accepted',
        'trace_capability_tool_accepted'
      ),
      session,
      logStore,
      capabilityHost,
      roleModelAdapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'I found one memory.'
              }
            },
            {
              name: 'memory.search',
              input: {
                query: 'preference'
              }
            }
          ]
        })
      )
    });

    expect(result.status).toBe('completed');

    if (result.status !== 'completed') {
      throw new Error('Expected completed runtime result.');
    }

    const visibleReplyCommitted = findRawEvent(
      result.rawEventLogRecords,
      'visible_reply_committed'
    );
    const terminalCompleted = findRawEvent(
      result.rawEventLogRecords,
      'runtime_turn_completed'
    );

    expect(visibleReplyCommitted.agentCapabilityEvidence).toMatchObject([
      {
        capabilityId: 'memory.tool_runtime',
        evidenceKind: 'tool_invocation',
        status: 'accepted',
        summary: 'memory search accepted'
      }
    ]);
    expect(terminalCompleted.agentCapabilityEvidence).toEqual(
      visibleReplyCommitted.agentCapabilityEvidence
    );
    expect(terminalCompleted.agentCapabilityTurnEvidence?.toolInvocations).toMatchObject([
      {
        capabilityId: 'memory.tool_runtime',
        toolName: 'memory.search',
        input: {
          query: 'preference'
        },
        result: {
          status: 'accepted',
          output: {
            matches: ['Mira prefers concise answers.']
          },
          evidence: [
            {
              capabilityId: 'memory.tool_runtime',
              evidenceKind: 'tool_invocation',
              status: 'accepted',
              summary: 'memory search accepted'
            }
          ]
        }
      }
    ]);
  });

  it('persists rejected capability tool invocation evidence before visible commit', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const capabilityHost = createRuntimeCapabilityHost({
      capabilities: [
        createRuntimeTestCapability({
          id: 'memory.tool_rejected_runtime',
          displayName: 'Rejected runtime tool capability',
          providedTools: [createRuntimeTestTool('memory.search')],
          handleToolCall(_call, context) {
            return {
              status: 'rejected',
              reason: 'memory_unavailable',
              message: 'memory fixture unavailable',
              evidence: [
                createAgentCapabilityEvidenceSnapshot({
                  eventId: context.eventId,
                  traceId: context.traceId,
                  createdAt: context.timestamp,
                  kind: 'agent_capability_evidence_snapshot',
                  capabilityId: 'memory.tool_rejected_runtime',
                  evidenceKind: 'tool_invocation',
                  status: 'rejected',
                  summary: 'memory fixture unavailable',
                  redactionLabels: []
                })
              ]
            };
          }
        })
      ]
    });

    const result = await runLocalUserMessageEvent({
      event: createTestUserMessageEvent(
        'search memory',
        'evt_capability_tool_rejected',
        'trace_capability_tool_rejected'
      ),
      session,
      logStore,
      capabilityHost,
      roleModelAdapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'I will check.'
              }
            },
            {
              name: 'memory.search',
              input: {
                query: 'preference'
              }
            }
          ]
        })
      )
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: roleModelCapabilityToolRejectedRejectionReason
    });
    expect(session.visibleTranscript).toEqual([]);
    expect(logStore.conversationMessages()).toEqual([]);

    const commitRejected = findRawEvent(
      result.rawEventLogRecords,
      'commit_validation_rejected'
    );
    const terminalRejected = findRawEvent(
      result.rawEventLogRecords,
      'runtime_turn_rejected'
    );

    expect(commitRejected.agentCapabilityEvidence).toMatchObject([
      {
        capabilityId: 'memory.tool_rejected_runtime',
        evidenceKind: 'tool_invocation',
        status: 'rejected',
        summary: 'memory fixture unavailable'
      }
    ]);
    expect(commitRejected.parsedRoleModelDecisionSnapshot?.result.status).toBe(
      'accepted'
    );
    expect(commitRejected.commitValidation?.result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelCapabilityToolRejectedRejectionReason
      }
    });
    expect(terminalRejected.agentCapabilityEvidence).toEqual(
      commitRejected.agentCapabilityEvidence
    );
    expect(terminalRejected.agentCapabilityTurnEvidence?.toolInvocations).toMatchObject([
      {
        capabilityId: 'memory.tool_rejected_runtime',
        toolName: 'memory.search',
        input: {
          query: 'preference'
        },
        result: {
          status: 'rejected',
          reason: 'memory_unavailable',
          message: 'memory fixture unavailable'
        }
      }
    ]);
  });

  it('does not run after-commit hooks for rejected turn paths', async () => {
    const rejectedCases = [
      {
        message: '',
        eventId: 'evt_after_not_input',
        traceId: 'trace_after_not_input'
      },
      {
        message: 'hello',
        eventId: 'evt_after_not_malformed_model',
        traceId: 'trace_after_not_malformed_model',
        roleModelAdapter: createRawOutputAdapter('not json')
      },
      {
        message: 'hello',
        eventId: 'evt_after_not_invalid_reply',
        traceId: 'trace_after_not_invalid_reply',
        roleModelAdapter: createRawOutputAdapter(
          JSON.stringify({
            version: roleModelDecisionContractVersion,
            toolCalls: [
              {
                name: roleModelVisibleReplyActionName,
                input: {
                  text: 'line one\nline two'
                }
              }
            ]
          })
        )
      },
      {
        message: 'hello',
        eventId: 'evt_after_not_invalid_state',
        traceId: 'trace_after_not_invalid_state',
        roleModelAdapter: createRawOutputAdapter(
          JSON.stringify({
            version: roleModelDecisionContractVersion,
            toolCalls: [
              {
                name: roleModelVisibleReplyActionName,
                input: {
                  text: 'invalid state reply'
                }
              },
              {
                name: 'character_state.patch',
                input: {
                  mood: 'ecstatic'
                }
              }
            ]
          })
        )
      }
    ];

    for (const rejectedCase of rejectedCases) {
      const session = createConversationSession();
      const logStore = createRuntimeLogStore();
      let afterCalls = 0;
      const capabilityHost = createRuntimeCapabilityHost({
        capabilities: [
          createRuntimeTestCapability({
            id: `memory.after_not_${rejectedCase.eventId}`,
            displayName: 'After hook not called',
            afterTurnCommitted() {
              afterCalls += 1;

              return {
                status: 'completed',
                evidence: []
              };
            }
          })
        ]
      });

      const result = await runLocalUserMessageEvent({
        event:
          rejectedCase.message.length === 0
            ? Object.freeze({
                eventId: rejectedCase.eventId,
                traceId: rejectedCase.traceId,
                createdAt: '2026-06-04T10:00:00.000Z',
                type: 'USER_MESSAGE',
                payload: Object.freeze({
                  currentUserMessage: rejectedCase.message
                })
              } satisfies UserMessageRuntimeEvent)
            : createTestUserMessageEvent(
                rejectedCase.message,
                rejectedCase.eventId,
                rejectedCase.traceId
              ),
        session,
        logStore,
        capabilityHost,
        ...(rejectedCase.roleModelAdapter === undefined
          ? {}
          : { roleModelAdapter: rejectedCase.roleModelAdapter })
      });

      expect(result.status).toBe('rejected');
      expect(afterCalls).toBe(0);
      expect(session.visibleTranscript).toEqual([]);
      expect(logStore.conversationMessages()).toEqual([]);
      expect(
        logStore
          .rawEvents()
          .some((record) => record.kind === 'visible_reply_committed')
      ).toBe(false);
    }
  });
});

function createRuntimeTestCapability(options: {
  readonly id: string;
  readonly displayName: string;
  readonly requiredForTurn?: boolean;
  readonly sourceReferencesRequired?: boolean;
  readonly timeoutMs?: number;
  readonly providedTools?: readonly unknown[];
  readonly beforeRoleModelCall?: AgentCapabilityLifecycleHooks['beforeRoleModelCall'];
  readonly handleToolCall?: AgentCapabilityLifecycleHooks['handleToolCall'];
  readonly afterTurnCommitted?: AgentCapabilityLifecycleHooks['afterTurnCommitted'];
  readonly health?: AgentCapabilityLifecycleHooks['health'];
  readonly healthFailureBehavior?: 'degrade' | 'reject_turn';
}): AgentCapability {
  return createAgentCapability({
    manifest: {
      id: options.id,
      displayName: options.displayName,
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Local runtime lifecycle test capability.',
      contractVersion: agentCapabilityContractVersion,
      compatibility: {
        hostContractVersions: [agentCapabilityContractVersion],
        sourceSystem: 'project02'
      },
      declaredCapabilities: runtimeTestCapabilityDeclarations(options),
      config: {
        fields: []
      },
      localTrustLevel: 'test_fixture',
      runtimePolicy: {
        requiredForTurn: options.requiredForTurn ?? false,
        sideEffectLevel: 'local_memory_write',
        confirmation: 'not_required',
        timeoutMs: options.timeoutMs ?? 1000,
        sourceReferencesRequired: options.sourceReferencesRequired ?? false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall:
            options.requiredForTurn === true ? 'reject_turn' : 'degrade',
          handleToolCall: 'degrade',
          afterTurnCommitted: 'log_failure',
          health: options.healthFailureBehavior ?? 'degrade'
        }
      },
      activation: {
        defaultEnabled: true,
        reasons: ['local_runtime_test']
      }
    },
    providedTools: options.providedTools ?? [],
    lifecycleHooks: {
      ...(options.beforeRoleModelCall === undefined
        ? {}
        : { beforeRoleModelCall: options.beforeRoleModelCall }),
      ...(options.handleToolCall === undefined
        ? {}
        : { handleToolCall: options.handleToolCall }),
      ...(options.afterTurnCommitted === undefined
        ? {}
        : { afterTurnCommitted: options.afterTurnCommitted }),
      ...(options.health === undefined ? {} : { health: options.health })
    }
  });
}

function runtimeTestCapabilityDeclarations(options: {
  readonly providedTools?: readonly unknown[];
  readonly beforeRoleModelCall?: AgentCapabilityLifecycleHooks['beforeRoleModelCall'];
  readonly handleToolCall?: AgentCapabilityLifecycleHooks['handleToolCall'];
  readonly afterTurnCommitted?: AgentCapabilityLifecycleHooks['afterTurnCommitted'];
  readonly health?: AgentCapabilityLifecycleHooks['health'];
}): readonly string[] {
  const declarations: string[] = [];

  if ((options.providedTools ?? []).length > 0) {
    declarations.push('tool_provider', 'handle_tool_call');
  }

  if (options.beforeRoleModelCall !== undefined) {
    declarations.push('context_provider', 'before_role_model_call');
  }

  if (options.afterTurnCommitted !== undefined) {
    declarations.push('after_turn_committed');
  }

  if (options.health !== undefined) {
    declarations.push('health');
  }

  return Object.freeze(declarations);
}

function createRuntimeTestTool(name: string): unknown {
  return Object.freeze({
    name,
    description: 'Runtime capability test tool.',
    requiredForUserTurn: false,
    maxCallsPerUserTurn: 1,
    inputContract: {
      type: 'object',
      additionalFields: false,
      fields: [
        {
          name: 'query',
          description: 'Search query.',
          required: true,
          valueType: 'string'
        }
      ]
    },
    validationOwner: 'capability_host',
    sideEffectLevel: 'runtime_read',
    requiresConfirmation: false,
    sourceReferencesRequired: true
  });
}

function createRuntimeTestContextItem(options: {
  readonly capabilityId: string;
  readonly sourceReferences?: AgentCapabilityContextItem['sourceReferences'];
}): AgentCapabilityContextItem {
  return {
    capabilityId: options.capabilityId,
    id: `${options.capabilityId}.item_1`,
    kind: 'memory',
    text: 'Remembered runtime context.',
    budget: {
      estimatedTokens: 4,
      priority: 1
    },
    sourceReferences: options.sourceReferences ?? [
      {
        kind: 'memory',
        id: 'mem_runtime'
      }
    ],
    redactionLabels: []
  };
}

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

function findRawEvent(
  records: readonly RawEventLogRecord[],
  kind: RawEventLogRecordKind
): RawEventLogRecord {
  const record = records.find((candidate) => candidate.kind === kind);

  if (record === undefined) {
    throw new Error(`Expected raw event kind: ${kind}.`);
  }

  return record;
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

function createRawOutputAdapter(rawOutputText: string): RoleModelAdapter {
  return {
    invoke() {
      return Object.freeze({
        rawOutputText
      });
    }
  };
}

function createConversationAppendFailingLogStore(
  baseLogStore: RuntimeLogStore
): RuntimeLogStore {
  return Object.freeze({
    appendTrace(entry) {
      return baseLogStore.appendTrace(entry);
    },
    appendRawEvent(record) {
      return baseLogStore.appendRawEvent(record);
    },
    appendConversationMessage() {
      throw new Error('conversation append failed');
    },
    traceEntries() {
      return baseLogStore.traceEntries();
    },
    rawEvents() {
      return baseLogStore.rawEvents();
    },
    conversationMessages() {
      return baseLogStore.conversationMessages();
    }
  } satisfies RuntimeLogStore);
}

function createCompletedRawEventAppendFailingLogStore(
  baseLogStore: RuntimeLogStore
): RuntimeLogStore {
  return Object.freeze({
    appendTrace(entry) {
      return baseLogStore.appendTrace(entry);
    },
    appendRawEvent(record) {
      if (record.kind === 'runtime_turn_completed') {
        throw new Error('completed raw-event append failed');
      }

      return baseLogStore.appendRawEvent(record);
    },
    appendConversationMessage(record) {
      return baseLogStore.appendConversationMessage(record);
    },
    traceEntries() {
      return baseLogStore.traceEntries();
    },
    rawEvents() {
      return baseLogStore.rawEvents();
    },
    conversationMessages() {
      return baseLogStore.conversationMessages();
    }
  } satisfies RuntimeLogStore);
}

function createWriteFailingCharacterStateStore(): CharacterStateStore {
  const delegate = createInMemoryCharacterStateStore();

  return Object.freeze({
    readCurrentState() {
      return delegate.readCurrentState();
    },
    writeCurrentState() {
      throw new Error('state write failed');
    }
  } satisfies CharacterStateStore);
}

function createTempStoreRoot(): string {
  const storeRoot = mkdtempSync(join(tmpdir(), 'project02-local-runtime-'));

  tempStoreRoots.push(storeRoot);
  return storeRoot;
}

async function createCatalogedSession(
  storeRoot: string,
  sessionId: string
): Promise<void> {
  const sessionStore = createLocalRuntimeSessionStore({
    storeRoot,
    now: () => '2026-06-04T10:00:00.000Z'
  });

  await sessionStore.createSession({
    sessionId,
    createdAt: '2026-06-04T10:00:00.000Z',
    updatedAt: '2026-06-04T10:00:00.000Z'
  });
}
