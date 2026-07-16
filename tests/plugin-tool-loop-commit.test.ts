import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { createConversationSession } from '../src/core/conversation.ts';
import {
  characterStatePluginId,
  createCharacterStatePlugin
} from '../src/plugins/packages/character-state/plugin.ts';
import { createRuntimePluginFileStore } from '../src/plugins/file-store.ts';
import { durablePluginStoreMutationResourceKey } from '../src/plugins/file-store/durable-primitives.ts';
import {
  createRuntimePluginHost,
  type RuntimePluginHost
} from '../src/plugins/host.ts';
import { createRuntimePlugin } from '../src/plugins/constructors.ts';
import { runtimePluginConfigUpdateToolName } from '../src/plugins/contract.ts';
import {
  firstPartyModelToolsPluginId,
  runtimePluginId
} from '../src/plugins/types.ts';
import {
  applyRuntimePluginConfigControlOperation,
  inspectRuntimePluginConfig
} from '../src/runtime/config/index.ts';
import { createRuntimeEventIdentity, createUserMessageRuntimeEvent } from '../src/runtime/event.ts';
import { createFileRuntimeLogStore } from '../src/runtime/storage/file-runtime-log-store.ts';
import {
  createLocalRuntimePluginPaths,
  createLocalRuntimeStorageLayout
} from '../src/runtime/storage/layout.ts';
import { LocalRuntimeMutationLockBusyError } from '../src/runtime/storage/mutation-lock.ts';
import { createLocalRuntimeSessionStore } from '../src/runtime/storage/session-store.ts';
import { createRuntimeLogStore } from '../src/runtime/log.ts';
import type { RoleModelAdapter } from '../src/role-model/loop.ts';
import type { RoleModelChatMessage } from '../src/role-model/prompt.ts';
import {
  runLocalUserMessageEvent as runLocalUserMessageEventWithoutHost
} from '../src/runtime/local.ts';
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
  createTurnCompletedAppendFailingLogStore,
  handleFileStoreWritePluginId,
  handleFileStoreWriteToolName,
  runLocalUserMessageEventWithDefaultTestHost as runLocalUserMessageEvent
} from './support/plugin-tool-loop-fixtures.ts';
import { writeRuntimeConfig } from './support/runtime-config.ts';
import { requiredDottedConfigPlugin } from './support/runtime-config-fixtures.ts';

async function createConfigEffectTestFixture(label: string) {
  const sessionId = `session-config-effect-${label}`;
  const storeRoot = createTestTempRoot(`project02-config-effect-${label}-`);

  await createLocalRuntimeSessionStore({ storeRoot }).createSession({
    sessionId,
    createdAt: '2026-07-16T00:00:00.000Z'
  });

  const basePlugin = requiredDottedConfigPlugin(
    `config-effect-${label}.fixture`,
    'tone'
  );
  const targetPlugin = createRuntimePlugin({
    manifest: {
      ...basePlugin.manifest,
      config: {
        fields: basePlugin.manifest.config.fields.map((field) => ({
          ...field,
          required: false,
          agentMutable: true
        }))
      }
    }
  });
  const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
    plugins: {
      [targetPlugin.manifest.id]: {
        config: { tone: 'cool' }
      }
    }
  });
  const before = inspectRuntimePluginConfig({
    manifest: targetPlugin.manifest,
    pluginManifests: [targetPlugin.manifest],
    configPath,
    storeRoot
  });

  return {
    sessionId,
    storeRoot,
    targetPlugin,
    configPath,
    before
  };
}

function createConfigEffectTestHost(options: {
  readonly fixture: Awaited<ReturnType<typeof createConfigEffectTestFixture>>;
  readonly session: ReturnType<typeof createConversationSession>;
}): RuntimePluginHost {
  const { fixture } = options;

  return createRuntimePluginHost({
    storeRoot: fixture.storeRoot,
    sessionId: fixture.sessionId,
    sessionIdentity: options.session,
    pluginConfigControl: {
      pluginManifests: [fixture.targetPlugin.manifest],
      configPath: fixture.configPath
    },
    toolConfirmationHandler: () => ({ status: 'approved' })
  });
}

function createConfigEffectTestAdapter(options: {
  readonly fixture: Awaited<ReturnType<typeof createConfigEffectTestFixture>>;
  readonly reply: string;
  readonly messagesByRound?: RoleModelChatMessage[][];
}): RoleModelAdapter {
  const updateInput = {
    pluginId: options.fixture.targetPlugin.manifest.id,
    fieldName: 'tone',
    operation: 'set',
    value: 'warm',
    expectedFingerprint: options.fixture.before.fingerprint
  } as const;
  let invocationCount = 0;

  return Object.freeze({
    invoke(_inputEnvelope, invocation) {
      invocationCount += 1;
      options.messagesByRound?.push([...invocation.turnContext.messages]);

      if (invocationCount === 1) {
        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: runtimePluginConfigUpdateToolName,
                input: updateInput
              }
            ]
          }),
          nativeAssistantMessage: {
            role: 'assistant',
            content: 'Preparing one approved config update.',
            tool_calls: [
              {
                id: 'call_runtime_plugin_config_update',
                type: 'function',
                function: {
                  name: runtimePluginConfigUpdateToolName,
                  arguments: JSON.stringify(updateInput)
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
              input: { text: options.reply }
            }
          ]
        })
      };
    }
  } satisfies RoleModelAdapter);
}

describe('plugin-driven tool loop commit and rollback', () => {
  it('requires a startup-injected host before recording turn evidence', async () => {
    const session = createConversationSession();
    const logStore = createRuntimeLogStore();

    await expect(
      Reflect.apply(runLocalUserMessageEventWithoutHost, undefined, [
        {
          event: createTestEvent('hello', 'evt_missing_plugin_host'),
          session,
          logStore,
          roleModelAdapter: createSequencedAdapter([
            {
              toolCalls: [
                {
                  name: 'visible_reply',
                  input: { text: 'This turn must not run.' }
                }
              ]
            }
          ])
        }
      ])
    ).rejects.toThrow(
      'Local runtime turns require an explicitly configured plugin host.'
    );
    expect(logStore.traceEntries()).toEqual([]);
    expect(logStore.rawEvents()).toEqual([]);
    expect(logStore.conversationMessages()).toEqual([]);
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
              text: 'I can use:\n- runtime.plugin.list\n- character_state.patch'
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
      'I can use:\n- runtime.plugin.list\n- character_state.patch'
    ]);
  });

  it('commits authoritative visible reply text while durable evidence stays redacted', async () => {
    const sessionId = 'session-authoritative-visible';
    const storeRoot = createTestTempRoot('project02-authoritative-visible-');

    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z'
    });

    const session = createConversationSession({ id: sessionId });
    const logStore = createFileRuntimeLogStore({ storeRoot, sessionId });
    const replyText = 'Authorization: Bearer committed-reply-secret';
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: { text: replyText }
          }
        ]
      }
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('show the exact value', 'evt_authoritative_visible'),
      session,
      logStore,
      roleModelAdapter: adapter
    });

    expect(result.status).toBe('completed');
    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'show the exact value',
      replyText
    ]);

    const serializedEvidence = JSON.stringify({
      rawEvents: logStore.rawEvents(),
      traces: logStore.traceEntries()
    });

    expect(serializedEvidence).toContain('Authorization: [redacted]');
    expect(serializedEvidence).not.toContain('committed-reply-secret');
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
        runtimePluginId,
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
        runtimePluginId,
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
        runtimePluginId,
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
        runtimePluginId,
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

  it('preserves a typed busy failure when durable plugin writes cannot prepare', async () => {
    const sessionId = 'session-tool-prepare-lock-contention';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');

    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z'
    });

    const session = createConversationSession({ id: sessionId });
    const logStore = createFileRuntimeLogStore({ storeRoot, sessionId });
    const pluginHost = createRuntimePluginHost({
      storeRoot,
      sessionId,
      plugins: [createHandleFileStoreWritePlugin()],
      enabledPluginIds: [
        runtimePluginId,
        firstPartyModelToolsPluginId,
        handleFileStoreWritePluginId
      ]
    });
    const pluginStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId: handleFileStoreWritePluginId
    });
    const pluginRoot = createLocalRuntimePluginPaths({
      storeRoot,
      sessionId,
      pluginId: handleFileStoreWritePluginId
    }).pluginRoot;
    const readyPath = join(storeRoot, 'prepare-lock-ready');
    let invocationCount = 0;
    let lockHolder: Promise<void> | undefined;
    let contentionStartedAt: number | undefined;
    const adapter = Object.freeze({
      async invoke() {
        invocationCount += 1;

        if (invocationCount === 1) {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: handleFileStoreWriteToolName,
                  input: { value: 'must not commit' }
                }
              ]
            })
          };
        }

        lockHolder = startPluginMutationLockHolderChild({
          locksRoot: createLocalRuntimeStorageLayout({ storeRoot }).locksRoot,
          resourceKey: durablePluginStoreMutationResourceKey(pluginRoot),
          readyPath,
          holdMs: 500
        });
        await waitForReadyFile(readyPath);
        contentionStartedAt = Date.now();

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'visible_reply',
                input: { text: 'This reply must not commit.' }
              }
            ]
          })
        };
      }
    } satisfies RoleModelAdapter);
    let runtimeFailure: unknown;
    let failureObservedAt: number | undefined;

    try {
      await runLocalUserMessageEvent({
        event: createTestEvent(
          'write memory',
          'evt_tool_prepare_lock_contention'
        ),
        session,
        logStore,
        roleModelAdapter: adapter,
        pluginHost
      });
    } catch (error: unknown) {
      runtimeFailure = error;
      failureObservedAt = Date.now();
    } finally {
      await lockHolder;
    }

    expect(runtimeFailure).toBeInstanceOf(LocalRuntimeMutationLockBusyError);
    expect(runtimeFailure).toMatchObject({ code: 'storage_busy' });
    expect(contentionStartedAt).toEqual(expect.any(Number));
    expect(failureObservedAt).toEqual(expect.any(Number));

    if (contentionStartedAt === undefined || failureObservedAt === undefined) {
      throw new Error('Expected the runtime prepare contention timing evidence.');
    }

    expect(failureObservedAt - contentionStartedAt).toBeLessThan(200);
    expect(pluginStore.readJson('state.json')).toBeUndefined();
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected'
    });

    const retryResult = await runLocalUserMessageEvent({
      event: createTestEvent('write memory again', 'evt_tool_prepare_retry'),
      session,
      logStore,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: handleFileStoreWriteToolName,
              input: { value: 'retry committed' }
            }
          ]
        },
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: { text: 'Retry committed.' }
            }
          ]
        }
      ]),
      pluginHost
    });

    expect(retryResult.status).toBe('completed');
    expect(pluginStore.readJson('state.json')).toEqual({
      value: 'retry committed'
    });
  }, 15_000);

  it('applies an approved config effect only after durable terminal intent', async () => {
    const fixture = await createConfigEffectTestFixture('durable-success');
    const messagesByRound: RoleModelChatMessage[][] = [];
    const session = createConversationSession({ id: fixture.sessionId });
    const logStore = createFileRuntimeLogStore({
      storeRoot: fixture.storeRoot,
      sessionId: fixture.sessionId
    });
    const pluginHost = createConfigEffectTestHost({ fixture, session });
    const result = await runLocalUserMessageEvent({
      event: createTestEvent('update config', 'evt_config_effect_success'),
      session,
      logStore,
      pluginHost,
      roleModelAdapter: createConfigEffectTestAdapter({
        fixture,
        reply: 'Config committed.',
        messagesByRound
      })
    });
    const after = inspectRuntimePluginConfig({
      manifest: fixture.targetPlugin.manifest,
      pluginManifests: [fixture.targetPlugin.manifest],
      configPath: fixture.configPath,
      storeRoot: fixture.storeRoot
    });
    const terminal = logStore.rawEvents().find(
      (event) => event.kind === 'runtime_turn_completed'
    );
    const effect = terminal?.runtimeConfigEffects?.[0];
    const marker = logStore.rawEvents().find(
      (event) =>
        event.kind === 'after_turn_committed' &&
        event.runtimePluginEvidence?.some((evidence) =>
          evidence.sourceReferences?.some(
            (reference) => reference.id === effect?.effectId
          )
        )
    );
    const nativeToolResult = messagesByRound[1]?.find(
      (message) => message.role === 'tool'
    );

    expect(result.status).toBe('completed');
    expect(terminal).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed',
      runtimeConfigEffects: [
        {
          targetPluginId: fixture.targetPlugin.manifest.id,
          operation: { kind: 'set', value: 'warm' }
        }
      ]
    });
    expect(
      after.fields.find((field) => field.name === 'tone')?.authored
    ).toEqual({ configured: true, value: 'warm' });
    expect(marker).toMatchObject({
      kind: 'after_turn_committed',
      status: 'completed'
    });
    expect(nativeToolResult?.content).toContain(
      '"status":"approved_pending_commit"'
    );
    expect(nativeToolResult?.content).not.toContain('preparedConfigEffect');
    expect(nativeToolResult?.content).not.toContain('runtimeConfigEffects');
  });

  it('recovers an applied config effect when its commit marker append failed', async () => {
    const fixture = await createConfigEffectTestFixture('marker-recovery');
    const session = createConversationSession({ id: fixture.sessionId });
    const fileLogStore = createFileRuntimeLogStore({
      storeRoot: fixture.storeRoot,
      sessionId: fixture.sessionId
    });
    const logStore = createAfterTurnCommittedAppendFailingLogStore(fileLogStore);
    const pluginHost = createConfigEffectTestHost({ fixture, session });
    const firstResult = await runLocalUserMessageEvent({
      event: createTestEvent('update config', 'evt_config_marker_recovery'),
      session,
      logStore,
      pluginHost,
      roleModelAdapter: createConfigEffectTestAdapter({
        fixture,
        reply: 'Config committed before marker failure.'
      })
    });
    const terminal = fileLogStore.rawEvents().find(
      (event) => event.kind === 'runtime_turn_completed'
    );
    const effect = terminal?.runtimeConfigEffects?.[0];
    const afterApply = inspectRuntimePluginConfig({
      manifest: fixture.targetPlugin.manifest,
      pluginManifests: [fixture.targetPlugin.manifest],
      configPath: fixture.configPath,
      storeRoot: fixture.storeRoot
    });

    expect(firstResult).toMatchObject({
      status: 'completed',
      postCommitFailures: ['after-turn raw event append failed']
    });
    expect(afterApply.fingerprint).toBe(effect?.resultFingerprint);
    expect(
      fileLogStore.rawEvents().some(
        (event) => event.kind === 'after_turn_committed'
      )
    ).toBe(false);

    const reopenedLogStore = createFileRuntimeLogStore({
      storeRoot: fixture.storeRoot,
      sessionId: fixture.sessionId
    });
    const restoredSession = createConversationSession({
      id: fixture.sessionId,
      visibleTranscript: reopenedLogStore.conversationMessages()
    });
    const recoveryHost = createConfigEffectTestHost({
      fixture,
      session: restoredSession
    });

    expect(
      await runLocalUserMessageEvent({
        event: createTestEvent('continue', 'evt_config_marker_followup'),
        session: restoredSession,
        logStore: reopenedLogStore,
        pluginHost: recoveryHost,
        roleModelAdapter: createSequencedAdapter([
          {
            toolCalls: [
              {
                name: 'visible_reply',
                input: { text: 'Recovered marker.' }
              }
            ]
          }
        ])
      })
    ).toMatchObject({ status: 'completed' });
    expect(
      reopenedLogStore.rawEvents().filter(
        (event) =>
          event.kind === 'after_turn_committed' &&
          event.runtimePluginEvidence?.some((evidence) =>
            evidence.sourceReferences?.some(
              (reference) => reference.id === effect?.effectId
            )
          )
      )
    ).toHaveLength(1);
  });

  it('closes a conflicted config effect with a rejected record and continues the session', async () => {
    const fixture = await createConfigEffectTestFixture('fingerprint-drift');
    const session = createConversationSession({ id: fixture.sessionId });
    const logStore = createFileRuntimeLogStore({
      storeRoot: fixture.storeRoot,
      sessionId: fixture.sessionId
    });
    const baseHost = createConfigEffectTestHost({ fixture, session });
    let driftApplied = false;
    const driftHost = Object.freeze({
      ...baseHost,
      reconcileConfigEffect(effect) {
        if (!driftApplied) {
          applyRuntimePluginConfigControlOperation({
            manifest: fixture.targetPlugin.manifest,
            actor: 'operator',
            expectedFingerprint: fixture.before.fingerprint,
            operation: {
              kind: 'set',
              fieldName: 'tone',
              value: 'competing-value'
            },
            configPath: fixture.configPath,
            storeRoot: fixture.storeRoot
          });
          driftApplied = true;
        }

        if (baseHost.reconcileConfigEffect === undefined) {
          throw new Error('Expected config effect reconciliation support.');
        }

        return baseHost.reconcileConfigEffect(effect);
      }
    } satisfies RuntimePluginHost);
    const firstResult = await runLocalUserMessageEvent({
      event: createTestEvent('update config', 'evt_config_effect_drift'),
      session,
      logStore,
      pluginHost: driftHost,
      roleModelAdapter: createConfigEffectTestAdapter({
        fixture,
        reply: 'Config intent committed.'
      })
    });
    const afterDrift = inspectRuntimePluginConfig({
      manifest: fixture.targetPlugin.manifest,
      pluginManifests: [fixture.targetPlugin.manifest],
      configPath: fixture.configPath,
      storeRoot: fixture.storeRoot
    });
    const effectId = logStore
      .rawEvents()
      .find((candidate) => candidate.kind === 'runtime_turn_completed')
      ?.runtimeConfigEffects?.[0]?.effectId;
    const rejectedClosureRecords = () =>
      logStore.rawEvents().filter(
        (event) =>
          event.kind === 'after_turn_committed' &&
          event.runtimePluginEvidence?.some(
            (evidence) =>
              evidence.status === 'rejected' &&
              evidence.sourceReferences?.some(
                (reference) =>
                  reference.kind === 'runtime' && reference.id === effectId
              )
          )
      );

    expect(firstResult.status).toBe('completed');
    expect(
      firstResult.status === 'completed' ? firstResult.postCommitFailures : []
    ).toEqual([
      expect.stringContaining(
        'cannot be reconciled because authored config changed'
      )
    ]);
    expect(
      afterDrift.fields.find((field) => field.name === 'tone')?.authored.value
    ).toBe('competing-value');
    expect(effectId).toBeDefined();
    expect(rejectedClosureRecords()).toHaveLength(1);

    const restoredSession = createConversationSession({
      id: fixture.sessionId,
      visibleTranscript: logStore.conversationMessages()
    });
    const recoveryHost = createConfigEffectTestHost({
      fixture,
      session: restoredSession
    });
    const followUpResult = await runLocalUserMessageEvent({
      event: createTestEvent('continue', 'evt_config_drift_followup'),
      session: restoredSession,
      logStore,
      pluginHost: recoveryHost,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: { text: 'Session continues after conflict.' }
            }
          ]
        }
      ])
    });
    const thirdResult = await runLocalUserMessageEvent({
      event: createTestEvent('and again', 'evt_config_drift_third'),
      session: restoredSession,
      logStore,
      pluginHost: recoveryHost,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: { text: 'Still healthy.' }
            }
          ]
        }
      ])
    });

    expect(followUpResult.status).toBe('completed');
    expect(thirdResult.status).toBe('completed');
    expect(
      afterDrift.fields.find((field) => field.name === 'tone')?.authored.value
    ).toBe('competing-value');
    expect(rejectedClosureRecords()).toHaveLength(1);
  });

  it('rejects a prepared config effect when durable session evidence is unavailable', async () => {
    const fixture = await createConfigEffectTestFixture('no-durable-store');
    const session = createConversationSession({ id: fixture.sessionId });
    const logStore = createRuntimeLogStore();
    const pluginHost = createConfigEffectTestHost({ fixture, session });

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent('update config', 'evt_config_no_durable_store'),
        session,
        logStore,
        pluginHost,
        roleModelAdapter: createConfigEffectTestAdapter({
          fixture,
          reply: 'Must not commit.'
        })
      })
    ).rejects.toThrow(
      'Approved runtime config effects require durable local session evidence.'
    );
    const after = inspectRuntimePluginConfig({
      manifest: fixture.targetPlugin.manifest,
      pluginManifests: [fixture.targetPlugin.manifest],
      configPath: fixture.configPath,
      storeRoot: fixture.storeRoot
    });

    expect(after.fingerprint).toBe(fixture.before.fingerprint);
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected'
    });
    expect(
      logStore.rawEvents().some(
        (event) => event.kind === 'runtime_turn_completed'
      )
    ).toBe(false);
  });

  it('recovers a durable pending config effect once and records its effect marker', async () => {
    const sessionId = 'session-config-update-recovery';
    const storeRoot = createTestTempRoot('project02-config-update-recovery-');

    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-07-16T00:00:00.000Z'
    });

    const basePlugin = requiredDottedConfigPlugin(
      'config-update-recovery-target.fixture',
      'tone'
    );
    const targetPlugin = createRuntimePlugin({
      manifest: {
        ...basePlugin.manifest,
        config: {
          fields: basePlugin.manifest.config.fields.map((field) => ({
            ...field,
            required: false,
            agentMutable: true
          }))
        }
      }
    });
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [targetPlugin.manifest.id]: {
          config: { tone: 'cool' }
        }
      }
    });
    const before = inspectRuntimePluginConfig({
      manifest: targetPlugin.manifest,
      pluginManifests: [targetPlugin.manifest],
      configPath,
      storeRoot
    });
    const session = createConversationSession({ id: sessionId });
    const logStore = createFileRuntimeLogStore({ storeRoot, sessionId });
    const baseHost = createRuntimePluginHost({
      storeRoot,
      sessionId,
      sessionIdentity: session,
      pluginConfigControl: {
        pluginManifests: [targetPlugin.manifest],
        configPath
      },
      toolConfirmationHandler: () => ({ status: 'approved' })
    });
    const recoveryPendingHost = Object.freeze({
      ...baseHost,
      reconcileConfigEffect() {
        throw new Error('simulated config reconciliation interruption');
      }
    } satisfies RuntimePluginHost);
    const firstResult = await runLocalUserMessageEvent({
      event: createTestEvent('update config', 'evt_config_update_recovery'),
      session,
      logStore,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: runtimePluginConfigUpdateToolName,
              input: {
                pluginId: targetPlugin.manifest.id,
                fieldName: 'tone',
                operation: 'set',
                value: 'warm',
                expectedFingerprint: before.fingerprint
              }
            }
          ]
        },
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: { text: 'Config update is committed.' }
            }
          ]
        }
      ]),
      pluginHost: recoveryPendingHost
    });
    const terminal = logStore.rawEvents().find(
      (event) => event.kind === 'runtime_turn_completed'
    );
    const effect = terminal?.runtimeConfigEffects?.[0];
    const toolFinished = logStore.rawEvents().find(
      (event) => event.kind === 'tool_call_finished'
    );
    const afterInterruptedCommit = inspectRuntimePluginConfig({
      manifest: targetPlugin.manifest,
      pluginManifests: [targetPlugin.manifest],
      configPath,
      storeRoot
    });

    expect(firstResult).toMatchObject({
      status: 'completed',
      postCommitFailures: ['simulated config reconciliation interruption']
    });
    expect(effect).toMatchObject({
      targetPluginId: targetPlugin.manifest.id,
      fieldName: 'tone',
      expectedFingerprint: before.fingerprint,
      operation: { kind: 'set', value: 'warm' }
    });
    expect(terminal?.toolCallIds).toContain(effect?.effectId);
    expect(toolFinished?.toolResult).toMatchObject({
      status: 'accepted',
      output: { status: 'approved_pending_commit' }
    });
    expect(toolFinished).not.toHaveProperty('runtimeConfigEffects');
    expect(toolFinished?.toolResult).not.toHaveProperty('preparedConfigEffect');
    expect(
      JSON.stringify(terminal?.roleModelIOSnapshot?.inputEnvelope.toolObservations)
    ).not.toContain('preparedConfigEffect');
    expect(afterInterruptedCommit.fingerprint).toBe(before.fingerprint);

    const reopenedLogStore = createFileRuntimeLogStore({ storeRoot, sessionId });
    const restoredSession = createConversationSession({
      id: sessionId,
      visibleTranscript: reopenedLogStore.conversationMessages()
    });
    const recoveryHost = createRuntimePluginHost({
      storeRoot,
      sessionId,
      sessionIdentity: restoredSession,
      pluginConfigControl: {
        pluginManifests: [targetPlugin.manifest],
        configPath
      },
      toolConfirmationHandler: () => ({ status: 'approved' })
    });
    const followupResult = await runLocalUserMessageEvent({
      event: createTestEvent('continue', 'evt_config_update_recovery_followup'),
      session: restoredSession,
      logStore: reopenedLogStore,
      pluginHost: recoveryHost,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: { text: 'Recovered.' }
            }
          ]
        }
      ])
    });
    const afterRecovery = inspectRuntimePluginConfig({
      manifest: targetPlugin.manifest,
      pluginManifests: [targetPlugin.manifest],
      configPath,
      storeRoot
    });
    const effectMarkers = reopenedLogStore.rawEvents().flatMap((event) =>
      event.kind !== 'after_turn_committed'
        ? []
        : (event.runtimePluginEvidence ?? []).filter((evidence) =>
            evidence.sourceReferences?.some(
              (reference) =>
                reference.kind === 'runtime' &&
                reference.id === effect?.effectId
            )
          )
    );

    expect(followupResult.status).toBe('completed');
    expect(
      afterRecovery.fields.find((field) => field.name === 'tone')?.authored
    ).toEqual({ configured: true, value: 'warm' });
    expect(effectMarkers).toHaveLength(1);
    expect(effectMarkers[0]).toMatchObject({
      pluginId: runtimePluginId,
      evidenceKind: 'after_turn_committed',
      status: 'accepted',
      configFingerprint: effect?.resultFingerprint
    });
  });

  it('leaves authored config unchanged when config-update finish logging fails', async () => {
    const sessionId = 'session-config-update-finish-log-failure';
    const storeRoot = createTestTempRoot('project02-config-update-loop-');

    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-07-16T00:00:00.000Z'
    });

    const basePlugin = requiredDottedConfigPlugin(
      'config-update-target.fixture',
      'tone'
    );
    const targetPlugin = createRuntimePlugin({
      manifest: {
        ...basePlugin.manifest,
        config: {
          fields: basePlugin.manifest.config.fields.map((field) => ({
            ...field,
            required: false,
            agentMutable: true
          }))
        }
      }
    });
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [targetPlugin.manifest.id]: {
          config: { tone: 'cool' }
        }
      }
    });
    const before = inspectRuntimePluginConfig({
      manifest: targetPlugin.manifest,
      pluginManifests: [targetPlugin.manifest],
      configPath,
      storeRoot
    });
    const session = createConversationSession({ id: sessionId });
    const logStore = createToolCallFinishedAppendFailingLogStore(
      createFileRuntimeLogStore({ storeRoot, sessionId })
    );
    const pluginHost = createRuntimePluginHost({
      storeRoot,
      sessionId,
      sessionIdentity: session,
      pluginConfigControl: {
        pluginManifests: [targetPlugin.manifest],
        configPath
      },
      toolConfirmationHandler: () => ({ status: 'approved' })
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: runtimePluginConfigUpdateToolName,
            input: {
              pluginId: targetPlugin.manifest.id,
              fieldName: 'tone',
              operation: 'set',
              value: 'warm',
              expectedFingerprint: before.fingerprint
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: { text: 'Config updated.' }
          }
        ]
      }
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent('update config', 'evt_config_update_finish_fails'),
        session,
        logStore,
        roleModelAdapter: adapter,
        pluginHost
      })
    ).rejects.toThrow('tool_call_finished raw event append failed');

    const after = inspectRuntimePluginConfig({
      manifest: targetPlugin.manifest,
      pluginManifests: [targetPlugin.manifest],
      configPath,
      storeRoot
    });

    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.fields.find((field) => field.name === 'tone')?.authored).toEqual({
      configured: true,
      value: 'cool'
    });
    expect(logStore.rawEvents().some((event) => event.kind === 'tool_call_finished')).toBe(
      false
    );
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected'
    });
  });

  it('leaves authored config unchanged when the terminal append fails with a prepared effect', async () => {
    const sessionId = 'session-config-update-terminal-append-failure';
    const storeRoot = createTestTempRoot('project02-config-update-loop-');

    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-07-16T00:00:00.000Z'
    });

    const basePlugin = requiredDottedConfigPlugin(
      'config-update-terminal.fixture',
      'tone'
    );
    const targetPlugin = createRuntimePlugin({
      manifest: {
        ...basePlugin.manifest,
        config: {
          fields: basePlugin.manifest.config.fields.map((field) => ({
            ...field,
            required: false,
            agentMutable: true
          }))
        }
      }
    });
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [targetPlugin.manifest.id]: {
          config: { tone: 'cool' }
        }
      }
    });
    const before = inspectRuntimePluginConfig({
      manifest: targetPlugin.manifest,
      pluginManifests: [targetPlugin.manifest],
      configPath,
      storeRoot
    });
    const session = createConversationSession({ id: sessionId });
    const logStore = createTurnCompletedAppendFailingLogStore(
      createFileRuntimeLogStore({ storeRoot, sessionId })
    );
    const pluginHost = createRuntimePluginHost({
      storeRoot,
      sessionId,
      sessionIdentity: session,
      pluginConfigControl: {
        pluginManifests: [targetPlugin.manifest],
        configPath
      },
      toolConfirmationHandler: () => ({ status: 'approved' })
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: runtimePluginConfigUpdateToolName,
            input: {
              pluginId: targetPlugin.manifest.id,
              fieldName: 'tone',
              operation: 'set',
              value: 'warm',
              expectedFingerprint: before.fingerprint
            }
          }
        ]
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: { text: 'Config updated.' }
          }
        ]
      }
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent('update config', 'evt_config_update_terminal_fails'),
        session,
        logStore,
        roleModelAdapter: adapter,
        pluginHost
      })
    ).rejects.toThrow('runtime_turn_completed raw event append failed');

    const after = inspectRuntimePluginConfig({
      manifest: targetPlugin.manifest,
      pluginManifests: [targetPlugin.manifest],
      configPath,
      storeRoot
    });

    expect(after.fingerprint).toBe(before.fingerprint);
    expect(
      after.fields.find((field) => field.name === 'tone')?.authored
    ).toEqual({
      configured: true,
      value: 'cool'
    });
    expect(
      logStore.rawEvents().some((event) => event.kind === 'runtime_turn_completed')
    ).toBe(false);
    expect(
      logStore.rawEvents().some((event) => event.kind === 'after_turn_committed')
    ).toBe(false);
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
        runtimePluginId,
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
        runtimePluginId,
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

function startPluginMutationLockHolderChild(options: {
  readonly locksRoot: string;
  readonly resourceKey: string;
  readonly readyPath: string;
  readonly holdMs: number;
}): Promise<void> {
  const script = [
    "import { writeFileSync } from 'node:fs';",
    "const { acquireLocalRuntimeMutationLockSync } = await import('./src/runtime/storage/mutation-lock.ts');",
    'const lease = acquireLocalRuntimeMutationLockSync({',
    '  locksRoot: process.argv[1],',
    '  resourceKey: process.argv[2],',
    '  waitTimeoutMs: 0',
    '});',
    "writeFileSync(process.argv[3], 'ready\\n', 'utf8');",
    'const sleep = new Int32Array(new SharedArrayBuffer(4));',
    'Atomics.wait(sleep, 0, 0, Number(process.argv[4]));',
    'lease.release();'
  ].join('\n');

  return runInlineModuleChild(script, [
    options.locksRoot,
    options.resourceKey,
    options.readyPath,
    String(options.holdMs)
  ]);
}

async function runInlineModuleChild(
  script: string,
  arguments_: readonly string[]
): Promise<void> {
  await new Promise<void>((resolveChild, rejectChild) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script, ...arguments_],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', rejectChild);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveChild();
        return;
      }

      rejectChild(
        new Error(`Inline child failed (${String(code ?? signal)}): ${stderr}`)
      );
    });
  });
}

async function waitForReadyFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  for (;;) {
    try {
      await readFile(path, 'utf8');
      return;
    } catch (error: unknown) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for child readiness file: ${path}.`);
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}
