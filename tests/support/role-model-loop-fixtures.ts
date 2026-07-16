import {
  createDefaultRoleModelPluginToolDefinitions,
  createDecisionContext,
  type RoleModelPluginToolDefinition,
  type RoleModelProviderMetadata
} from '../../src/role-model/contracts.ts';
import {
  createRuntimePlugin,
  createRuntimePluginContext,
  createRuntimePluginEvidenceSnapshot,
  type RuntimePluginContext,
  type RuntimePlugin,
  type RuntimePluginToolCall,
  type RuntimePluginToolCallResult
} from '../../src/plugins/validation.ts';
import { runtimePluginContractVersion } from '../../src/plugins/contract.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent
} from '../../src/core/message-event.ts';
import { type RoleModelAdapter } from '../../src/role-model/loop.ts';

export const memorySearchToolDefinition = Object.freeze({
  pluginId: 'memory.search.fixture',
  name: 'memory.search',
  description: 'Search memory.',
  requiredForUserTurn: false,
  callLimit: {
    scope: 'user_turn',
    maxCalls: 1
  },
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

export const requiredMemorySearchToolDefinition = Object.freeze({
  ...memorySearchToolDefinition,
  requiredForUserTurn: true
} satisfies RoleModelPluginToolDefinition);

export const memoryRecallToolDefinition = Object.freeze({
  ...memorySearchToolDefinition,
  name: 'memory.recall',
  description: 'Recall memory.'
} satisfies RoleModelPluginToolDefinition);

export const visibleDotReplyToolDefinition = Object.freeze({
  ...memorySearchToolDefinition,
  pluginId: 'visible.reply.fixture',
  name: 'visible.reply',
  description: 'Exercise a provider-name collision with visible_reply.'
} satisfies RoleModelPluginToolDefinition);

export function withVisibleReplyTool(
  definition: RoleModelPluginToolDefinition
): readonly RoleModelPluginToolDefinition[] {
  return Object.freeze([
    ...createDefaultRoleModelPluginToolDefinitions(),
    definition
  ]);
}

export function createDegradingRejectedMemorySearchPlugin(): RuntimePlugin {
  const id = 'memory.search.fixture';

  return createRuntimePlugin({
    manifest: {
      id,
      displayName: 'Memory Search Fixture',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Search memory.',
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
          handleToolCall: 'degrade',
          afterTurnCommitted: 'log_failure',
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: true,
        reasons: ['test']
      },
      requestedAccess: { model_input: 'write' }
    },
    providedTools: [
      {
        name: 'memory.search',
        description: 'Search memory.',
        requiredForUserTurn: false,
        callLimit: {
          scope: 'user_turn',
          maxCalls: 1
        },
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
      }
    ],
    lifecycleHooks: {
      handleToolCall() {
        return {
          status: 'rejected',
          reason: 'handler_rejected',
          message: 'search backend degraded',
          evidence: []
        };
      }
    }
  });
}

export function createSequencedAdapter(
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

export function createProviderMetadataAdapter(
  providerMetadata: RoleModelProviderMetadata
): RoleModelAdapter {
  return Object.freeze({
    invoke() {
      return {
        rawOutputText: JSON.stringify({
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'hello'
              }
            }
          ]
        }),
        providerMetadata
      };
    }
  } satisfies RoleModelAdapter);
}

export function createAcceptedToolCallResult(): RuntimePluginToolCallResult {
  return Object.freeze({
    status: 'accepted',
    output: Object.freeze({
      ok: true
    }),
    evidence: Object.freeze([])
  } satisfies RuntimePluginToolCallResult);
}

export function createAcceptedToolCallResultWithBlockingEvidence(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly evidenceStatus: 'rejected' | 'failed';
}): RuntimePluginToolCallResult {
  return Object.freeze({
    status: 'accepted',
    output: Object.freeze({
      ok: true
    }),
    evidence: Object.freeze([
      createRuntimePluginEvidenceSnapshot({
        eventId: options.context.eventId,
        traceId: options.context.traceId,
        createdAt: options.context.timestamp,
        kind: 'runtime_plugin_evidence_snapshot',
        pluginId: options.call.pluginId,
        evidenceKind: 'tool_invocation',
        status: options.evidenceStatus,
        summary: 'search backend failed',
        policyOutcome:
          options.evidenceStatus === 'failed' ? 'timeout' : 'handler_rejected',
        redactionLabels: []
      })
    ])
  } satisfies RuntimePluginToolCallResult);
}

export function createRejectedToolCallResult(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly evidenceStatus: 'rejected' | 'degraded';
  readonly policyOutcome: 'handler_rejected' | 'optional_degraded';
}): RuntimePluginToolCallResult {
  return createRejectedToolCallResultWithEvidence({
    call: options.call,
    context: options.context,
    evidence: [
      {
        status: options.evidenceStatus,
        policyOutcome: options.policyOutcome
      }
    ]
  });
}

export function createRejectedToolCallResultWithEvidence(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly evidence: readonly {
    readonly status: 'rejected' | 'degraded';
    readonly policyOutcome: 'handler_rejected' | 'optional_degraded';
  }[];
}): RuntimePluginToolCallResult {
  return Object.freeze({
    status: 'rejected',
    reason: 'handler_failed',
    message: 'search backend failed',
    evidence: options.evidence.map((evidence) =>
      createRuntimePluginEvidenceSnapshot({
        eventId: options.context.eventId,
        traceId: options.context.traceId,
        createdAt: options.context.timestamp,
        kind: 'runtime_plugin_evidence_snapshot',
        pluginId: options.call.pluginId,
        evidenceKind: 'tool_invocation',
        status: evidence.status,
        summary: 'search backend failed',
        policyOutcome: evidence.policyOutcome,
        redactionLabels: []
      })
    )
  } satisfies RuntimePluginToolCallResult);
}

export function createTestDecisionContext() {
  return createDecisionContext({
    sessionId: 'session-loop',
    characterSnapshot: {
      id: 'mira',
      displayName: 'Mira'
    }
  });
}

export function createTestPluginContext(
  eventId: string,
  traceId = `trace_${eventId}`
): RuntimePluginContext {
  return createRuntimePluginContext({
    ...createRuntimeEventIdentity({
      eventId,
      traceId,
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

export function createTestEvent(
  message: string,
  eventId: string,
  traceId = `trace_${eventId}`
) {
  return createUserMessageRuntimeEvent(
    message,
    createRuntimeEventIdentity({
      eventId,
      traceId,
      createdAt: '2026-06-15T00:00:00.000Z'
    })
  );
}

export function parseTestJson(value: string): unknown {
  const parsed: unknown = JSON.parse(value);

  return parsed;
}
