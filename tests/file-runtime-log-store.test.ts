import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  createFileRuntimeLogStore
} from '../src/runtime/storage/file-runtime-log-store.ts';
import {
  createLocalRuntimeSessionStore
} from '../src/runtime/storage/session-store.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent
} from '../src/runtime/event.ts';
import {
  createConversationSession
} from '../src/core/conversation.ts';
import {
  runLocalUserMessageEvent
} from '../src/runtime/local.ts';
import {
  roleModelCommitValidationFailureRejectionReason
} from '../src/role-model/contracts.ts';
import {
  characterStatePatchModelToolName,
  visibleReplyModelToolName
} from '../src/role-model/model-tools.ts';
import {
  roleModelDecisionContractVersion
} from '../src/role-model/contracts.ts';
import {
  firstPartyModelToolsPluginId
} from '../src/plugins/index.ts';
import {
  LocalRuntimeStorageContractError
} from '../src/runtime/storage/layout.ts';
import {
  createLocalRuntimeStorageLayout
} from '../src/runtime/storage/layout.ts';
import {
  createRuntimePluginHost
} from '../src/plugins/host.ts';
import {
  createRuntimePlugin,
  createRuntimePluginHealthSnapshot,
  runtimePluginContractVersion
} from '../src/plugins/types.ts';
import type {
  RuntimePluginHealthStatus
} from '../src/plugins/types.ts';
import type {
  RoleModelAdapter
} from '../src/role-model/loop.ts';

describe('file runtime log store plugin tool event validation', () => {
  it('decodes legacy schema 1 role-model snapshots with character_state.patch as a former built-in allowed tool', async () => {
    const storeRoot = createStoreRoot();
    const sessionId = 'legacy-schema-1-role-model';
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z'
    });
    writeFileSync(
      createLocalRuntimeStorageLayout({ storeRoot }).schemaPath,
      `${JSON.stringify({
        schemaVersion: 1,
        createdAt: '2026-06-15T00:00:00.000Z'
      })}\n`,
      'utf8'
    );

    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    });
    const paths = logStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected file runtime log store session paths.');
    }

    mkdirSync(paths.sessionRoot, { recursive: true });
    writeJsonLines(paths.tracePath, [
      {
        ...identity('evt_legacy_schema1_patch'),
        step: 'runtime_event_received'
      },
      {
        ...identity('evt_legacy_schema1_patch'),
        step: 'runtime_turn_completed'
      }
    ]);
    writeJsonLines(paths.rawEventsPath, [
      {
        ...identity('evt_legacy_schema1_patch'),
        kind: 'runtime_event_received',
        eventType: 'USER_MESSAGE'
      },
      {
        ...identity('evt_legacy_schema1_patch'),
        kind: 'runtime_event_normalized',
        eventType: 'USER_MESSAGE',
        payloadSummary: {
          rawInput: 'remember the mood',
          normalizedCurrentUserMessage: 'remember the mood'
        }
      },
      legacySchema1PatchCompletedEvent(sessionId)
    ]);

    const completed = logStore
      .rawEvents()
      .find((event) => event.kind === 'runtime_turn_completed');

    expect(completed?.roleModelIOSnapshot?.inputEnvelope.allowedTools).toEqual([
      visibleReplyModelToolName,
      characterStatePatchModelToolName
    ]);
    expect(
      completed?.roleModelIOSnapshot?.inputEnvelope.pluginToolDefinitions
    ).toMatchObject([
      {
        pluginId: firstPartyModelToolsPluginId,
        name: visibleReplyModelToolName
      },
      {
        pluginId: 'character-state',
        name: characterStatePatchModelToolName
      }
    ]);
    expect(
      completed?.parsedRoleModelDecisionSnapshot?.result
    ).toMatchObject({
      status: 'accepted',
      decision: {
        toolCalls: [
          {
            name: characterStatePatchModelToolName,
            input: {
              mood: 'curious'
            }
          }
        ]
      }
    });
  });

  it('persists multi-line visible conversation records', async () => {
    const storeRoot = createStoreRoot();
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId: 'session-multiline-visible',
      createdAt: '2026-06-15T00:00:00.000Z'
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-multiline-visible'
    });
    const session = createConversationSession({
      id: 'session-multiline-visible'
    });
    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'list tools',
        identity('evt_multiline_visible')
      ),
      session,
      logStore,
      roleModelAdapter: createMultilineVisibleReplyAdapter()
    });

    expect(result.status).toBe('completed');
    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'list tools',
      'I can use:\n- plugin.list\n- character_state.patch'
    ]);
  });

  it('persists decodable commit validation for plugin health rejections', async () => {
    const storeRoot = createStoreRoot();
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId: 'session-health-rejected',
      createdAt: '2026-06-15T00:00:00.000Z'
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-health-rejected'
    });
    const session = createConversationSession({
      id: 'session-health-rejected'
    });

    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'health check',
        identity('evt_health_rejected')
      ),
      session,
      logStore,
      roleModelAdapter: createMultilineVisibleReplyAdapter(),
      pluginHost: createHealthRejectingPluginHost()
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_health_rejected',
      message: 'Plugin health unavailable: health fixture offline'
    });
    expect(logStore.conversationMessages()).toEqual([]);

    const rawEvents = logStore.rawEvents();
    const commitRejection = rawEvents.find(
      (event) => event.kind === 'commit_validation_rejected'
    );

    expect(commitRejection).toMatchObject({
      kind: 'commit_validation_rejected',
      status: 'rejected',
      reason: roleModelCommitValidationFailureRejectionReason,
      commitValidation: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelCommitValidationFailureRejectionReason,
            details: 'Plugin health unavailable: health fixture offline'
          }
        }
      },
      runtimePluginTurnEvidence: {
        health: [
          {
            pluginId: 'health.reject.fixture',
            status: 'unavailable',
            summary: 'health fixture offline'
          }
        ]
      }
    });
    expect(rawEvents.at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      reason: roleModelCommitValidationFailureRejectionReason,
      commitValidation: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelCommitValidationFailureRejectionReason,
            details: 'Plugin health unavailable: health fixture offline'
          }
        }
      }
    });
  });

  it('rejects degraded health snapshots when plugin health policy rejects turns', async () => {
    const storeRoot = createStoreRoot();
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId: 'session-health-degraded-rejected',
      createdAt: '2026-06-15T00:00:00.000Z'
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-health-degraded-rejected'
    });
    const session = createConversationSession({
      id: 'session-health-degraded-rejected'
    });

    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'health check',
        identity('evt_health_degraded_rejected')
      ),
      session,
      logStore,
      roleModelAdapter: createMultilineVisibleReplyAdapter(),
      pluginHost: createHealthRejectingPluginHost({
        status: 'degraded',
        summary: 'health fixture backpressure'
      })
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_health_rejected',
      message: 'Plugin health degraded: health fixture backpressure'
    });
    expect(logStore.conversationMessages()).toEqual([]);

    const rawEvents = logStore.rawEvents();
    const commitRejection = rawEvents.find(
      (event) => event.kind === 'commit_validation_rejected'
    );

    expect(commitRejection).toMatchObject({
      kind: 'commit_validation_rejected',
      status: 'rejected',
      reason: roleModelCommitValidationFailureRejectionReason,
      commitValidation: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelCommitValidationFailureRejectionReason,
            details: 'Plugin health degraded: health fixture backpressure'
          }
        }
      },
      runtimePluginEvidence: [
        {
          pluginId: 'health.reject.fixture',
          evidenceKind: 'health',
          status: 'degraded',
          summary: 'Plugin health degraded: health fixture backpressure',
          policyOutcome: 'health_degraded'
        }
      ],
      runtimePluginTurnEvidence: {
        health: [
          {
            pluginId: 'health.reject.fixture',
            status: 'degraded',
            summary: 'health fixture backpressure'
          }
        ]
      }
    });
    expect(rawEvents.at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      reason: roleModelCommitValidationFailureRejectionReason,
      commitValidation: {
        result: {
          status: 'rejected',
          rejection: {
            reason: roleModelCommitValidationFailureRejectionReason,
            details: 'Plugin health degraded: health fixture backpressure'
          }
        }
      }
    });
  });

  it('rejects started tool calls without matching finished records', async () => {
    const storeRoot = createStoreRoot();
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId: 'session-tools',
      createdAt: '2026-06-15T00:00:00.000Z'
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-tools'
    });

    appendTurnPrefix(logStore);
    logStore.appendRawEvent({
      ...identity(),
      kind: 'tool_call_started',
      eventType: 'USER_MESSAGE',
      toolCallId: 'round-1.1.memory.search',
      toolRound: 1,
      toolName: 'memory.search',
      toolPluginId: 'memory.fixture',
      toolInput: {
        query: 'Mira'
      }
    });

    expect(() => logStore.rawEvents()).toThrow(LocalRuntimeStorageContractError);
  });

  it('allows a rejected terminal turn to close an unfinished tool call start', async () => {
    const storeRoot = createStoreRoot();
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId: 'session-tools-rejected',
      createdAt: '2026-06-15T00:00:00.000Z'
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-tools-rejected'
    });
    const eventId = 'evt_tool_finish_log_failed';

    appendTurnPrefix(logStore, eventId);
    logStore.appendRawEvent({
      ...identity(eventId),
      kind: 'tool_call_started',
      eventType: 'USER_MESSAGE',
      toolCallId: 'round-1.1.memory.write',
      toolRound: 1,
      toolName: 'memory.write',
      toolPluginId: 'memory.fixture',
      toolInput: {
        value: 'planned'
      }
    });
    logStore.appendRawEvent({
      ...identity(eventId),
      kind: 'runtime_turn_rejected',
      eventType: 'USER_MESSAGE',
      status: 'rejected',
      reason: 'Runtime turn failed before producing a reply.'
    });
    logStore.appendTrace({
      ...identity(eventId),
      step: 'runtime_turn_rejected'
    });

    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected'
    });
  });

  it('rejects terminal events that reference unfinished tool calls', async () => {
    const storeRoot = createStoreRoot();
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId: 'session-terminal-tools',
      createdAt: '2026-06-15T00:00:00.000Z'
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'session-terminal-tools'
    });

    appendTurnPrefix(logStore, 'evt_terminal_tool_ref');
    expect(() =>
      logStore.appendRawEvent({
        ...identity('evt_terminal_tool_ref'),
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        status: 'completed',
        toolCallIds: ['round-1.1.memory.search']
      })
    ).toThrow(LocalRuntimeStorageContractError);
  });
});

function createStoreRoot(): string {
  return mkdtempSync(join(tmpdir(), 'project02-log-store-'));
}

function identity(eventId = 'evt_tool_events') {
  return createRuntimeEventIdentity({
    eventId,
    traceId: `trace_${eventId}`,
    createdAt: '2026-06-15T00:00:00.000Z'
  });
}

function appendTurnPrefix(
  logStore: ReturnType<typeof createFileRuntimeLogStore>,
  eventId = 'evt_tool_events'
): void {
  logStore.appendTrace({
    ...identity(eventId),
    step: 'runtime_event_received'
  });
  logStore.appendRawEvent({
    ...identity(eventId),
    kind: 'runtime_event_received',
    eventType: 'USER_MESSAGE'
  });
  logStore.appendRawEvent({
    ...identity(eventId),
    kind: 'runtime_event_normalized',
    eventType: 'USER_MESSAGE'
  });
}

function writeJsonLines(filePath: string, records: readonly object[]): void {
  writeFileSync(
    filePath,
    records.map((record) => `${JSON.stringify(record)}\n`).join(''),
    'utf8'
  );
}

function legacySchema1PatchCompletedEvent(sessionId: string): object {
  const eventIdentity = identity('evt_legacy_schema1_patch');
  const rawOutputText = JSON.stringify({
    toolCalls: [
      {
        name: characterStatePatchModelToolName,
        input: {
          mood: 'curious'
        }
      }
    ]
  });

  return {
    ...eventIdentity,
    kind: 'runtime_turn_completed',
    eventType: 'USER_MESSAGE',
    status: 'completed',
    roleModelIOSnapshot: {
      ...eventIdentity,
      kind: 'role_model_io_snapshot',
      sessionId,
      inputEnvelope: {
        event: {
          ...eventIdentity,
          type: 'USER_MESSAGE',
          payload: {
            currentUserMessage: 'remember the mood'
          }
        },
        decisionContext: {
          sessionId,
          characterSnapshot: {
            id: 'mira',
            displayName: 'Mira'
          },
          recentVisibleMessages: [],
          runtimeNotes: []
        },
        allowedTools: [
          visibleReplyModelToolName,
          characterStatePatchModelToolName
        ],
        toolObservations: [],
        outputContract: {
          version: roleModelDecisionContractVersion,
          text: 'legacy schema 1 output contract text'
        }
      },
      rawOutputText
    },
    parsedRoleModelDecisionSnapshot: {
      ...eventIdentity,
      kind: 'role_model_decision_snapshot',
      sessionId,
      result: {
        status: 'accepted',
        decision: {
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: characterStatePatchModelToolName,
              input: {
                mood: 'curious'
              }
            }
          ]
        }
      }
    },
    commitValidation: {
      ...eventIdentity,
      kind: 'role_model_commit_validation_snapshot',
      sessionId,
      result: {
        status: 'accepted'
      }
    }
  };
}

function createMultilineVisibleReplyAdapter(): RoleModelAdapter {
  return {
    invoke() {
      return {
        rawOutputText: JSON.stringify({
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'I can use:\n- plugin.list\n- character_state.patch'
              }
            }
          ]
        })
      };
    }
  };
}

function createHealthRejectingPluginHost(options?: {
  readonly status?: RuntimePluginHealthStatus;
  readonly summary?: string;
}) {
  const status = options?.status ?? 'unavailable';
  const summary = options?.summary ?? 'health fixture offline';

  return createRuntimePluginHost({
    plugins: [
      createRuntimePlugin({
        manifest: {
          id: 'health.reject.fixture',
          displayName: 'Health Reject Fixture',
          version: '1.0.0',
          kind: 'first_party',
          description: 'Test plugin that rejects turns during health checks.',
          contractVersion: runtimePluginContractVersion,
          compatibility: {
            hostContractVersions: [runtimePluginContractVersion],
            sourceSystem: 'test'
          },
          declaredPlugins: ['health'],
          config: {
            fields: []
          },
          localTrustLevel: 'test_fixture',
          runtimePolicy: {
            requiredForTurn: true,
            sideEffectLevel: 'runtime_read',
            confirmation: 'not_required',
            timeoutMs: 1000,
            sourceReferencesRequired: false,
            redactionLabels: [],
            failureBehavior: {
              beforeRoleModelCall: 'degrade',
              handleToolCall: 'reject_tool_call',
              afterTurnCommitted: 'log_failure',
              health: 'reject_turn'
            }
          },
          activation: {
            defaultEnabled: true,
            reasons: ['test']
          },
          requestedAccess: {}
        },
        providedTools: [],
        lifecycleHooks: {
          health(context) {
            return createRuntimePluginHealthSnapshot({
              pluginId: 'health.reject.fixture',
              status,
              checkedAt: context.timestamp,
              summary,
              redactionLabels: []
            });
          }
        }
      })
    ],
    enabledPluginIds: ['health.reject.fixture']
  });
}
