import { describe, expect, it } from 'vitest';
import { createConversationSession } from '../src/core/conversation.ts';
import {
  characterStatePluginId,
  createCharacterStatePlugin
} from '../src/plugins/builtin/character-state/index.ts';
import { createRuntimePluginFileStore } from '../src/plugins/file-store.ts';
import { createRuntimePluginHost, runtimePluginDiscoveryPluginId } from '../src/plugins/host.ts';
import { firstPartyModelToolsPluginId } from '../src/plugins/types.ts';
import { createRuntimeEventIdentity, createUserMessageRuntimeEvent } from '../src/runtime/event.ts';
import { createFileRuntimeLogStore } from '../src/runtime/storage/file-runtime-log-store.ts';
import { createLocalRuntimeSessionStore } from '../src/runtime/storage/session-store.ts';
import { createRuntimeLogStore } from '../src/runtime/log.ts';
import { runLocalUserMessageEvent } from '../src/runtime/local.ts';
import { createTestTempRoot } from './support/temp-root.ts';
import {
  createAfterTurnCommittedAppendFailingLogStore,
  createAfterTurnCommittedProbeHost,
  createCharacterAppendFailingLogStore,
  createConversationAppendFailingLogStore,
  createHandleFileStoreWritePlugin,
  createOneShotTerminalTraceAppendFailingLogStore,
  createRuntimeTurnCompletedAppendFailingLogStore,
  createRuntimeTurnCompletedAppendThenThrowLogStore,
  createSequencedAdapter,
  createTestEvent,
  createToolCallFinishedAppendFailingLogStore,
  handleFileStoreWritePluginId,
  handleFileStoreWriteToolName
} from './support/plugin-tool-loop-fixtures.ts';

describe('plugin-driven tool loop commit and rollback', () => {
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

  it('discards a prepared Character State patch when conversation append fails', async () => {
    const sessionId = 'session-character-state-conversation-append-fails';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');

    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z'
    });

    const session = createConversationSession({ id: sessionId });
    const logStore = createConversationAppendFailingLogStore(
      createFileRuntimeLogStore({
        storeRoot,
        sessionId
      })
    );
    const pluginHost = createRuntimePluginHost({
      storeRoot,
      sessionId,
      plugins: [createCharacterStatePlugin()],
      enabledPluginIds: [
        runtimePluginDiscoveryPluginId,
        firstPartyModelToolsPluginId,
        characterStatePluginId
      ]
    });
    const pluginStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId: characterStatePluginId
    });

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent(
          'hello',
          'evt_character_state_conversation_append_fails'
        ),
        session,
        logStore,
        pluginHost,
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
                  text: 'the conversation append should fail'
                }
              }
            ]
          }
        ])
      })
    ).rejects.toThrow('conversation append failed');

    expect(pluginStore.readJsonl('events.jsonl')).toEqual([]);
    expect(pluginStore.readJson('checkpoint.json')).toBeUndefined();
  });

  it('removes a durable user row when paired character append fails', async () => {
    const storeRoot = createTestTempRoot('project02-log-store-');
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

  it('reconciles a one-shot terminal trace failure without rejecting the completed turn', async () => {
    const sessionId = 'session-terminal-trace-reconciliation';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');

    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z'
    });

    const fileLogStore = createFileRuntimeLogStore({ storeRoot, sessionId });
    const logStore = createOneShotTerminalTraceAppendFailingLogStore(fileLogStore);
    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_terminal_trace_reconciliation'),
      session: createConversationSession({ id: sessionId }),
      logStore,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'the completed reply survives trace reconciliation'
              }
            }
          ]
        }
      ])
    });
    const reopened = createFileRuntimeLogStore({ storeRoot, sessionId });

    expect(result).toMatchObject({
      status: 'completed',
      turn: {
        reply: {
          text: 'the completed reply survives trace reconciliation'
        }
      }
    });
    expect(result).not.toHaveProperty('postCommitFailures');
    expect(
      reopened
        .rawEvents()
        .filter((record) => record.kind === 'runtime_turn_completed')
    ).toHaveLength(1);
    expect(
      reopened
        .traceEntries()
        .filter(
          (entry) =>
            entry.eventId === 'evt_terminal_trace_reconciliation' &&
            (entry.step === 'raw_event_log_appended' ||
              entry.step === 'runtime_turn_completed')
        )
        .map((entry) => entry.step)
    ).toEqual(['raw_event_log_appended', 'runtime_turn_completed']);
  });

  it('discards a prepared Character State patch when terminal evidence append fails', async () => {
    const sessionId = 'session-character-state-terminal-append-fails';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');

    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z'
    });

    const session = createConversationSession({ id: sessionId });
    const logStore = createRuntimeTurnCompletedAppendFailingLogStore(
      createFileRuntimeLogStore({
        storeRoot,
        sessionId
      })
    );
    const pluginHost = createRuntimePluginHost({
      storeRoot,
      sessionId,
      plugins: [createCharacterStatePlugin()],
      enabledPluginIds: [
        runtimePluginDiscoveryPluginId,
        firstPartyModelToolsPluginId,
        characterStatePluginId
      ]
    });
    const pluginStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId: characterStatePluginId
    });

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent(
          'hello',
          'evt_character_state_terminal_append_fails'
        ),
        session,
        logStore,
        pluginHost,
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
                  text: 'the terminal append should fail'
                }
              }
            ]
          }
        ])
      })
    ).rejects.toThrow('terminal raw event append failed');

    expect(pluginStore.readJsonl('events.jsonl')).toEqual([]);
    expect(pluginStore.readJson('checkpoint.json')).toBeUndefined();
  });

  it('commits a prepared Character State patch when terminal append throws after persisting', async () => {
    const sessionId = 'session-character-state-terminal-append-then-throw';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');

    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z'
    });

    const fileLogStore = createFileRuntimeLogStore({ storeRoot, sessionId });
    const logStore = createRuntimeTurnCompletedAppendThenThrowLogStore(
      fileLogStore
    );
    const pluginHost = createRuntimePluginHost({
      storeRoot,
      sessionId,
      plugins: [createCharacterStatePlugin()],
      enabledPluginIds: [
        runtimePluginDiscoveryPluginId,
        firstPartyModelToolsPluginId,
        characterStatePluginId
      ]
    });
    const pluginStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId: characterStatePluginId
    });

    const result = await runLocalUserMessageEvent({
      event: createTestEvent(
        'hello',
        'evt_character_state_terminal_append_then_throw'
      ),
      session: createConversationSession({ id: sessionId }),
      logStore,
      pluginHost,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'character_state.patch',
              input: { mood: 'curious' }
            }
          ]
        },
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: { text: 'the committed terminal is reconciled' }
            }
          ]
        }
      ])
    });

    expect(result).toMatchObject({
      status: 'completed',
      rawEvent: {
        kind: 'runtime_turn_completed'
      },
      postCommitFailures: [
        'terminal raw event append reported failure after write'
      ]
    });
    expect(pluginStore.readJsonl('events.jsonl')).toHaveLength(1);
    expect(pluginStore.readJson('checkpoint.json')).toMatchObject({
      current: {
        current: {
          mood: 'curious'
        }
      }
    });
    expect(
      fileLogStore
        .rawEvents()
        .filter(
          (event) =>
            event.kind === 'runtime_turn_completed' ||
            event.kind === 'runtime_turn_rejected'
        )
        .map((event) => event.kind)
    ).toEqual(['runtime_turn_completed']);
  });

  it('keeps durable visible-reply evidence valid when terminal raw event append fails', async () => {
    const sessionId = 'session-terminal-append-visible-reply-evidence';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');

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

  it('discards staged handleToolCall fileStore writes when finish logging fails', async () => {
    const sessionId = 'session-tool-finish-log-failure';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');

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
      enabledPluginIds: [
        runtimePluginDiscoveryPluginId,
        firstPartyModelToolsPluginId,
        handleFileStoreWritePluginId
      ]
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

    expect(pluginStore.readJson('state.json')).toBeUndefined();
    expect(logStore.rawEvents().some((event) => event.kind === 'tool_call_finished')).toBe(
      false
    );
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected'
    });
  });

  it('runs precommit health against staged handleToolCall fileStore writes', async () => {
    const sessionId = 'session-staged-write-health-visible';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');

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
      plugins: [
        createHandleFileStoreWritePlugin({
          rejectHealthWhenValue: 'staged side effect'
        })
      ],
      enabledPluginIds: [
        runtimePluginDiscoveryPluginId,
        firstPartyModelToolsPluginId,
        handleFileStoreWritePluginId
      ]
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
              value: 'staged side effect'
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'health should see staged writes'
            }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('write memory', 'evt_staged_write_health_visible'),
      session,
      logStore,
      roleModelAdapter: adapter,
      pluginHost
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_health_rejected'
    });
    expect(pluginStore.readJson('state.json')).toBeUndefined();
  });

  it('discards staged handleToolCall fileStore writes after a rejected terminal turn', async () => {
    const sessionId = 'session-staged-write-rejected-terminal';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');

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
      enabledPluginIds: [
        runtimePluginDiscoveryPluginId,
        firstPartyModelToolsPluginId,
        handleFileStoreWritePluginId
      ]
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
    expect(pluginStore.readJson('state.json')).toBeUndefined();
  });
});
