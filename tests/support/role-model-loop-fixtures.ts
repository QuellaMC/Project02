import {testCharacterProfile} from './character-fixtures.ts';
import {
  createDecisionContext,
  type RoleModelAdapter,
  type RoleModelAdapterInvocation,
  type RoleModelPluginToolDefinition,
  type RoleModelPluginToolHost,
  type RoleModelProviderMetadata,
  type RoleModelReplyDelta,
  type RoleModelRoundEvent,
  type RunRoleModelLoopOptions,
} from '../../src/role-model/index.ts';
import {
  createRuntimePlugin,
  createRuntimePluginContext,
  createRuntimePluginEvidenceSnapshot,
  type RuntimePluginContext,
  type RuntimePlugin,
  type RuntimePluginToolCall,
  type RuntimePluginToolCallResult,
} from '../../src/plugins/api/index.ts';
import {runtimePluginContractVersion} from '../../src/plugins/api/contract.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  type VisibleMessage,
} from '../../src/core/index.ts';

export const memorySearchToolDefinition = Object.freeze({
  pluginId: 'memory.search.fixture',
  name: 'memory.search',
  description: 'Search memory.',
  inputContract: {
    type: 'object',
    properties: {
      query: {type: 'string', description: 'Search query.'},
    },
    required: ['query'],
    additionalProperties: false,
  },
  validationOwner: 'plugin_host',
  requiresConfirmation: false,
} satisfies RoleModelPluginToolDefinition);

export const memoryRecallToolDefinition = Object.freeze({
  ...memorySearchToolDefinition,
  name: 'memory.recall',
  description: 'Recall memory.',
} satisfies RoleModelPluginToolDefinition);

export function toolWithConcurrency(
  definition: RoleModelPluginToolDefinition,
  concurrency: 'shared' | 'exclusive',
): RoleModelPluginToolDefinition {
  return Object.freeze({...definition, concurrency});
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
          handleToolCall: 'degrade',
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
      {
        name: 'memory.search',
        description: 'Search memory.',
        inputContract: {
          type: 'object',
          properties: {
            query: {type: 'string', description: 'Search query.'},
          },
          required: ['query'],
          additionalProperties: false,
        },
        validationOwner: 'plugin_host',
        requiresConfirmation: false,
      },
    ],
    lifecycleHooks: {
      handleToolCall() {
        return {
          status: 'rejected',
          reason: 'handler_rejected',
          message: 'search backend degraded',
          evidence: [],
        };
      },
    },
  });
}

/**
 * One decision per round, the last one repeating; `deltas[round]` is what the
 * adapter speaks through the ear before it returns that round's decision.
 */
export function createSequencedAdapter(
  decisions: readonly Readonly<Record<string, unknown>>[],
  onInvoke?: (invocation: RoleModelAdapterInvocation) => void,
  deltas: readonly (readonly RoleModelReplyDelta[])[] = [],
): RoleModelAdapter {
  let index = 0;

  return Object.freeze({
    invoke(_inputEnvelope, invocation) {
      const decision = decisions[index] ?? decisions.at(-1);

      if (decision === undefined) {
        throw new Error('Sequenced adapter needs at least one decision.');
      }

      for (const delta of deltas[index] ?? []) {
        invocation.onReplyDelta?.(delta);
      }

      index += 1;
      onInvoke?.(invocation);

      return {
        rawOutputText: JSON.stringify(decision),
      };
    },
  } satisfies RoleModelAdapter);
}

export function createProviderMetadataAdapter(
  providerMetadata: RoleModelProviderMetadata,
): RoleModelAdapter {
  return Object.freeze({
    invoke() {
      return {
        rawOutputText: JSON.stringify({
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'hello',
              },
            },
          ],
        }),
        providerMetadata,
      };
    },
  } satisfies RoleModelAdapter);
}

/**
 * The loop's required callbacks, standing in for the runtime: every round is
 * collected as the runtime would record it, and every reply is handed back
 * as committed, so tool rounds can replay what the person was told.
 */
export function testLoopCallbacks(
  options: {
    readonly rounds?: RoleModelRoundEvent[];
    readonly onReply?: (text: string) => void;
  } = {},
): Pick<RunRoleModelLoopOptions, 'onRound' | 'onVisibleReply'> {
  let count = 0;

  return {
    onRound(event) {
      options.rounds?.push(event);
    },
    onVisibleReply(event) {
      count += 1;
      options.onReply?.(event.text);

      return Object.freeze({
        id: `session-loop:message-${String(count)}`,
        role: 'character',
        speakerId: testCharacterProfile.id,
        speakerName: testCharacterProfile.displayName,
        text: event.text,
      } satisfies VisibleMessage);
    },
  };
}

/** A host that accepts every call: for turns whose tools are not the subject. */
export const acceptingPluginToolHost: RoleModelPluginToolHost = Object.freeze({
  handleToolCall: () => createAcceptedToolCallResult(),
});

export function createAcceptedToolCallResult(): RuntimePluginToolCallResult {
  return Object.freeze({
    status: 'accepted',
    output: Object.freeze({
      ok: true,
    }),
    evidence: Object.freeze([]),
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
      ok: true,
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
        redactionLabels: [],
      }),
    ]),
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
        policyOutcome: options.policyOutcome,
      },
    ],
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
    evidence: options.evidence.map(evidence =>
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
        redactionLabels: [],
      }),
    ),
  } satisfies RuntimePluginToolCallResult);
}

export function createTestDecisionContext() {
  return createDecisionContext({
    sessionId: 'session-loop',
    characterSnapshot: testCharacterProfile,
  });
}

export function createTestPluginContext(
  eventId: string,
  traceId = `trace_${eventId}`,
): RuntimePluginContext {
  return createRuntimePluginContext({
    ...createRuntimeEventIdentity({
      eventId,
      traceId,
      createdAt: '2026-06-15T00:00:00.000Z',
    }),
    sessionId: 'session-loop',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'search memory',
    character: testCharacterProfile,
  });
}

export function createTestEvent(
  message: string,
  eventId: string,
  traceId = `trace_${eventId}`,
) {
  return createUserMessageRuntimeEvent(
    message,
    createRuntimeEventIdentity({
      eventId,
      traceId,
      createdAt: '2026-06-15T00:00:00.000Z',
    }),
  );
}

export function parseTestJson(value: string): unknown {
  const parsed: unknown = JSON.parse(value);

  return parsed;
}
