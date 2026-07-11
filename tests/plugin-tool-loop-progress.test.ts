import { describe, expect, it } from 'vitest';
import { createConversationSession } from '../src/core/conversation.ts';
import { createFileRuntimeLogStore } from '../src/runtime/storage/file-runtime-log-store.ts';
import { createLocalRuntimeSessionStore } from '../src/runtime/storage/session-store.ts';
import { createRuntimeLogStore } from '../src/runtime/log.ts';
import { roleModelInvalidVisibleReplyRejectionReason } from '../src/role-model/contracts.ts';
import { runLocalUserMessageEvent } from '../src/runtime/local.ts';
import type { RoleModelAdapter } from '../src/role-model/loop.ts';
import type { RoleModelChatMessage } from '../src/role-model/prompt.ts';
import { createTestTempRoot } from './support/temp-root.ts';
import {
  createDurableCharacterStateHarness,
  createSequencedAdapter,
  createTestEvent
} from './support/plugin-tool-loop-fixtures.ts';

describe('plugin-driven tool loop progress and evidence', () => {
  it('does not expose plugin inventory through hidden runtime context', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const messagesByRound: RoleModelChatMessage[][] = [];
    const adapter: RoleModelAdapter = Object.freeze({
      invoke(_inputEnvelope, invocation) {
        messagesByRound.push([...invocation.turnContext.messages]);

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'visible_reply',
                input: {
                  text:
                    'I can see callable tools, but I need plugin.list for the canonical plugin inventory.'
                }
              }
            ]
          })
        };
      }
    });

    const result = await runLocalUserMessageEvent({
      event: createTestEvent(
        'what plugins are available?',
        'evt_plugin_context_surface'
      ),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    const runtimeContextMessage = messagesByRound[0]?.find(
      (message) =>
        message.role === 'user' &&
        message.content.includes('Untrusted plugin context')
    );
    const currentUserMessage = messagesByRound[0]?.findLast(
      (message) => message.role === 'user'
    );

    expect(result.status).toBe('completed');
    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'what plugins are available?',
      'I can see callable tools, but I need plugin.list for the canonical plugin inventory.'
    ]);
    expect(logStore.rawEvents().some((event) => event.kind === 'tool_call_started')).toBe(
      false
    );
    expect(currentUserMessage?.content).toBe('what plugins are available?');
    expect(runtimeContextMessage?.content).toContain(
      "Mira's internal Character State"
    );
    expect(runtimeContextMessage?.content).toContain('sourceReferences');
    expect(runtimeContextMessage?.content).not.toContain('plugin.list');
    expect(runtimeContextMessage?.content).not.toContain('visible_reply');
    expect(runtimeContextMessage?.content).not.toContain('character_state.patch');
  });

  it('shows interim visible_reply before executable tools without committing it', async () => {
    const sessionId = 'session-interim-visible-reload';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z'
    });
    const session = createConversationSession({ id: sessionId });
    const logStore = createFileRuntimeLogStore({ storeRoot, sessionId });
    const progress: unknown[] = [];
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'Authorization: Bearer interim-secret'
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
    const reloadedLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    });
    expect(
      reloadedLogStore.conversationMessages().map((message) => message.text)
    ).toEqual(['needs tool', 'finished']);
    expect(progress).toEqual([
      {
        kind: 'visible_reply',
        final: false,
        text: 'Authorization: Bearer interim-secret'
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
    const reloadedRawEvents = reloadedLogStore.rawEvents();
    const serializedEvidence = JSON.stringify({
      rawEvents: reloadedRawEvents,
      traceEntries: reloadedLogStore.traceEntries()
    });

    expect(serializedEvidence).toContain('Authorization: [redacted]');
    expect(serializedEvidence).not.toContain('interim-secret');
    const interimEvent = reloadedRawEvents.find(
      (event) => event.kind === 'interim_visible_reply_emitted'
    );
    expect(interimEvent).toMatchObject({
      kind: 'interim_visible_reply_emitted'
    });
    expect(interimEvent).not.toHaveProperty('visibleMessageIds');
    expect(interimEvent).not.toHaveProperty('commitValidation');
    expect(
      reloadedRawEvents
        .filter((event) => event.kind === 'visible_reply_committed')
        .map((event) => event.visibleMessageIds)
    ).toEqual([
      [`${sessionId}:message-1`, `${sessionId}:message-2`]
    ]);
    expect(
      reloadedLogStore
        .traceEntries()
        .some((entry) => entry.step === 'interim_visible_reply_emitted')
    ).toBe(true);
  });

  it('continues after interim visible_reply progress callback failures', async () => {
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
      event: createTestEvent('needs tool', 'evt_interim_progress_fails'),
      session,
      logStore,
      roleModelAdapter: adapter,
      onProgress(event) {
        progress.push(event);

        if (event.kind === 'visible_reply' && !event.final) {
          throw new Error('interim progress observer failed');
        }
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
      logStore.rawEvents().some((event) => event.kind === 'runtime_turn_rejected')
    ).toBe(false);
  });

  it('keeps durable final visible_reply committed when progress callback fails', async () => {
    const sessionId = 'session-final-progress-fails';
    const {
      session,
      logStore,
      storeRoot
    } = await createDurableCharacterStateHarness(sessionId);
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'final reply'
            }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_final_progress_fails'),
      session,
      logStore,
      roleModelAdapter: adapter,
      onProgress(event) {
        if (event.kind === 'visible_reply' && event.final) {
          throw new Error('final progress observer failed');
        }
      }
    });

    expect(result.status).toBe('completed');
    expect(result.rawEvent).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed'
    });
    expect(
      logStore.rawEvents().some((event) => event.kind === 'runtime_turn_rejected')
    ).toBe(false);

    const reopenedLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    });

    expect(reopenedLogStore.conversationMessages().map((message) => message.text)).toEqual([
      'hello',
      'final reply'
    ]);
    expect(
      reopenedLogStore
        .rawEvents()
        .filter(
          (event) =>
            event.kind === 'runtime_turn_completed' ||
            event.kind === 'runtime_turn_rejected'
        )
        .map((event) => event.kind)
    ).toEqual(['runtime_turn_completed']);

    const restoredSession = createConversationSession({
      id: sessionId,
      visibleTranscript: reopenedLogStore.conversationMessages()
    });
    const followupResult = await runLocalUserMessageEvent({
      event: createTestEvent('again', 'evt_final_progress_followup'),
      session: restoredSession,
      logStore: reopenedLogStore,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'followup reply'
              }
            }
          ]
        }
      ])
    });

    expect(followupResult.status).toBe('completed');
    expect(reopenedLogStore.conversationMessages().map((message) => message.text)).toEqual([
      'hello',
      'final reply',
      'again',
      'followup reply'
    ]);
    expect(
      reopenedLogStore
        .rawEvents()
        .filter(
          (event) =>
            event.kind === 'runtime_turn_completed' ||
            event.kind === 'runtime_turn_rejected'
        )
        .map((event) => event.kind)
    ).toEqual(['runtime_turn_completed', 'runtime_turn_completed']);
  });

  it('preserves role-model evidence when interim visible_reply is invalid', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: '   '
            }
          },
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
              text: 'finished'
            }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('needs invalid interim', 'evt_invalid_interim_visible'),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: roleModelInvalidVisibleReplyRejectionReason
    });
    expect(logStore.conversationMessages()).toEqual([]);
    expect(
      logStore
        .rawEvents()
        .some((event) => event.kind === 'visible_reply_committed')
    ).toBe(false);
    expect(
      logStore.rawEvents().some((event) => event.kind === 'tool_call_started')
    ).toBe(false);

    const rejectionEvents = logStore
      .rawEvents()
      .filter(
        (event) =>
          event.kind === 'commit_validation_rejected' ||
          event.kind === 'runtime_turn_rejected'
      );

    expect(rejectionEvents).toHaveLength(2);

    for (const event of rejectionEvents) {
      expect(event).toMatchObject({
        reason: roleModelInvalidVisibleReplyRejectionReason,
        roleModelIOSnapshot: {
          inputEnvelope: {
            event: {
              payload: {
                currentUserMessage: 'needs invalid interim'
              }
            }
          }
        },
        parsedRoleModelDecisionSnapshot: {
          result: {
            status: 'accepted',
            decision: {
              toolCalls: [
                {
                  name: 'visible_reply',
                  input: {
                    text: '   '
                  }
                },
                {
                  name: 'character_state.patch',
                  input: {
                    mood: 'curious'
                  }
                }
              ]
            }
          }
        },
        commitValidation: {
          sessionId: 'local-session',
          result: {
            status: 'rejected',
            rejection: {
              reason: roleModelInvalidVisibleReplyRejectionReason,
              details: 'Character agent returned an empty reply.'
            }
          }
        }
      });
      expect(event.roleModelIOSnapshot?.rawOutputText).toContain(
        '"visible_reply"'
      );
    }
  });

  it('preserves prior tool evidence when a later interim visible_reply is invalid', async () => {
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
              text: '   '
            }
          },
          {
            name: 'plugin.list',
            input: {}
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent(
        'needs invalid later interim',
        'evt_invalid_later_interim_visible'
      ),
      session,
      logStore,
      roleModelAdapter: adapter
    });
    const rejectionEvents = logStore
      .rawEvents()
      .filter(
        (event) =>
          event.kind === 'commit_validation_rejected' ||
          event.kind === 'runtime_turn_rejected'
      );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: roleModelInvalidVisibleReplyRejectionReason
    });
    expect(rejectionEvents).toHaveLength(2);

    for (const event of rejectionEvents) {
      expect(event).toMatchObject({
        reason: roleModelInvalidVisibleReplyRejectionReason,
        toolCallIds: [
          'evt_invalid_later_interim_visible.trace_evt_invalid_later_interim_visible.round-1.1.character_state.patch'
        ]
      });
      expect(event.runtimePluginEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'character-state',
            evidenceKind: 'tool_invocation',
            status: 'accepted'
          })
        ])
      );
      const characterStateInvocation =
        event.runtimePluginTurnEvidence?.toolInvocations.find(
          (invocation) =>
            invocation.pluginId === 'character-state' &&
            invocation.toolName === 'character_state.patch'
        );

      expect(characterStateInvocation).toMatchObject({
        result: {
          status: 'accepted'
        }
      });
      expect(characterStateInvocation?.result.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'character-state',
            evidenceKind: 'tool_invocation',
            status: 'accepted'
          })
        ])
      );
    }
  });
});
