import { describe, expect, it } from 'vitest';

import {
  createConversationSession
} from '../src/core/conversation.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent
} from '../src/runtime/event.ts';
import {
  createRuntimeLogStore
} from '../src/runtime/log.ts';
import {
  roleModelUnknownToolRejectionReason
} from '../src/role-model/contracts.ts';
import {
  runLocalUserMessageEvent
} from '../src/runtime/local.ts';
import type {
  RoleModelAdapter
} from '../src/role-model/loop.ts';

describe('plugin-driven tool loop', () => {
  it('executes character_state.patch through the built-in plugin and continues', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'character_state.patch',
            input: {
              mood: 'curious'
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'state updated'
            }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_plugin_patch'),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    expect(result.status).toBe('completed');
    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'hello',
      'state updated'
    ]);

    const rawEvents = logStore.rawEvents();
    const toolEvents = rawEvents.filter((event) =>
      event.kind.startsWith('tool_call')
    );

    expect(toolEvents.map((event) => event.kind)).toEqual([
      'tool_call_started',
      'tool_call_finished'
    ]);
    expect(toolEvents[0]).toMatchObject({
      toolCallId: 'round-1.1.character_state.patch',
      toolName: 'character_state.patch',
      toolPluginId: 'character-state',
      toolInput: {
        mood: 'curious'
      }
    });
    expect(toolEvents[1]).toMatchObject({
      toolCallId: 'round-1.1.character_state.patch',
      toolName: 'character_state.patch',
      toolPluginId: 'character-state',
      toolResult: {
        status: 'accepted'
      },
      pluginStoreRevision: 3
    });
    expect(rawEvents.at(-1)).toMatchObject({
      kind: 'runtime_turn_completed',
      toolCallIds: ['round-1.1.character_state.patch']
    });
    const observations =
      rawEvents.at(-1)?.roleModelIOSnapshot?.inputEnvelope.toolObservations ?? [];

    expect(observations).toHaveLength(1);
    expect(observations[0]?.round).toBe(1);
    expect(observations[0]?.pluginId).toBe('character-state');
    expect(observations[0]?.toolName).toBe('character_state.patch');
    expect(observations[0]?.result.status).toBe('accepted');
  });

  it('terminates on top-level text only without committing visible messages', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const adapter = createSequencedAdapter([
      {
        text: 'folded model note',
        toolCalls: []
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('quiet turn', 'evt_text_only'),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    expect(result.status).toBe('completed');
    expect(logStore.conversationMessages()).toEqual([]);
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_completed',
      parsedRoleModelDecisionSnapshot: {
        result: {
          status: 'accepted',
          nonCommittedText: 'folded model note'
        }
      },
      commitValidation: {
        result: {
          status: 'accepted'
        }
      }
    });
    expect(logStore.rawEvents().at(-1)?.visibleMessageIds).toBeUndefined();
  });

  it('shows interim visible_reply before executable tools without committing it', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const progress: unknown[] = [];
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'checking'
            }
          },
          {
            name: 'character_state.patch',
            input: {
              energy: 'high'
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'finished'
            }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('needs tool', 'evt_interim_visible'),
      session,
      logStore,
      roleModelAdapter: adapter,
      onProgress(event) {
        progress.push(event);
      }
    });

    expect(result.status).toBe('completed');
    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'needs tool',
      'finished'
    ]);
    expect(progress).toEqual([
      {
        kind: 'visible_reply',
        final: false,
        text: 'checking'
      },
      {
        kind: 'tool_calls_requested',
        round: 1,
        toolNames: ['character_state.patch']
      },
      {
        kind: 'tool_call_completed',
        round: 1,
        status: 'accepted',
        toolName: 'character_state.patch'
      },
      {
        kind: 'visible_reply',
        final: true,
        text: 'finished'
      }
    ]);
    expect(
      logStore
        .rawEvents()
        .filter((event) => event.kind === 'visible_reply_committed')
        .map((event) => event.visibleMessageIds)
    ).toEqual([undefined, ['local-session:message-1', 'local-session:message-2']]);
  });

  it('rejects undeclared executable tools before plugin routing', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'memory.unknown',
            input: {
              query: 'Mira'
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'continued'
            }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('try unknown', 'evt_unknown_tool'),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: roleModelUnknownToolRejectionReason
    });
    expect(logStore.conversationMessages()).toEqual([]);
    expect(logStore.rawEvents().some((event) => event.kind === 'tool_call_finished')).toBe(false);
  });
});

function createSequencedAdapter(
  decisions: readonly Readonly<Record<string, unknown>>[]
): RoleModelAdapter {
  let index = 0;

  return Object.freeze({
    invoke() {
      const decision = decisions[index] ?? decisions.at(-1);

      if (decision === undefined) {
        throw new Error('Sequenced adapter needs at least one decision.');
      }

      index += 1;
      return {
        rawOutputText: JSON.stringify(decision)
      };
    }
  } satisfies RoleModelAdapter);
}

function createTestEvent(message: string, eventId: string) {
  return createUserMessageRuntimeEvent(
    message,
    createRuntimeEventIdentity({
      eventId,
      traceId: `trace_${eventId}`,
      createdAt: '2026-06-15T00:00:00.000Z'
    })
  );
}
