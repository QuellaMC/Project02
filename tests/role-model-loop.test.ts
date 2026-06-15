import { describe, expect, it } from 'vitest';

import {
  createDecisionContext,
  roleModelPluginToolRejectedRejectionReason,
  type RoleModelPluginToolDefinition
} from '../src/role-model/contracts.ts';
import {
  createRuntimePluginContext,
  createRuntimePluginEvidenceSnapshot,
  type RuntimePluginContext,
  type RuntimePluginToolCall,
  type RuntimePluginToolCallResult
} from '../src/plugins/types.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent
} from '../src/runtime/event.ts';
import {
  runRoleModelLoop,
  type RoleModelAdapter,
  type RoleModelPluginToolHost
} from '../src/role-model/loop.ts';

describe('role-model loop plugin tool routing', () => {
  it('rejects non-degrading plugin tool failures before a later visible reply can commit', async () => {
    let invocations = 0;
    let handledCalls = 0;
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'memory.search',
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
              text: 'continued after rejected tool'
            }
          }
        ]
      }
    ], () => {
      invocations += 1;
    });
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      handleToolCall(call, context) {
        handledCalls += 1;

        return createRejectedToolCallResult({
          call,
          context,
          evidenceStatus: 'rejected',
          policyOutcome: 'handler_rejected'
        });
      }
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_rejected_plugin_tool'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_rejected_plugin_tool')
    });

    expect(result).toMatchObject({
      status: 'rejected',
      rejection: {
        reason: roleModelPluginToolRejectedRejectionReason
      }
    });
    expect(invocations).toBe(1);
    expect(handledCalls).toBe(1);
    expect(result.pluginToolResults).toHaveLength(1);
    expect(result.pluginToolResults[0]).toMatchObject({
      callId: 'round-1.1.memory.search',
      call: {
        pluginId: 'memory.search.fixture',
        toolName: 'memory.search'
      },
      result: {
        status: 'rejected',
        reason: 'handler_failed'
      }
    });
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.pluginToolResults).toHaveLength(1);
  });

  it('continues prompting after optional degraded plugin tool failures', async () => {
    let invocations = 0;
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'memory.search',
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
              text: 'continued after degraded tool'
            }
          }
        ]
      }
    ], () => {
      invocations += 1;
    });
    const pluginToolHost: RoleModelPluginToolHost = Object.freeze({
      handleToolCall(call, context) {
        return createRejectedToolCallResult({
          call,
          context,
          evidenceStatus: 'degraded',
          policyOutcome: 'optional_degraded'
        });
      }
    });

    const result = await runRoleModelLoop({
      event: createTestEvent('search memory', 'evt_degraded_plugin_tool'),
      decisionContext: createTestDecisionContext(),
      adapter,
      pluginToolDefinitions: [memorySearchToolDefinition],
      pluginToolHost,
      runtimePluginContext: createTestPluginContext('evt_degraded_plugin_tool')
    });

    expect(result.status).toBe('accepted');
    expect(invocations).toBe(2);
    expect(result.pluginToolResults).toHaveLength(1);
    expect(result.pluginToolResults[0]?.result.status).toBe('rejected');
  });
});

const memorySearchToolDefinition = Object.freeze({
  pluginId: 'memory.search.fixture',
  name: 'memory.search',
  description: 'Search memory.',
  requiredForUserTurn: false,
  maxCallsPerUserTurn: 1,
  inputContract: {
    type: 'object',
    fields: [
      {
        name: 'query',
        description: 'Search query.',
        required: true
      }
    ],
    additionalFields: false
  },
  validationOwner: 'plugin_host',
  sideEffectLevel: 'runtime_read',
  requiresConfirmation: false,
  sourceReferencesRequired: false
} satisfies RoleModelPluginToolDefinition);

function createSequencedAdapter(
  decisions: readonly Readonly<Record<string, unknown>>[],
  onInvoke: () => void
): RoleModelAdapter {
  let index = 0;

  return Object.freeze({
    invoke() {
      const decision = decisions[index] ?? decisions.at(-1);

      if (decision === undefined) {
        throw new Error('Sequenced adapter needs at least one decision.');
      }

      index += 1;
      onInvoke();

      return {
        rawOutputText: JSON.stringify(decision)
      };
    }
  } satisfies RoleModelAdapter);
}

function createRejectedToolCallResult(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly evidenceStatus: 'rejected' | 'degraded';
  readonly policyOutcome: 'handler_rejected' | 'optional_degraded';
}): RuntimePluginToolCallResult {
  return Object.freeze({
    status: 'rejected',
    reason: 'handler_failed',
    message: 'search backend failed',
    evidence: [
      createRuntimePluginEvidenceSnapshot({
        eventId: options.context.eventId,
        traceId: options.context.traceId,
        createdAt: options.context.timestamp,
        kind: 'runtime_plugin_evidence_snapshot',
        pluginId: options.call.pluginId,
        evidenceKind: 'tool_invocation',
        status: options.evidenceStatus,
        summary: 'search backend failed',
        policyOutcome: options.policyOutcome,
        redactionLabels: []
      })
    ]
  } satisfies RuntimePluginToolCallResult);
}

function createTestDecisionContext() {
  return createDecisionContext({
    sessionId: 'session-loop',
    characterSnapshot: {
      id: 'mira',
      displayName: 'Mira'
    }
  });
}

function createTestPluginContext(eventId: string): RuntimePluginContext {
  return createRuntimePluginContext({
    ...createRuntimeEventIdentity({
      eventId,
      traceId: `trace_${eventId}`,
      createdAt: '2026-06-15T00:00:00.000Z'
    }),
    sessionId: 'session-loop',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'search memory',
    character: {
      id: 'mira',
      displayName: 'Mira'
    }
  });
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
