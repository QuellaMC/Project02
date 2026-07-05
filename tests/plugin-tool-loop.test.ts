import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createConversationSession
} from '../src/core/conversation.ts';
import {
  characterStatePluginId
} from '../src/plugins/builtin/character-state/index.ts';
import {
  createRuntimePluginFileStore
} from '../src/plugins/file-store.ts';
import {
  createRuntimePluginHost,
  runtimePluginDiscoveryPluginId
} from '../src/plugins/host.ts';
import {
  createRuntimePlugin,
  createRuntimePluginAfterTurnCommittedContext,
  createRuntimePluginEvidenceSnapshot,
  runtimePluginContractVersion
} from '../src/plugins/types.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent
} from '../src/runtime/event.ts';
import {
  createFileRuntimeLogStore
} from '../src/runtime/storage/file-runtime-log-store.ts';
import {
  createLocalRuntimeSessionStore
} from '../src/runtime/storage/session-store.ts';
import {
  createRuntimeLogStore
} from '../src/runtime/log.ts';
import type {
  RuntimeLogStore
} from '../src/runtime/log.ts';
import {
  roleModelInvalidVisibleReplyRejectionReason
} from '../src/role-model/contracts.ts';
import {
  runLocalUserMessageEvent
} from '../src/runtime/local.ts';
import type {
  RoleModelAdapter
} from '../src/role-model/loop.ts';
import type {
  RoleModelChatMessage
} from '../src/role-model/prompt.ts';

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
      toolCallId:
        'evt_plugin_patch.trace_evt_plugin_patch.round-1.1.character_state.patch',
      toolName: 'character_state.patch',
      toolPluginId: 'character-state',
      toolInput: {
        mood: 'curious'
      }
    });
    expect(toolEvents[1]).toMatchObject({
      toolCallId:
        'evt_plugin_patch.trace_evt_plugin_patch.round-1.1.character_state.patch',
      toolName: 'character_state.patch',
      toolPluginId: 'character-state',
      toolResult: {
        status: 'accepted'
      }
    });
    expect(toolEvents[1]).not.toHaveProperty('pluginStoreRevision');
    const terminalEvent = rawEvents.find(
      (event) => event.kind === 'runtime_turn_completed'
    );

    expect(terminalEvent).toMatchObject({
      kind: 'runtime_turn_completed',
      toolCallIds: [
        'evt_plugin_patch.trace_evt_plugin_patch.round-1.1.character_state.patch'
      ]
    });
    const observations =
      terminalEvent?.roleModelIOSnapshot?.inputEnvelope.toolObservations ?? [];

    expect(observations).toHaveLength(1);
    expect(observations[0]?.round).toBe(1);
    expect(observations[0]?.pluginId).toBe('character-state');
    expect(observations[0]?.toolName).toBe('character_state.patch');
    expect(observations[0]?.result.status).toBe('accepted');
  });

  it('persists role-model evidence on tool-authorizing rounds without interim replies', async () => {
    const sessionId = 'session-tool-round-evidence';
    const {
      session,
      logStore,
      storeRoot
    } = await createDurableCharacterStateHarness(sessionId);
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
      event: createTestEvent('hello', 'evt_tool_round_evidence'),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    expect(result.status).toBe('completed');

    const reopenedLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    });
    const reopenedRawEvents = reopenedLogStore.rawEvents();
    const toolStartEvents = reopenedRawEvents.filter(
      (event) => event.kind === 'tool_call_started'
    );
    const toolStartEvent = toolStartEvents[0];

    expect(toolStartEvents).toHaveLength(1);

    if (toolStartEvent === undefined) {
      throw new Error('Expected tool_call_started evidence.');
    }

    expect(toolStartEvent).toMatchObject({
      toolCallId:
        'evt_tool_round_evidence.trace_evt_tool_round_evidence.round-1.1.character_state.patch',
      toolRound: 1,
      roleModelIOSnapshot: {
        inputEnvelope: {
          toolObservations: []
        }
      },
      parsedRoleModelDecisionSnapshot: {
        result: {
          status: 'accepted',
          decision: {
            toolCalls: [
              {
                name: 'character_state.patch',
                input: {
                  mood: 'curious'
                }
              }
            ]
          }
        }
      }
    });
    expect(toolStartEvent.roleModelIOSnapshot?.rawOutputText).toContain(
      'character_state.patch'
    );
    expect(toolStartEvent.commitValidation).toBeUndefined();

    const terminalEvent = reopenedRawEvents.find(
      (event) => event.kind === 'runtime_turn_completed'
    );

    expect(terminalEvent?.roleModelIOSnapshot?.rawOutputText).toContain(
      'visible_reply'
    );
    expect(terminalEvent?.roleModelIOSnapshot?.rawOutputText).not.toContain(
      'character_state.patch'
    );
  });

  it('persists repeated same tool calls across separate durable turns', async () => {
    const sessionId = 'session-repeated-tool-turns';
    const {
      session,
      logStore,
      storeRoot
    } = await createDurableCharacterStateHarness(sessionId);

    for (const eventId of ['evt_repeated_tool_first', 'evt_repeated_tool_second']) {
      const result = await runLocalUserMessageEvent({
        event: createTestEvent('update state', eventId),
        session,
        logStore,
        roleModelAdapter: createSequencedAdapter([
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
                  text: `state updated for ${eventId}`
                }
              }
            ]
          }
        ])
      });

      expect(result.status).toBe('completed');
    }

    const reopenedLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    });
    const toolStartIds = reopenedLogStore
      .rawEvents()
      .filter((event) => event.kind === 'tool_call_started')
      .map((event) => event.toolCallId);

    expect(toolStartIds).toEqual([
      'evt_repeated_tool_first.trace_evt_repeated_tool_first.round-1.1.character_state.patch',
      'evt_repeated_tool_second.trace_evt_repeated_tool_second.round-1.1.character_state.patch'
    ]);
  });

  it('lets the model retry character_state.patch after invalid input', async () => {
    const {
      session,
      logStore,
      pluginStore
    } = await createDurableCharacterStateHarness(
      'session-plugin-patch-invalid-retry'
    );
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'character_state.patch',
            input: {
              activity: 'reflecting'
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'character_state.patch',
            input: {
              currentActivity: 'reflecting'
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'state corrected'
            }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('correct state', 'evt_plugin_patch_invalid_retry'),
      session,
      logStore,
      roleModelAdapter: adapter
    });
    const toolFinishedEvents = logStore
      .rawEvents()
      .filter((event) => event.kind === 'tool_call_finished');

    expect(result.status).toBe('completed');
    expect(toolFinishedEvents).toHaveLength(2);
    expect(toolFinishedEvents[0]).toMatchObject({
      toolName: 'character_state.patch',
      toolResult: {
        status: 'rejected',
        reason: 'invalid_input'
      }
    });
    expect(toolFinishedEvents[1]).toMatchObject({
      toolName: 'character_state.patch',
      toolResult: {
        status: 'accepted'
      }
    });
    expect(pluginStore.readJsonl('events.jsonl')).toHaveLength(1);
    expect(pluginStore.readJson('current.json')).toMatchObject({
      current: {
        currentActivity: 'reflecting'
      }
    });
  });

  it('persists character_state.patch during handleToolCall', async () => {
    const {
      session,
      logStore,
      pluginStore
    } = await createDurableCharacterStateHarness(
      'session-plugin-patch-accepted'
    );
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
      event: createTestEvent('hello', 'evt_plugin_patch_accepted'),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    expect(result.status).toBe('completed');
    expect(pluginStore.readJsonl('events.jsonl')).toHaveLength(1);
    expect(pluginStore.readJson('current.json')).toMatchObject({
      current: {
        mood: 'curious'
      }
    });
  });

  it('keeps character_state.patch when a later commit validation rejects the turn', async () => {
    const {
      session,
      logStore,
      pluginStore
    } = await createDurableCharacterStateHarness(
      'session-plugin-patch-rejected'
    );
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
              text: ''
            }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_plugin_patch_rejected'),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'invalid_visible_reply'
    });
    expect(logStore.conversationMessages()).toEqual([]);
    expect(pluginStore.readJsonl('events.jsonl')).toHaveLength(1);
    expect(pluginStore.readJson('current.json')).toMatchObject({
      current: {
        mood: 'curious'
      }
    });
  });

  it('isolates default in-memory Character State by session object', async () => {
    const firstSession = createConversationSession();
    const firstLogStore = createRuntimeLogStore();
    const firstAdapter = createSequencedAdapter([
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
              text: 'first updated'
            }
          }
        ]
      }
    ]);

    await runLocalUserMessageEvent({
      event: createTestEvent('first session', 'evt_session_isolation_first'),
      session: firstSession,
      logStore: firstLogStore,
      roleModelAdapter: firstAdapter
    });

    const secondSession = createConversationSession();
    const secondLogStore = createRuntimeLogStore();
    const messagesByRound: RoleModelChatMessage[][] = [];
    const secondAdapter: RoleModelAdapter = Object.freeze({
      invoke(_inputEnvelope, invocation) {
        messagesByRound.push([...invocation.turnContext.messages]);

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'visible_reply',
                input: {
                  text: 'second fresh'
                }
              }
            ]
          })
        };
      }
    });

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('second session', 'evt_session_isolation_second'),
      session: secondSession,
      logStore: secondLogStore,
      roleModelAdapter: secondAdapter
    });
    const firstUserMessage = messagesByRound[0]?.find(
      (message) => message.role === 'user'
    );

    expect(result.status).toBe('completed');
    expect(firstUserMessage?.content).toContain('mood=steady');
    expect(firstUserMessage?.content).not.toContain('mood=curious');
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

    if (result.status !== 'completed') {
      throw new Error('Expected text-only turn to complete.');
    }

    const optionalTurn: typeof result.turn = undefined;

    expect(optionalTurn).toBeUndefined();
    expect(result).not.toHaveProperty('turn');
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

  it('commits multi-line final visible replies', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'I can use:\n- plugin.list\n- character_state.patch'
            }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('list tools', 'evt_multiline_visible'),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    expect(result.status).toBe('completed');
    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'list tools',
      'I can use:\n- plugin.list\n- character_state.patch'
    ]);
  });

  it('rolls back visible session messages when conversation log append fails', async () => {
    const session = createConversationSession();
    const logStore = createConversationAppendFailingLogStore();
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'this should not remain in memory'
            }
          }
        ]
      }
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent('hello', 'evt_conversation_append_fails'),
        session,
        logStore,
        roleModelAdapter: adapter
      })
    ).rejects.toThrow('conversation append failed');
    expect(session.visibleTranscript).toEqual([]);
    expect(logStore.conversationMessages()).toEqual([]);
  });

  it('removes a durable user row when paired character append fails', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-log-store-'));
    const sessionId = 'session-character-append-fails';
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z'
    });
    const fileLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    });
    const logStore = createCharacterAppendFailingLogStore(fileLogStore);
    const session = createConversationSession({ id: sessionId });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'this should not leave an unmatched user row'
            }
          }
        ]
      }
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent('hello', 'evt_character_append_fails'),
        session,
        logStore,
        roleModelAdapter: adapter
      })
    ).rejects.toThrow('character append failed');

    const reopenedLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    });

    expect(session.visibleTranscript).toEqual([]);
    expect(reopenedLogStore.conversationMessages()).toEqual([]);
    expect(reopenedLogStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected'
    });
  });

  it('runs afterTurnCommitted after visible messages and terminal evidence commit', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    let visibleMessagesVisibleToHook = false;
    let terminalEventVisibleToHook = false;
    const pluginHost = createAfterTurnCommittedProbeHost(() => {
      visibleMessagesVisibleToHook = logStore.conversationMessages().length === 2;
      terminalEventVisibleToHook = logStore
        .rawEvents()
        .some((event) => event.kind === 'runtime_turn_completed');
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'terminal evidence comes first'
            }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_after_commit_order'),
      session,
      logStore,
      roleModelAdapter: adapter,
      pluginHost
    });

    expect(result.status).toBe('completed');
    expect(visibleMessagesVisibleToHook).toBe(true);
    expect(terminalEventVisibleToHook).toBe(true);
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed'
    });
  });

  it('persists afterTurnCommitted failures as follow-up turn evidence', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const pluginHost = createAfterTurnCommittedProbeHost(() => {}, {
      status: 'failed',
      summary: 'After commit fixture failed.'
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'after commit evidence is durable'
            }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_after_commit_failure'),
      session,
      logStore,
      roleModelAdapter: adapter,
      pluginHost
    });
    const terminalEvent = logStore.rawEvents().find(
      (event) => event.kind === 'runtime_turn_completed'
    );
    const afterCommitEvent = logStore.rawEvents().at(-1);

    expect(result.status).toBe('completed');
    expect(result.rawEvent).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed'
    });
    expect(terminalEvent).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed'
    });
    expect(afterCommitEvent).toMatchObject({
      kind: 'after_turn_committed',
      status: 'completed_with_failures',
      runtimePluginEvidence: [
        {
          pluginId: 'after-commit.fixture',
          evidenceKind: 'after_turn_committed',
          status: 'failed',
          summary: 'After commit fixture failed.'
        }
      ]
    });
  });

  it('keeps the completed turn when afterTurnCommitted evidence append fails', async () => {
    const session = createConversationSession();
    const logStore = createAfterTurnCommittedAppendFailingLogStore();
    const pluginHost = createAfterTurnCommittedProbeHost(() => {}, {
      status: 'failed',
      summary: 'After commit fixture failed after terminal commit.'
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'terminal commit survives after hook log failure'
            }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_after_commit_append_failure'),
      session,
      logStore,
      roleModelAdapter: adapter,
      pluginHost
    });

    expect(result.status).toBe('completed');
    expect(result.rawEvent).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed'
    });
    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'hello',
      'terminal commit survives after hook log failure'
    ]);
    expect(
      logStore
        .rawEvents()
        .filter(
          (event) =>
            event.kind === 'runtime_turn_completed' ||
            event.kind === 'runtime_turn_rejected'
        )
        .map((event) => event.kind)
    ).toEqual(['runtime_turn_completed']);
    expect(
      logStore.rawEvents().some((event) => event.kind === 'after_turn_committed')
    ).toBe(false);
  });

  it('does not run afterTurnCommitted when terminal raw event append fails', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeTurnCompletedAppendFailingLogStore();
    let afterTurnCommittedCalls = 0;
    const pluginHost = createAfterTurnCommittedProbeHost(() => {
      afterTurnCommittedCalls += 1;
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'terminal append should fail first'
            }
          }
        ]
      }
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent('hello', 'evt_terminal_append_fails'),
        session,
        logStore,
        roleModelAdapter: adapter,
        pluginHost
      })
    ).rejects.toThrow('terminal raw event append failed');
    expect(afterTurnCommittedCalls).toBe(0);
    expect(session.visibleTranscript.map((message) => message.text)).toEqual([
      'hello',
      'terminal append should fail first'
    ]);
    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'hello',
      'terminal append should fail first'
    ]);
    expect(logStore.rawEvents().some((event) => event.kind === 'runtime_turn_completed')).toBe(
      false
    );
    const visibleMessageIds = logStore
      .conversationMessages()
      .map((message) => message.id);

    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      visibleMessageIds
    });
  });

  it('keeps durable visible-reply evidence valid when terminal raw event append fails', async () => {
    const sessionId = 'session-terminal-append-visible-reply-evidence';
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-plugin-loop-'));

    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z'
    });

    const fileLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    });
    const logStore = createRuntimeTurnCompletedAppendFailingLogStore(fileLogStore);
    const pluginHost = createRuntimePluginHost({ plugins: [] });
    const session = createConversationSession({ id: sessionId });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'terminal append fails after visible evidence'
            }
          }
        ]
      }
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent('hello', 'evt_terminal_append_visible_evidence'),
        session,
        logStore,
        roleModelAdapter: adapter,
        pluginHost
      })
    ).rejects.toThrow('terminal raw event append failed');

    const reopenedLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    });
    const conversationMessages = reopenedLogStore.conversationMessages();
    const visibleMessageIds = conversationMessages.map((message) => message.id);
    const rawEvents = reopenedLogStore.rawEvents();

    expect(conversationMessages.map((message) => message.text)).toEqual([
      'hello',
      'terminal append fails after visible evidence'
    ]);
    expect(
      rawEvents
        .filter(
          (event) =>
            event.kind === 'runtime_turn_completed' ||
            event.kind === 'runtime_turn_rejected'
        )
        .map((event) => event.kind)
    ).toEqual(['runtime_turn_rejected']);
    expect(
      rawEvents.find((event) => event.kind === 'visible_reply_committed')
        ?.visibleMessageIds
    ).toEqual(visibleMessageIds);
    expect(rawEvents.at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      visibleMessageIds
    });

    const restoredSession = createConversationSession({
      id: sessionId,
      visibleTranscript: conversationMessages
    });
    const followupResult = await runLocalUserMessageEvent({
      event: createTestEvent('again', 'evt_terminal_append_followup'),
      session: restoredSession,
      logStore: reopenedLogStore,
      pluginHost,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'followup after rejection evidence'
              }
            }
          ]
        }
      ])
    });

    expect(followupResult.status).toBe('completed');
    expect(reopenedLogStore.conversationMessages().map((message) => message.text)).toEqual([
      'hello',
      'terminal append fails after visible evidence',
      'again',
      'followup after rejection evidence'
    ]);
  });

  it('keeps immediate handleToolCall fileStore writes when finish logging fails', async () => {
    const sessionId = 'session-tool-finish-log-failure';
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-plugin-loop-'));

    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z'
    });

    const session = createConversationSession({ id: sessionId });
    const logStore = createToolCallFinishedAppendFailingLogStore(
      createFileRuntimeLogStore({
        storeRoot,
        sessionId
      })
    );
    const pluginHost = createRuntimePluginHost({
      storeRoot,
      sessionId,
      plugins: [createHandleFileStoreWritePlugin()],
      enabledPluginIds: [runtimePluginDiscoveryPluginId, handleFileStoreWritePluginId]
    });
    const pluginStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId: handleFileStoreWritePluginId
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: handleFileStoreWriteToolName,
            input: {
              value: 'side effect'
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'finish logging should fail first'
            }
          }
        ]
      }
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent('write memory', 'evt_tool_finish_append_fails'),
        session,
        logStore,
        roleModelAdapter: adapter,
        pluginHost
      })
    ).rejects.toThrow('tool_call_finished raw event append failed');

    expect(pluginStore.readJson('state.json')).toEqual({ value: 'side effect' });
    expect(logStore.rawEvents().some((event) => event.kind === 'tool_call_finished')).toBe(
      false
    );
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected'
    });
  });

  it('keeps immediate handleToolCall fileStore writes after a rejected terminal turn', async () => {
    const sessionId = 'session-staged-write-rejected-terminal';
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-plugin-loop-'));

    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z'
    });

    const session = createConversationSession({ id: sessionId });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    });
    const pluginHost = createRuntimePluginHost({
      storeRoot,
      sessionId,
      plugins: [createHandleFileStoreWritePlugin()],
      enabledPluginIds: [runtimePluginDiscoveryPluginId, handleFileStoreWritePluginId]
    });
    const pluginStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId: handleFileStoreWritePluginId
    });
    const event = createUserMessageRuntimeEvent(
      'write memory',
      createRuntimeEventIdentity({
        eventId: 'evt_staged_write_rejected_terminal',
        traceId: 'trace_staged_write_rejected_terminal',
        createdAt: '2026-06-15T00:00:00.000Z'
      })
    );
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: handleFileStoreWriteToolName,
            input: {
              value: 'stale side effect'
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: ''
            }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event,
      session,
      logStore,
      roleModelAdapter: adapter,
      pluginHost
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'invalid_visible_reply'
    });
    expect(pluginStore.readJson('state.json')).toEqual({
      value: 'stale side effect'
    });

    await pluginHost.afterTurnCommitted(
      createRuntimePluginAfterTurnCommittedContext({
        eventId: event.eventId,
        traceId: event.traceId,
        createdAt: event.createdAt,
        sessionId,
        eventType: event.type,
        currentUserMessage: event.payload.currentUserMessage,
        character: {
          id: 'mira',
          displayName: 'Mira'
        },
        committedAt: event.createdAt,
        visibleMessages: []
      })
    );

    expect(pluginStore.readJson('state.json')).toEqual({
      value: 'stale side effect'
    });
  });

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

    const firstUserMessage = messagesByRound[0]?.find(
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
    expect(firstUserMessage?.content).toContain(
      '<runtime_context hidden_from_user="true">'
    );
    expect(firstUserMessage?.content).toContain('Character State:');
    expect(firstUserMessage?.content).not.toContain('pluginId');
    expect(firstUserMessage?.content).not.toContain('sourceReferences');
    expect(firstUserMessage?.content).not.toContain('plugin.list');
    expect(firstUserMessage?.content).not.toContain('visible_reply');
    expect(firstUserMessage?.content).not.toContain('character_state.patch');
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

  it('feeds native assistant tool calls back as OpenAI tool result messages', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const messagesByRound: RoleModelChatMessage[][] = [];
    const adapter = createNativePluginListAdapter(messagesByRound);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('what plugins are available?', 'evt_native_tools'),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    expect(result.status).toBe('completed');
    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'what plugins are available?',
      'Plugins are available.'
    ]);
    expect(messagesByRound).toHaveLength(2);
    expect(messagesByRound[0]?.map((message) => message.role)).toEqual([
      'system',
      'user'
    ]);
    expect(messagesByRound[1]?.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool'
    ]);
    expect(messagesByRound[1]?.[2]).toMatchObject({
      role: 'assistant',
      content: 'Checking plugins.',
      tool_calls: [
        {
          id: 'call_plugin_list',
          function: {
            name: 'plugin.list',
            arguments: '{}'
          }
        }
      ]
    });
    expect(messagesByRound[1]?.[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_plugin_list'
    });
    expect(messagesByRound[1]?.[3]?.content).toContain('"toolName":"plugin.list"');
    expect(messagesByRound[1]?.[3]?.content).toContain('"status":"accepted"');
  });

  it('answers every native tool call when visible_reply shares an executable tool round', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const messagesByRound: RoleModelChatMessage[][] = [];
    const adapter =
      createNativeVisibleReplyAndPluginListAdapter(messagesByRound);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('check plugins with progress', 'evt_native_visible_tool'),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    expect(result.status).toBe('completed');
    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'check plugins with progress',
      'Plugins are available after progress.'
    ]);
    expect(messagesByRound).toHaveLength(2);
    expect(messagesByRound[1]?.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'tool'
    ]);
    expect(messagesByRound[1]?.[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_visible_reply',
          function: {
            name: 'visible_reply',
            arguments: '{"text":"Checking plugins."}'
          }
        },
        {
          id: 'call_plugin_list_with_visible',
          function: {
            name: 'plugin.list',
            arguments: '{}'
          }
        }
      ]
    });
    expect(messagesByRound[1]?.[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_visible_reply'
    });
    expect(messagesByRound[1]?.[3]?.content).toContain(
      '"toolName":"visible_reply"'
    );
    expect(messagesByRound[1]?.[4]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_plugin_list_with_visible'
    });
    expect(messagesByRound[1]?.[4]?.content).toContain('"toolName":"plugin.list"');
    expect(messagesByRound[1]?.[4]?.content).toContain('"status":"accepted"');
  });

  it('feeds native tool argument errors back as rejected tool result messages', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const messagesByRound: RoleModelChatMessage[][] = [];
    let index = 0;
    const adapter: RoleModelAdapter = Object.freeze({
      invoke(_inputEnvelope, invocation) {
        messagesByRound.push([...invocation.turnContext.messages]);
        index += 1;

        if (index === 1) {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'plugin.list',
                  input: {}
                }
              ]
            }),
            nativeAssistantMessage: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_bad_args',
                  type: 'function',
                  function: {
                    name: 'plugin.list',
                    arguments: '{"score":1e999}'
                  }
                }
              ]
            },
            nativeToolCallArgumentErrors: [
              {
                executableIndex: 0,
                toolName: 'plugin.list',
                reason: 'invalid_native_tool_arguments',
                message: 'plugin.list arguments must contain finite JSON values.'
              }
            ]
          };
        }

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'visible_reply',
                input: {
                  text: 'Recovered after argument error.'
                }
              }
            ]
          })
        };
      }
    });

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('check plugins after bad args', 'evt_native_bad_args'),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    expect(result.status).toBe('completed');
    expect(messagesByRound).toHaveLength(2);
    expect(messagesByRound[1]?.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool'
    ]);
    expect(messagesByRound[1]?.[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_bad_args'
    });
    expect(messagesByRound[1]?.[3]?.content).toContain('"status":"rejected"');
    expect(messagesByRound[1]?.[3]?.content).toContain(
      '"reason":"invalid_native_tool_arguments"'
    );
    expect(
      logStore.rawEvents().find((event) => event.kind === 'tool_call_finished')
    ).toMatchObject({
      toolName: 'plugin.list',
      toolResult: {
        status: 'rejected',
        reason: 'invalid_native_tool_arguments'
      }
    });
  });

  it('continues after undeclared executable tools return rejected tool results', async () => {
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

    expect(result.status).toBe('completed');
    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'try unknown',
      'continued'
    ]);
    expect(
      logStore.rawEvents().find((event) => event.kind === 'tool_call_finished')
    ).toMatchObject({
      kind: 'tool_call_finished',
      toolName: 'memory.unknown',
      toolResult: {
        status: 'rejected',
        reason: 'tool_not_declared'
      }
    });
  });

  it('logs only valid pluginStoreRevision metadata from accepted tool output', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();
    const pluginHost = createPluginStoreRevisionFixtureHost();
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'revision.zero',
            input: {}
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'revision.valid',
            input: {}
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'revision metadata checked'
            }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('check revisions', 'evt_plugin_store_revision'),
      session,
      logStore,
      roleModelAdapter: adapter,
      pluginHost
    });
    const toolCallFinishedEvents = logStore
      .rawEvents()
      .filter((event) => event.kind === 'tool_call_finished');

    expect(result.status).toBe('completed');
    expect(toolCallFinishedEvents).toHaveLength(2);
    expect(toolCallFinishedEvents[0]).toMatchObject({
      toolName: 'revision.zero'
    });
    expect(toolCallFinishedEvents[0]).not.toHaveProperty(
      'pluginStoreRevision'
    );
    expect(toolCallFinishedEvents[1]).toMatchObject({
      toolName: 'revision.valid',
      pluginStoreRevision: 2
    });
  });

});

function createNativePluginListAdapter(
  messagesByRound: RoleModelChatMessage[][]
): RoleModelAdapter {
  let index = 0;

  return Object.freeze({
    invoke(_inputEnvelope, invocation) {
      messagesByRound.push([...invocation.turnContext.messages]);
      index += 1;

      if (index === 1) {
        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'plugin.list',
                input: {}
              }
            ]
          }),
          nativeAssistantMessage: {
            role: 'assistant',
            content: 'Checking plugins.',
            tool_calls: [
              {
                id: 'call_plugin_list',
                type: 'function',
                function: {
                  name: 'plugin.list',
                  arguments: '{}'
                }
              }
            ]
          }
        };
      }

      return {
        rawOutputText: JSON.stringify({
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'Plugins are available.'
              }
            }
          ]
        })
      };
    }
  } satisfies RoleModelAdapter);
}

function createNativeVisibleReplyAndPluginListAdapter(
  messagesByRound: RoleModelChatMessage[][]
): RoleModelAdapter {
  let index = 0;

  return Object.freeze({
    invoke(_inputEnvelope, invocation) {
      messagesByRound.push([...invocation.turnContext.messages]);
      index += 1;

      if (index === 1) {
        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'visible_reply',
                input: {
                  text: 'Checking plugins.'
                }
              },
              {
                name: 'plugin.list',
                input: {}
              }
            ]
          }),
          nativeAssistantMessage: {
            role: 'assistant',
            content: 'Checking plugins.',
            tool_calls: [
              {
                id: 'call_visible_reply',
                type: 'function',
                function: {
                  name: 'visible_reply',
                  arguments: '{"text":"Checking plugins."}'
                }
              },
              {
                id: 'call_plugin_list_with_visible',
                type: 'function',
                function: {
                  name: 'plugin.list',
                  arguments: '{}'
                }
              }
            ]
          }
        };
      }

      return {
        rawOutputText: JSON.stringify({
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'Plugins are available after progress.'
              }
            }
          ]
        })
      };
    }
  } satisfies RoleModelAdapter);
}

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

function createConversationAppendFailingLogStore(): RuntimeLogStore {
  const logStore = createRuntimeLogStore();

  return Object.freeze({
    appendTrace(entry) {
      return logStore.appendTrace(entry);
    },
    appendRawEvent(record) {
      return logStore.appendRawEvent(record);
    },
    appendConversationMessage() {
      throw new Error('conversation append failed');
    },
    removeConversationMessages(messageIds) {
      logStore.removeConversationMessages(messageIds);
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    }
  } satisfies RuntimeLogStore);
}

function createCharacterAppendFailingLogStore(
  logStore: RuntimeLogStore
): RuntimeLogStore {
  let conversationAppendCount = 0;

  return Object.freeze({
    appendTrace(entry) {
      return logStore.appendTrace(entry);
    },
    appendRawEvent(record) {
      return logStore.appendRawEvent(record);
    },
    appendConversationMessage(record) {
      conversationAppendCount += 1;

      if (conversationAppendCount === 2) {
        throw new Error('character append failed');
      }

      return logStore.appendConversationMessage(record);
    },
    removeConversationMessages(messageIds) {
      logStore.removeConversationMessages(messageIds);
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    }
  } satisfies RuntimeLogStore);
}

function createRuntimeTurnCompletedAppendFailingLogStore(
  logStore: RuntimeLogStore = createRuntimeLogStore()
): RuntimeLogStore {
  return Object.freeze({
    appendTrace(entry) {
      return logStore.appendTrace(entry);
    },
    appendRawEvent(record) {
      if (record.kind === 'runtime_turn_completed') {
        throw new Error('terminal raw event append failed');
      }

      return logStore.appendRawEvent(record);
    },
    appendConversationMessage(record) {
      return logStore.appendConversationMessage(record);
    },
    removeConversationMessages(messageIds) {
      logStore.removeConversationMessages(messageIds);
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    }
  } satisfies RuntimeLogStore);
}

function createAfterTurnCommittedAppendFailingLogStore(): RuntimeLogStore {
  const logStore = createRuntimeLogStore();

  return Object.freeze({
    appendTrace(entry) {
      return logStore.appendTrace(entry);
    },
    appendRawEvent(record) {
      if (record.kind === 'after_turn_committed') {
        throw new Error('after-turn raw event append failed');
      }

      return logStore.appendRawEvent(record);
    },
    appendConversationMessage(record) {
      return logStore.appendConversationMessage(record);
    },
    removeConversationMessages(messageIds) {
      logStore.removeConversationMessages(messageIds);
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    }
  } satisfies RuntimeLogStore);
}

function createToolCallFinishedAppendFailingLogStore(
  logStore: RuntimeLogStore
): RuntimeLogStore {
  return Object.freeze({
    appendTrace(entry) {
      return logStore.appendTrace(entry);
    },
    appendRawEvent(record) {
      if (record.kind === 'tool_call_finished') {
        throw new Error('tool_call_finished raw event append failed');
      }

      return logStore.appendRawEvent(record);
    },
    appendConversationMessage(record) {
      return logStore.appendConversationMessage(record);
    },
    removeConversationMessages(messageIds) {
      logStore.removeConversationMessages(messageIds);
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    }
  } satisfies RuntimeLogStore);
}

const handleFileStoreWritePluginId = 'handle-write.fixture';
const handleFileStoreWriteToolName = 'handle.write';

function createHandleFileStoreWritePlugin() {
  return createRuntimePlugin({
    manifest: {
      id: handleFileStoreWritePluginId,
      displayName: 'Handle Write Fixture',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Test plugin for handleToolCall fileStore writes.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'test'
      },
      declaredPlugins: ['tool_provider', 'handle_tool_call'],
      config: {
        fields: []
      },
      localTrustLevel: 'test_fixture',
      runtimePolicy: {
        requiredForTurn: false,
        sideEffectLevel: 'local_memory_write',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'reject_tool_call',
          afterTurnCommitted: 'log_failure',
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: true,
        reasons: ['test']
      },
      requestedApis: { file_store: 'write', model_input: 'write' }
    },
    providedTools: [
      Object.freeze({
        name: handleFileStoreWriteToolName,
        description: 'Write a test value through the plugin file store.',
        requiredForUserTurn: false,
        maxCallsPerUserTurn: 1,
        inputContract: {
          type: 'object',
          fields: [
            {
              name: 'value',
              description: 'Value to write.',
              required: true
            }
          ],
          additionalFields: false
        },
        validationOwner: 'plugin_host',
        sideEffectLevel: 'local_memory_write',
        requiresConfirmation: false,
        sourceReferencesRequired: false
      })
    ],
    lifecycleHooks: {
      handleToolCall(call, context) {
        if (context.fileStore === undefined) {
          throw new Error('Expected handle write fixture to receive fileStore.');
        }

        context.fileStore.writeJsonAtomic('state.json', {
          value: call.input['value'] ?? 'missing'
        });

        return {
          status: 'accepted',
          output: {
            ok: true,
            pluginStoreRevision: context.fileStore.revision()
          },
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: handleFileStoreWritePluginId,
              evidenceKind: 'tool_invocation',
              status: 'accepted',
              summary: 'Staged handleToolCall fileStore write.',
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
}

function createAfterTurnCommittedProbeHost(
  onAfterTurnCommitted: () => void,
  options: {
    readonly status?: 'completed' | 'failed';
    readonly summary?: string;
  } = {}
) {
  const pluginId = 'after-commit.fixture';

  return createRuntimePluginHost({
    plugins: [
      createRuntimePlugin({
        manifest: {
          id: pluginId,
          displayName: 'After Commit Fixture',
          version: '1.0.0',
          kind: 'memory_provider',
          description: 'Test plugin for after-turn commit ordering.',
          contractVersion: runtimePluginContractVersion,
          compatibility: {
            hostContractVersions: [runtimePluginContractVersion],
            sourceSystem: 'test'
          },
          declaredPlugins: ['after_turn_committed'],
          config: {
            fields: []
          },
          localTrustLevel: 'test_fixture',
          runtimePolicy: {
            requiredForTurn: false,
            sideEffectLevel: 'local_memory_write',
            confirmation: 'not_required',
            timeoutMs: 1000,
            sourceReferencesRequired: false,
            redactionLabels: [],
            failureBehavior: {
              beforeRoleModelCall: 'degrade',
              handleToolCall: 'reject_tool_call',
              afterTurnCommitted: 'log_failure',
              health: 'degrade'
            }
          },
          activation: {
            defaultEnabled: true,
            reasons: ['test']
          },
          requestedApis: {}
        },
        providedTools: [],
        lifecycleHooks: {
          afterTurnCommitted(context) {
            onAfterTurnCommitted();

            if (options.status === 'failed') {
              return {
                status: 'failed',
                evidence: [
                  createRuntimePluginEvidenceSnapshot({
                    eventId: context.eventId,
                    traceId: context.traceId,
                    createdAt: context.timestamp,
                    kind: 'runtime_plugin_evidence_snapshot',
                    pluginId,
                    evidenceKind: 'after_turn_committed',
                    status: 'failed',
                    summary:
                      options.summary ?? 'After commit fixture failed.',
                    redactionLabels: []
                  })
                ]
              };
            }

            return {
              status: 'completed',
              evidence: []
            };
          }
        }
      })
    ],
    enabledPluginIds: [runtimePluginDiscoveryPluginId, pluginId]
  });
}

function createPluginStoreRevisionFixtureHost() {
  const pluginId = 'revision.fixture';

  return createRuntimePluginHost({
    plugins: [
      createRuntimePlugin({
        manifest: {
          id: pluginId,
          displayName: 'Revision Fixture',
          version: '1.0.0',
          kind: 'first_party',
          description: 'Test plugin for tool output revision metadata.',
          contractVersion: runtimePluginContractVersion,
          compatibility: {
            hostContractVersions: [runtimePluginContractVersion],
            sourceSystem: 'test'
          },
          declaredPlugins: ['tool_provider', 'handle_tool_call'],
          config: {
            fields: []
          },
          localTrustLevel: 'test_fixture',
          runtimePolicy: {
            requiredForTurn: false,
            sideEffectLevel: 'runtime_read',
            confirmation: 'not_required',
            timeoutMs: 1000,
            sourceReferencesRequired: false,
            redactionLabels: [],
            failureBehavior: {
              beforeRoleModelCall: 'degrade',
              handleToolCall: 'reject_tool_call',
              afterTurnCommitted: 'log_failure',
              health: 'degrade'
            }
          },
          activation: {
            defaultEnabled: true,
            reasons: ['test']
          },
          requestedApis: { model_input: 'write' }
        },
        providedTools: [
          createRevisionFixtureTool('revision.zero'),
          createRevisionFixtureTool('revision.valid')
        ],
        lifecycleHooks: {
          handleToolCall(call) {
            return {
              status: 'accepted',
              output: {
                pluginStoreRevision:
                  call.toolName === 'revision.valid' ? 2 : 0
              },
              evidence: []
            };
          }
        }
      })
    ],
    enabledPluginIds: [runtimePluginDiscoveryPluginId, pluginId]
  });
}

function createRevisionFixtureTool(name: string) {
  return {
    name,
    description: 'Return plugin store revision metadata.',
    requiredForUserTurn: false,
    maxCallsPerUserTurn: 1,
    inputContract: {
      type: 'object',
      fields: [],
      additionalFields: false
    },
    validationOwner: 'plugin_host',
    sideEffectLevel: 'runtime_read',
    requiresConfirmation: false,
    sourceReferencesRequired: false
  } as const;
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

async function createDurableCharacterStateHarness(sessionId: string) {
  const storeRoot = mkdtempSync(join(tmpdir(), 'project02-plugin-loop-'));

  await createLocalRuntimeSessionStore({ storeRoot }).createSession({
    sessionId,
    createdAt: '2026-06-15T00:00:00.000Z'
  });

  return {
    storeRoot,
    session: createConversationSession({ id: sessionId }),
    logStore: createFileRuntimeLogStore({
      storeRoot,
      sessionId
    }),
    pluginStore: createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId: characterStatePluginId
    })
  };
}
