import type {RawEventLogRecordInput} from '../../src/runtime/evidence/records.ts';
import {testCharacterProfile} from './character-fixtures.ts';
import {createConversationSession} from '../../src/core/index.ts';
import {characterStatePluginId} from '../../src/plugins/api/contract.ts';
import {createRuntimePluginFileStore} from '../../src/runtime/storage/plugin-file-store/index.ts';
import {testRuntimePluginFileStoreProvider} from './plugin-host-fixtures.ts';
import {createDefaultProject02PluginHost} from './default-plugin-host.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {
  createRuntimePlugin,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginHealthSnapshot,
  runtimePluginId,
  runtimePluginContractVersion,
} from '../../src/plugins/api/index.ts';
import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';
import {createRuntimeLogStore} from '../../src/runtime/evidence/index.ts';
import type {RuntimeLogStore} from '../../src/runtime/evidence/contract.ts';
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

// `persist` appends before throwing, modelling a write that reached disk before
// its caller failed.
export function createRawEventAppendFailingLogStore(options: {
  readonly logStore?: RuntimeLogStore;
  readonly matches: (record: RawEventLogRecordInput) => boolean;
  readonly message: string;
  readonly persist?: boolean;
  readonly skip?: number;
}): RuntimeLogStore {
  const logStore =
    options.logStore ??
    createRuntimeLogStore({boundCharacter: testCharacterProfile});
  let matched = 0;

  function failsOn(record: RawEventLogRecordInput): boolean {
    if (!options.matches(record)) {
      return false;
    }

    matched += 1;
    return matched > (options.skip ?? 0);
  }

  return Object.freeze({
    ...delegateRuntimeLogStore(logStore),
    appendRawEvent(record, expectedCharacter) {
      if (!failsOn(record)) {
        return logStore.appendRawEvent(record, expectedCharacter);
      }

      if (options.persist === true) {
        logStore.appendRawEvent(record, expectedCharacter);
      }

      throw new Error(options.message);
    },
    persistPreparedRawEvent(record, expectedCharacter) {
      if (!failsOn(record)) {
        logStore.persistPreparedRawEvent(record, expectedCharacter);
        return;
      }

      if (options.persist === true) {
        logStore.persistPreparedRawEvent(record, expectedCharacter);
      }

      throw new Error(options.message);
    },
  } satisfies RuntimeLogStore);
}

function delegateRuntimeLogStore(logStore: RuntimeLogStore): RuntimeLogStore {
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
    appendRawEvent(record, expectedCharacter) {
      return logStore.appendRawEvent(record, expectedCharacter);
    },
    prepareRawEvent(record, expectedCharacter) {
      return logStore.prepareRawEvent(record, expectedCharacter);
    },
    persistPreparedRawEvent(record, expectedCharacter) {
      logStore.persistPreparedRawEvent(record, expectedCharacter);
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
      },
      declaredPlugins: ['health'],
      config: {
        scope: 'global_with_character_overrides',
        fields: [],
      },
      firstParty: false,
      runtimePolicy: {
        timeoutMs: 1000,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'reject_turn',
          handleToolCall: 'reject_tool_call',
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
      },
      declaredPlugins:
        healthRejectsWhenValue === undefined
          ? ['tool_provider', 'handle_tool_call']
          : ['tool_provider', 'handle_tool_call', 'health'],
      config: {
        scope: 'global_with_character_overrides',
        fields: [],
      },
      firstParty: false,
      runtimePolicy: {
        timeoutMs: 1000,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'reject_tool_call',
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
        inputContract: {
          type: 'object',
          properties: {
            value: {type: 'string', description: 'Value to write.'},
          },
          required: ['value'],
          additionalProperties: false,
        },
        validationOwner: 'plugin_host',
        requiresConfirmation: false,
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
          },
          declaredPlugins: ['after_turn_committed'],
          config: {
            scope: 'global_with_character_overrides',
            fields: [],
          },
          firstParty: false,
          runtimePolicy: {
            timeoutMs: 1000,
            redactionLabels: [],
            failureBehavior: {
              beforeRoleModelCall: 'degrade',
              handleToolCall: 'reject_tool_call',
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
    enabledPluginIds: [runtimePluginId, pluginId],
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
          },
          declaredPlugins: ['tool_provider', 'handle_tool_call'],
          config: {
            scope: 'global_with_character_overrides',
            fields: [],
          },
          firstParty: false,
          runtimePolicy: {
            timeoutMs: 1000,
            redactionLabels: [],
            failureBehavior: {
              beforeRoleModelCall: 'degrade',
              handleToolCall: 'reject_tool_call',
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
    enabledPluginIds: [runtimePluginId, pluginId],
  });
}

export function createRevisionFixtureTool(name: string) {
  return {
    name,
    description: 'Return plugin store revision metadata.',
    inputContract: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    validationOwner: 'plugin_host',
    requiresConfirmation: false,
  } as const;
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

  await createLocalRuntimeSessionStore({
    storeRoot,
    characterId: testCharacterProfile.id,
  }).createSession({
    sessionId,
    createdAt: '2026-06-15T00:00:00.000Z',
  });

  return {
    storeRoot,
    session: createConversationSession({
      id: sessionId,
      character: testCharacterProfile,
    }),
    logStore: createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot,
      sessionId,
    }),
    pluginStore: createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId: characterStatePluginId,
      scope: 'character',
    }),
  };
}
