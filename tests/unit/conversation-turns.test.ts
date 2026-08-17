import {describe, expect, it} from 'vitest';

import {conversationTurnsFromRawEvents} from '../../src/runtime/evidence/conversation-history.ts';
import type {RawEventLogRecord} from '../../src/runtime/evidence/records.ts';
import type {VisibleMessage} from '../../src/core/index.ts';

const turnA = {
  eventId: 'evt_a',
  traceId: 'trace_a',
  createdAt: '2026-06-15T00:00:00.000Z',
} as const;
const turnB = {
  eventId: 'evt_b',
  traceId: 'trace_b',
  createdAt: '2026-06-15T00:00:01.000Z',
} as const;

function message(
  id: string,
  role: VisibleMessage['role'],
  text: string,
): VisibleMessage {
  return role === 'user'
    ? {id, role, speakerId: 'local-user', speakerName: 'You', text}
    : {id, role, speakerId: 'mira', speakerName: 'Mira', text};
}

function committed(
  identity: {
    readonly eventId: string;
    readonly traceId: string;
    readonly createdAt: string;
  },
  visibleMessage: VisibleMessage,
  decisionRound?: number,
): RawEventLogRecord {
  return {
    ...identity,
    kind: 'visible_message_committed',
    eventType: 'USER_MESSAGE',
    visibleMessage,
    committedAt: identity.createdAt,
    ...(decisionRound === undefined ? {} : {decisionRound}),
  };
}

describe('conversation turns projected from the session log', () => {
  it('groups a turn as the user message, its finished tool rounds, and final replies', () => {
    const turns = conversationTurnsFromRawEvents([
      {...turnA, kind: 'runtime_event_received', eventType: 'USER_MESSAGE'},
      committed(turnA, message('s:message-1', 'user', 'needs tool')),
      committed(turnA, message('s:message-2', 'character', 'checking'), 1),
      {
        ...turnA,
        kind: 'tool_call_started',
        eventType: 'USER_MESSAGE',
        toolCallId: 'call-1',
        toolRound: 1,
        toolName: 'character_state.patch',
        toolPluginId: 'character-state',
        toolInput: {energy: 'high'},
      },
      {
        ...turnA,
        kind: 'tool_call_started',
        eventType: 'USER_MESSAGE',
        toolCallId: 'call-unfinished',
        toolRound: 1,
        toolName: 'character_state.patch',
        toolPluginId: 'character-state',
        toolInput: {},
      },
      {
        ...turnA,
        kind: 'tool_call_finished',
        eventType: 'USER_MESSAGE',
        toolCallId: 'call-1',
        toolRound: 1,
        toolName: 'character_state.patch',
        toolPluginId: 'character-state',
        toolResult: {status: 'accepted', output: {ok: true}, evidence: []},
      },
      committed(turnA, message('s:message-3', 'character', 'finished'), 2),
      {
        ...turnA,
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed',
      },
    ]);

    expect(turns).toEqual([
      {
        ...turnA,
        userMessage: message('s:message-1', 'user', 'needs tool'),
        toolRounds: [
          {
            round: 1,
            interimReplies: [message('s:message-2', 'character', 'checking')],
            toolCalls: [
              {
                toolCallId: 'call-1',
                pluginId: 'character-state',
                toolName: 'character_state.patch',
                input: {energy: 'high'},
                result: {status: 'accepted', output: {ok: true}},
              },
            ],
          },
        ],
        finalReplies: [message('s:message-3', 'character', 'finished')],
      },
    ]);
  });

  it('skips groups without a user message and keeps a rejected turn as the message alone', () => {
    const turns = conversationTurnsFromRawEvents([
      // A session-end pair records evidence, not conversation.
      {...turnA, kind: 'runtime_event_received', eventType: 'USER_MESSAGE'},
      {
        ...turnA,
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed',
      },
      // A turn the model rejected still committed what the person said.
      {...turnB, kind: 'runtime_event_received', eventType: 'USER_MESSAGE'},
      committed(turnB, message('s:message-4', 'user', 'anyone there?')),
      {
        ...turnB,
        kind: 'runtime_turn_rejected',
        eventType: 'USER_MESSAGE',
        status: 'rejected',
      },
    ]);

    expect(turns).toEqual([
      {
        ...turnB,
        userMessage: message('s:message-4', 'user', 'anyone there?'),
        toolRounds: [],
        finalReplies: [],
      },
    ]);
  });
});
