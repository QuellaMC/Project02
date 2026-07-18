import {
  createConversationSession,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
} from '../../src/core/index.ts';
import {characterStatePluginId} from '../../src/plugins/api/contract.ts';
import {createRuntimePluginFileStore} from '../../src/runtime/storage/plugin-file-store/index.ts';
import {testRuntimePluginFileStoreProvider} from './plugin-host-fixtures.ts';
import {createDefaultProject02PluginHost} from './default-plugin-host.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {
  createRuntimePlugin,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginHealthSnapshot,
  firstPartyModelToolsPluginId,
  runtimePluginId,
  runtimePluginContractVersion,
} from '../../src/plugins/api/index.ts';
import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';
import {createRuntimeLogStore} from '../../src/runtime/evidence/index.ts';
import type {RuntimeLogStore} from '../../src/runtime/evidence/records.ts';
import {
  runLocalUserMessageEvent as runLocalUserMessageEventWithExplicitHost,
  type RunLocalUserMessageEventOptions,
} from '../../src/runtime/turn/local.ts';
import {
  type RoleModelAdapter,
  type RoleModelChatMessage,
} from '../../src/role-model/index.ts';
import {createTestTempRoot} from './temp-root.ts';

export function runLocalUserMessageEventWithDefaultTestHost(
  options: Omit<RunLocalUserMessageEventOptions, 'pluginHost'> &
    Partial<Pick<RunLocalUserMessageEventOptions, 'pluginHost'>>,
) {
  const sessionPaths = options.logStore.localRuntimeSessionPaths;
  const pluginHost =
    options.pluginHost ??
    createDefaultProject02PluginHost({
      ...(sessionPaths === undefined
        ? {}
        : {storeRoot: sessionPaths.storeRoot}),
      sessionId: sessionPaths?.sessionId ?? options.session.id,
      sessionIdentity: options.session,
    });

  return runLocalUserMessageEventWithExplicitHost({
    ...options,
    pluginHost,
  });
}

export function createNativePluginListAdapter(
  messagesByRound: RoleModelChatMessage[][],
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
                name: 'runtime.plugin.list',
                input: {},
              },
            ],
          }),
          nativeAssistantMessage: {
            role: 'assistant',
            content: 'Checking plugins.',
            tool_calls: [
              {
                id: 'call_runtime_plugin_list',
                type: 'function',
                function: {
                  name: 'runtime.plugin.list',
                  arguments: '{}',
                },
              },
            ],
          },
        };
      }

      return {
        rawOutputText: JSON.stringify({
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'Plugins are available.',
              },
            },
          ],
        }),
      };
    },
  } satisfies RoleModelAdapter);
}

export function createNativeVisibleReplyAndPluginListAdapter(
  messagesByRound: RoleModelChatMessage[][],
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
                  text: 'Checking plugins.',
                },
              },
              {
                name: 'runtime.plugin.list',
                input: {},
              },
            ],
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
                  arguments: '{"text":"Checking plugins."}',
                },
              },
              {
                id: 'call_runtime_plugin_list_with_visible',
                type: 'function',
                function: {
                  name: 'runtime.plugin.list',
                  arguments: '{}',
                },
              },
            ],
          },
        };
      }

      return {
        rawOutputText: JSON.stringify({
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'Plugins are available after progress.',
              },
            },
          ],
        }),
      };
    },
  } satisfies RoleModelAdapter);
}

export function createSequencedAdapter(
  decisions: readonly Readonly<Record<string, unknown>>[],
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
        rawOutputText: JSON.stringify(decision),
      };
    },
  } satisfies RoleModelAdapter);
}

export function createConversationAppendFailingLogStore(
  logStore: RuntimeLogStore = createRuntimeLogStore(),
): RuntimeLogStore {
  return Object.freeze({
    ...delegateRuntimeLogStoreLifecycle(logStore),
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
    readSessionEvidence() {
      return logStore.readSessionEvidence();
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    },
  } satisfies RuntimeLogStore);
}

export function createCharacterAppendFailingLogStore(
  logStore: RuntimeLogStore,
): RuntimeLogStore {
  let conversationAppendCount = 0;

  return Object.freeze({
    ...delegateRuntimeLogStoreLifecycle(logStore),
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
    readSessionEvidence() {
      return logStore.readSessionEvidence();
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    },
  } satisfies RuntimeLogStore);
}

export function createRuntimeTurnCompletedAppendFailingLogStore(
  logStore: RuntimeLogStore = createRuntimeLogStore(),
): RuntimeLogStore {
  return Object.freeze({
    ...delegateRuntimeLogStoreLifecycle(logStore),
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
    readSessionEvidence() {
      return logStore.readSessionEvidence();
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    },
  } satisfies RuntimeLogStore);
}

export function createRuntimeTurnCompletedAppendThenThrowLogStore(
  logStore: RuntimeLogStore,
): RuntimeLogStore {
  return Object.freeze({
    ...delegateRuntimeLogStoreLifecycle(logStore),
    appendTrace(entry) {
      return logStore.appendTrace(entry);
    },
    appendRawEvent(record) {
      const stored = logStore.appendRawEvent(record);

      if (record.kind === 'runtime_turn_completed') {
        throw new Error(
          'terminal raw event append reported failure after write',
        );
      }

      return stored;
    },
    appendConversationMessage(record) {
      return logStore.appendConversationMessage(record);
    },
    removeConversationMessages(messageIds) {
      logStore.removeConversationMessages(messageIds);
    },
    readSessionEvidence() {
      return logStore.readSessionEvidence();
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    },
  } satisfies RuntimeLogStore);
}

export function createOneShotTerminalTraceAppendFailingLogStore(
  logStore: RuntimeLogStore,
): RuntimeLogStore {
  let failed = false;

  return Object.freeze({
    ...delegateRuntimeLogStoreLifecycle(logStore),
    appendTrace(entry) {
      if (!failed && entry.step === 'raw_event_log_appended') {
        failed = true;
        throw new Error('one-shot terminal trace append failed');
      }

      return logStore.appendTrace(entry);
    },
    appendRawEvent(record) {
      return logStore.appendRawEvent(record);
    },
    appendConversationMessage(record) {
      return logStore.appendConversationMessage(record);
    },
    removeConversationMessages(messageIds) {
      logStore.removeConversationMessages(messageIds);
    },
    readSessionEvidence() {
      return logStore.readSessionEvidence();
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    },
  } satisfies RuntimeLogStore);
}

export function createAfterTurnCommittedAppendFailingLogStore(
  logStore: RuntimeLogStore = createRuntimeLogStore(),
): RuntimeLogStore {
  return Object.freeze({
    ...delegateRuntimeLogStoreLifecycle(logStore),
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
    readSessionEvidence() {
      return logStore.readSessionEvidence();
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    },
  } satisfies RuntimeLogStore);
}

export function createTurnCompletedAppendFailingLogStore(
  logStore: RuntimeLogStore,
): RuntimeLogStore {
  return Object.freeze({
    ...delegateRuntimeLogStoreLifecycle(logStore),
    appendTrace(entry) {
      return logStore.appendTrace(entry);
    },
    appendRawEvent(record) {
      if (record.kind === 'runtime_turn_completed') {
        throw new Error('runtime_turn_completed raw event append failed');
      }

      return logStore.appendRawEvent(record);
    },
    appendConversationMessage(record, expectedCharacter) {
      return logStore.appendConversationMessage(record, expectedCharacter);
    },
    removeConversationMessages(messageIds) {
      logStore.removeConversationMessages(messageIds);
    },
    readSessionEvidence() {
      return logStore.readSessionEvidence();
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    },
  } satisfies RuntimeLogStore);
}

export function createToolCallFinishedAppendFailingLogStore(
  logStore: RuntimeLogStore,
): RuntimeLogStore {
  return Object.freeze({
    ...delegateRuntimeLogStoreLifecycle(logStore),
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
    readSessionEvidence() {
      return logStore.readSessionEvidence();
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    },
  } satisfies RuntimeLogStore);
}

type DelegatedRuntimeLogStoreLifecycle = Pick<
  RuntimeLogStore,
  | 'localRuntimeSessionPaths'
  | 'localRuntimeWriterLockOwnerToken'
  | 'checkpointWriterEvidence'
  | 'recoverAbandonedWriterEvidence'
>;

function delegateRuntimeLogStoreLifecycle(
  logStore: RuntimeLogStore,
): DelegatedRuntimeLogStoreLifecycle {
  return Object.freeze({
    ...(logStore.localRuntimeSessionPaths === undefined
      ? {}
      : {localRuntimeSessionPaths: logStore.localRuntimeSessionPaths}),
    ...(logStore.localRuntimeWriterLockOwnerToken === undefined
      ? {}
      : {
          localRuntimeWriterLockOwnerToken:
            logStore.localRuntimeWriterLockOwnerToken,
        }),
    ...(logStore.checkpointWriterEvidence === undefined
      ? {}
      : {
          checkpointWriterEvidence() {
            logStore.checkpointWriterEvidence?.();
          },
        }),
    ...(logStore.recoverAbandonedWriterEvidence === undefined
      ? {}
      : {
          recoverAbandonedWriterEvidence() {
            return logStore.recoverAbandonedWriterEvidence?.() ?? false;
          },
        }),
  } satisfies DelegatedRuntimeLogStoreLifecycle);
}

export const handleFileStoreWritePluginId = 'handle-write.fixture';

export const handleFileStoreWriteToolName = 'handle.write';

export function createHealthRejectingPlugin() {
  const pluginId = 'health-reject.fixture';

  return createRuntimePlugin({
    manifest: {
      id: pluginId,
      displayName: 'Health Reject Fixture',
      version: '1.0.0',
      kind: 'first_party',
      description: 'Test plugin that rejects precommit health.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'test',
      },
      declaredPlugins: ['health'],
      config: {
        fields: [],
      },
      localTrustLevel: 'test_fixture',
      runtimePolicy: {
        requiredForTurn: true,
        sideEffectLevel: 'none',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'reject_turn',
          handleToolCall: 'reject_tool_call',
          afterTurnCommitted: 'log_failure',
          health: 'reject_turn',
        },
      },
      activation: {
        defaultEnabled: true,
        reasons: ['test'],
      },
      requestedAccess: {},
    },
    providedTools: [],
    lifecycleHooks: {
      health(context) {
        return createRuntimePluginHealthSnapshot({
          pluginId,
          status: 'unavailable',
          checkedAt: context.timestamp,
          summary: 'Health fixture rejects the turn.',
          redactionLabels: [],
        });
      },
    },
  });
}

export function createHandleFileStoreWritePlugin(
  options: {
    readonly rejectHealthWhenValue?: string;
  } = {},
) {
  const healthRejectsWhenValue = options.rejectHealthWhenValue;

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
        sourceSystem: 'test',
      },
      declaredPlugins:
        healthRejectsWhenValue === undefined
          ? ['tool_provider', 'handle_tool_call']
          : ['tool_provider', 'handle_tool_call', 'health'],
      config: {
        fields: [],
      },
      localTrustLevel: 'test_fixture',
      runtimePolicy: {
        requiredForTurn: healthRejectsWhenValue === undefined ? false : true,
        sideEffectLevel: 'local_memory_write',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'reject_tool_call',
          afterTurnCommitted: 'log_failure',
          health:
            healthRejectsWhenValue === undefined ? 'degrade' : 'reject_turn',
        },
      },
      activation: {
        defaultEnabled: true,
        reasons: ['test'],
      },
      requestedAccess: {file_store: 'write', model_input: 'write'},
    },
    providedTools: [
      Object.freeze({
        name: handleFileStoreWriteToolName,
        description: 'Write a test value through the plugin file store.',
        requiredForUserTurn: false,
        callLimit: {
          scope: 'user_turn',
          maxCalls: 1,
        },
        inputContract: {
          type: 'object',
          fields: [
            {
              name: 'value',
              description: 'Value to write.',
              required: true,
            },
          ],
          additionalFields: false,
        },
        validationOwner: 'plugin_host',
        sideEffectLevel: 'local_memory_write',
        requiresConfirmation: false,
        sourceReferencesRequired: false,
      }),
    ],
    lifecycleHooks: {
      handleToolCall(call, context) {
        if (context.fileStore === undefined) {
          throw new Error(
            'Expected handle write fixture to receive fileStore.',
          );
        }

        context.fileStore.writeJsonAtomic('state.json', {
          value: call.input['value'] ?? 'missing',
        });

        return {
          status: 'accepted',
          output: {
            ok: true,
            pluginStoreRevision: context.fileStore.revision(),
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
              redactionLabels: [],
            }),
          ],
        };
      },
      ...(healthRejectsWhenValue === undefined
        ? {}
        : {
            health(context) {
              if (context.fileStore === undefined) {
                throw new Error(
                  'Expected handle write fixture health to receive fileStore.',
                );
              }

              const state = context.fileStore.readJson('state.json');
              const stagedValue = recordValue(state, 'value');
              const status =
                stagedValue === healthRejectsWhenValue
                  ? 'unavailable'
                  : 'available';

              return createRuntimePluginHealthSnapshot({
                pluginId: handleFileStoreWritePluginId,
                status,
                checkedAt: context.timestamp,
                summary:
                  status === 'available'
                    ? 'Staged handle write state is healthy.'
                    : 'Staged handle write state rejects the turn.',
                redactionLabels: [],
              });
            },
          }),
    },
  });
}

export function recordValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return (value as Readonly<Record<string, unknown>>)[key];
}

export function createAfterTurnCommittedProbeHost(
  onAfterTurnCommitted: () => void,
  options: {
    readonly status?: 'completed' | 'failed';
    readonly summary?: string;
  } = {},
) {
  const pluginId = 'after-commit.fixture';

  return createRuntimePluginHost({
    fileStore: testRuntimePluginFileStoreProvider,
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
            sourceSystem: 'test',
          },
          declaredPlugins: ['after_turn_committed'],
          config: {
            fields: [],
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
              health: 'degrade',
            },
          },
          activation: {
            defaultEnabled: true,
            reasons: ['test'],
          },
          requestedAccess: {},
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
                    summary: options.summary ?? 'After commit fixture failed.',
                    redactionLabels: [],
                  }),
                ],
              };
            }

            return {
              status: 'completed',
              evidence: [],
            };
          },
        },
      }),
    ],
    enabledPluginIds: [runtimePluginId, firstPartyModelToolsPluginId, pluginId],
  });
}

export function createPluginStoreRevisionFixtureHost() {
  const pluginId = 'revision.fixture';

  return createRuntimePluginHost({
    fileStore: testRuntimePluginFileStoreProvider,
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
            sourceSystem: 'test',
          },
          declaredPlugins: ['tool_provider', 'handle_tool_call'],
          config: {
            fields: [],
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
              health: 'degrade',
            },
          },
          activation: {
            defaultEnabled: true,
            reasons: ['test'],
          },
          requestedAccess: {model_input: 'write'},
        },
        providedTools: [
          createRevisionFixtureTool('revision.zero'),
          createRevisionFixtureTool('revision.valid'),
        ],
        lifecycleHooks: {
          handleToolCall(call) {
            return {
              status: 'accepted',
              output: {
                pluginStoreRevision: call.toolName === 'revision.valid' ? 2 : 0,
              },
              evidence: [],
            };
          },
        },
      }),
    ],
    enabledPluginIds: [runtimePluginId, firstPartyModelToolsPluginId, pluginId],
  });
}

export function createRevisionFixtureTool(name: string) {
  return {
    name,
    description: 'Return plugin store revision metadata.',
    requiredForUserTurn: false,
    callLimit: {
      scope: 'user_turn',
      maxCalls: 1,
    },
    inputContract: {
      type: 'object',
      fields: [],
      additionalFields: false,
    },
    validationOwner: 'plugin_host',
    sideEffectLevel: 'runtime_read',
    requiresConfirmation: false,
    sourceReferencesRequired: false,
  } as const;
}

export function createTestEvent(message: string, eventId: string) {
  return createUserMessageRuntimeEvent(
    message,
    createRuntimeEventIdentity({
      eventId,
      traceId: `trace_${eventId}`,
      createdAt: '2026-06-15T00:00:00.000Z',
    }),
  );
}

export function transactionIdentityFromContext(context: {
  readonly eventId: string;
  readonly traceId: string;
  readonly timestamp: string;
}) {
  return {
    eventId: context.eventId,
    traceId: context.traceId,
    createdAt: context.timestamp,
  };
}

export async function createDurableCharacterStateHarness(sessionId: string) {
  const storeRoot = createTestTempRoot('project02-plugin-loop-');

  await createLocalRuntimeSessionStore({storeRoot}).createSession({
    sessionId,
    createdAt: '2026-06-15T00:00:00.000Z',
  });

  return {
    storeRoot,
    session: createConversationSession({id: sessionId}),
    logStore: createFileRuntimeLogStore({
      storeRoot,
      sessionId,
    }),
    pluginStore: createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId: characterStatePluginId,
    }),
  };
}
