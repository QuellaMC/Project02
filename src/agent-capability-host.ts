import {
  agentCapabilityContractVersion,
  createAgentCapability,
  createAgentCapabilityContextItem,
  createAgentCapabilityEvidenceSnapshot,
  createFirstPartyModelToolsCapability,
  createAgentCapabilityHealthSnapshot,
  createAgentCapabilityRegistrySnapshot,
  redactAgentCapabilityText
} from './agent-capabilities.ts';
import type {
  AgentCapability,
  AgentCapabilityBeforeRoleModelCallResult,
  AgentCapabilityContextItem,
  AgentCapabilityEvidenceKind,
  AgentCapabilityEvidenceSnapshot,
  AgentCapabilityEvidenceStatus,
  AgentCapabilityHealthSnapshot,
  AgentCapabilityHookResult,
  AgentCapabilityJsonObject,
  AgentCapabilityJsonValue,
  AgentCapabilityProvidedTool,
  AgentCapabilityToolCall,
  AgentCapabilityToolCallResult,
  AgentCapabilityPolicyOutcome,
  AgentCapabilityRegistrySnapshot,
  AgentCapabilitySourceReference,
  RuntimeCapabilityAfterTurnCommittedContext,
  RuntimeCapabilityContext
} from './agent-capabilities.ts';
import { isBuiltInModelToolName } from './model-tools.ts';
import {
  createRoleModelCapabilityToolDefinitions,
  roleModelCapabilityListToolName,
  type RoleModelCapabilityToolDefinition
} from './role-model-contracts.ts';

export const runtimeCapabilityBeforeRoleModelCallRejectionReason =
  'capability_before_role_model_call_rejected';
export const runtimeCapabilityDiscoveryCapabilityId =
  'runtime.capability_discovery';

const runtimeCapabilityDiscoveryMaxCapabilities = 16;
const runtimeCapabilityDiscoveryMaxToolsPerCapability = 8;
const runtimeCapabilityDiscoveryMaxTextLength = 160;

export type RuntimeCapabilityBeforeRoleModelCallRejectionReason =
  typeof runtimeCapabilityBeforeRoleModelCallRejectionReason;

export type CreateRuntimeCapabilityHostOptions = {
  readonly capabilities?: readonly AgentCapability[];
  readonly enabledCapabilityIds?: readonly string[];
};

export type RuntimeCapabilityBeforeRoleModelCallCompletedResult = {
  readonly status: 'completed';
  readonly contextItems: readonly AgentCapabilityContextItem[];
  readonly runtimeNotes: readonly string[];
  readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
};

export type RuntimeCapabilityBeforeRoleModelCallRejectedResult = {
  readonly status: 'rejected';
  readonly reason: RuntimeCapabilityBeforeRoleModelCallRejectionReason;
  readonly capabilityId: string;
  readonly message: string;
  readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
};

export type RuntimeCapabilityBeforeRoleModelCallHostResult =
  | RuntimeCapabilityBeforeRoleModelCallCompletedResult
  | RuntimeCapabilityBeforeRoleModelCallRejectedResult;

export type RuntimeCapabilityHookHostResult = {
  readonly status: 'completed' | 'completed_with_failures';
  readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
};

export type RuntimeCapabilityHealthHostResult = {
  readonly snapshots: readonly AgentCapabilityHealthSnapshot[];
  readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
};

const runtimeCapabilityContextEstimatedTokenBudget = 256;

export type RuntimeCapabilityHost = {
  registrySnapshot(): AgentCapabilityRegistrySnapshot;
  enabledCapabilityIds(): readonly string[];
  capabilityToolDefinitions(): readonly RoleModelCapabilityToolDefinition[];
  beforeRoleModelCall(
    context: RuntimeCapabilityContext
  ): Promise<RuntimeCapabilityBeforeRoleModelCallHostResult>;
  handleToolCall(
    call: AgentCapabilityToolCall,
    context: RuntimeCapabilityContext
  ): Promise<AgentCapabilityToolCallResult>;
  afterTurnCommitted(
    context: RuntimeCapabilityAfterTurnCommittedContext
  ): Promise<RuntimeCapabilityHookHostResult>;
  onSessionEnd(
    context: RuntimeCapabilityContext
  ): Promise<RuntimeCapabilityHookHostResult>;
  health(context: RuntimeCapabilityContext): Promise<RuntimeCapabilityHealthHostResult>;
};

type BeforeRoleModelCallInvocationResult =
  | {
      readonly status: 'accepted';
      readonly value: AgentCapabilityBeforeRoleModelCallResult;
    }
    | {
        readonly status: 'failed';
        readonly message: string;
        readonly failureKind: 'exception' | 'timeout';
      };

type HookInvocationResult =
  | {
      readonly status: 'accepted';
      readonly value: AgentCapabilityHookResult;
    }
    | {
        readonly status: 'failed';
        readonly message: string;
        readonly failureKind: 'exception' | 'timeout';
      };

type CollectedCapabilityContextItem = {
  readonly capability: AgentCapability;
  readonly item: AgentCapabilityContextItem;
  readonly originalIndex: number;
};

type BoundedCapabilityContextItemsResult =
  | {
      readonly status: 'completed';
      readonly contextItems: readonly AgentCapabilityContextItem[];
      readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
    }
  | {
      readonly status: 'rejected';
      readonly capabilityId: string;
      readonly message: string;
      readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
    };

export function createRuntimeCapabilityHost(
  options: CreateRuntimeCapabilityHostOptions = {}
): RuntimeCapabilityHost {
  const configuredCapabilities = Object.freeze([...(options.capabilities ?? [])]);
  let enabledCapabilities: readonly AgentCapability[] = [];
  const capabilities = Object.freeze([
    createRuntimeCapabilityDiscoveryCapability(() => enabledCapabilities),
    ...configuredCapabilities
  ]);
  const registrySnapshot = createAgentCapabilityRegistrySnapshot(capabilities);
  const enabledIds = enabledCapabilityIdsForHost({
    capabilities,
    enabledCapabilityIds: options.enabledCapabilityIds
  });
  enabledCapabilities = Object.freeze(
    capabilities.filter((capability) => enabledIds.includes(capability.manifest.id))
  );
  const capabilityToolDefinitions = createRoleModelCapabilityToolDefinitions(
    capabilityToolDefinitionsForEnabledCapabilities(enabledCapabilities)
  );

  return Object.freeze({
    registrySnapshot() {
      return registrySnapshot;
    },
    enabledCapabilityIds() {
      return Object.freeze([...enabledIds]);
    },
    capabilityToolDefinitions() {
      return capabilityToolDefinitions;
    },
    async beforeRoleModelCall(context) {
      return await runBeforeRoleModelCall({
        capabilities: enabledCapabilities,
        context
      });
    },
    async handleToolCall(call, context) {
      return await runHandleToolCall({
        capabilities: enabledCapabilities,
        call,
        context
      });
    },
    async afterTurnCommitted(context) {
      return await runHookPhase({
        capabilities: enabledCapabilities,
        context,
        hookName: 'afterTurnCommitted',
        evidenceKind: 'after_turn_committed',
        hookForCapability: (capability) =>
          capability.lifecycleHooks.afterTurnCommitted
      });
    },
    async onSessionEnd(context) {
      return await runHookPhase({
        capabilities: enabledCapabilities,
        context,
        hookName: 'onSessionEnd',
        evidenceKind: 'session_end',
        hookForCapability: (capability) => capability.lifecycleHooks.onSessionEnd
      });
    },
    async health(context) {
      return await runHealth({
        capabilities: enabledCapabilities,
        context
      });
    }
  } satisfies RuntimeCapabilityHost);
}

export function createDefaultProject02CapabilityHost(): RuntimeCapabilityHost {
  return createRuntimeCapabilityHost({
    capabilities: [createFirstPartyModelToolsCapability()]
  });
}

function createRuntimeCapabilityDiscoveryCapability(
  enabledCapabilitiesForTurn: () => readonly AgentCapability[]
): AgentCapability {
  return createAgentCapability({
    manifest: {
      id: runtimeCapabilityDiscoveryCapabilityId,
      displayName: 'Runtime capability discovery',
      version: '1.0.0',
      kind: 'first_party',
      description:
        'Host-owned read-only capability list for safe current-turn discovery.',
      contractVersion: agentCapabilityContractVersion,
      compatibility: {
        hostContractVersions: [agentCapabilityContractVersion],
        sourceSystem: 'project02',
        externalContract: 'runtime_capability_discovery'
      },
      declaredCapabilities: ['tool_provider', 'handle_tool_call'],
      config: {
        fields: []
      },
      localTrustLevel: 'first_party',
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
        reasons: ['host_provided_current_turn_discovery']
      }
    },
    providedTools: [
      {
        name: roleModelCapabilityListToolName,
        description:
          'Return safe summaries for capabilities available in the current turn.',
        requiredForUserTurn: false,
        maxCallsPerUserTurn: 1,
        inputContract: {
          type: 'object',
          fields: [],
          additionalFields: false
        },
        validationOwner: 'capability_host',
        sideEffectLevel: 'runtime_read',
        requiresConfirmation: false,
        sourceReferencesRequired: false
      }
    ],
    lifecycleHooks: {
      handleToolCall(_call, context) {
        const output = createCapabilityDiscoveryOutput(
          enabledCapabilitiesForTurn()
        );

        return {
          status: 'accepted',
          output,
          evidence: [
            createAgentCapabilityEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'agent_capability_evidence_snapshot',
              capabilityId: runtimeCapabilityDiscoveryCapabilityId,
              evidenceKind: 'tool_invocation',
              status: 'accepted',
              summary: `Returned ${String(
                output.capabilities.length
              )} current-turn capability summaries.`,
              redactionLabels: context.privacy.redactionLabels
            })
          ]
        };
      }
    }
  });
}

function createCapabilityDiscoveryOutput(
  enabledCapabilities: readonly AgentCapability[]
): AgentCapabilityJsonObject & {
  readonly capabilities: readonly AgentCapabilityJsonValue[];
} {
  const boundedCapabilities = enabledCapabilities.slice(
    0,
    runtimeCapabilityDiscoveryMaxCapabilities
  );

  return Object.freeze({
    capabilities: Object.freeze(
      boundedCapabilities.map(createCapabilityDiscoverySummary)
    ),
    truncated:
      enabledCapabilities.length > runtimeCapabilityDiscoveryMaxCapabilities
  } satisfies AgentCapabilityJsonObject & {
    readonly capabilities: readonly AgentCapabilityJsonValue[];
  });
}

function createCapabilityDiscoverySummary(
  capability: AgentCapability
): AgentCapabilityJsonObject {
  const discoverableTools = discoverableCurrentTurnCapabilityTools(capability);
  const safeTools = discoverableTools
    .slice(0, runtimeCapabilityDiscoveryMaxToolsPerCapability)
    .map(createCapabilityDiscoveryToolSummary);

  return Object.freeze({
    id: boundedCapabilityDiscoveryText(capability.manifest.id),
    displayName: boundedCapabilityDiscoveryText(capability.manifest.displayName),
    kind: capability.manifest.kind,
    availableForTurn: true,
    providedTools: Object.freeze(safeTools),
    toolsTruncated:
      discoverableTools.length > runtimeCapabilityDiscoveryMaxToolsPerCapability
  } satisfies AgentCapabilityJsonObject);
}

function createCapabilityDiscoveryToolSummary(
  tool: AgentCapabilityProvidedTool
): AgentCapabilityJsonObject {
  return Object.freeze({
    name: boundedCapabilityDiscoveryText(tool.name),
    sideEffectLevel: tool.sideEffectLevel,
    requiredForUserTurn: tool.requiredForUserTurn,
    maxCallsPerUserTurn: tool.maxCallsPerUserTurn
  } satisfies AgentCapabilityJsonObject);
}

function boundedCapabilityDiscoveryText(value: string): string {
  if (value.length <= runtimeCapabilityDiscoveryMaxTextLength) {
    return value;
  }

  return `${value.slice(0, runtimeCapabilityDiscoveryMaxTextLength - 3)}...`;
}

async function runBeforeRoleModelCall(options: {
  readonly capabilities: readonly AgentCapability[];
  readonly context: RuntimeCapabilityContext;
}): Promise<RuntimeCapabilityBeforeRoleModelCallHostResult> {
  const contextItems: CollectedCapabilityContextItem[] = [];
  const runtimeNotes: string[] = [];
  const evidence: AgentCapabilityEvidenceSnapshot[] = [];

  for (const capability of options.capabilities) {
    const hook = capability.lifecycleHooks.beforeRoleModelCall;

    if (hook === undefined) {
      continue;
    }

    const result = await invokeBeforeRoleModelCallHook({
      capability,
      context: options.context,
      hook
    });

    if (result.status === 'accepted') {
      for (const contextItem of result.value.contextItems) {
        contextItems.push({
          capability,
          item: contextItem,
          originalIndex: contextItems.length
        });
      }
      runtimeNotes.push(...result.value.runtimeNotes);
      evidence.push(...result.value.evidence);
      continue;
    }

    const rejectsTurn = beforeRoleModelFailureRejectsTurn(capability);
    const policyOutcome =
      result.failureKind === 'timeout'
        ? 'timeout'
        : rejectsTurn
          ? 'required_rejected'
          : 'optional_degraded';
    const failureEvidence = createHookFailureEvidence({
      capability,
      context: options.context,
      evidenceKind: 'before_role_model_call',
      status: rejectsTurn ? 'rejected' : 'degraded',
      summary: rejectsTurn
        ? `Required before-role-model capability hook rejected the turn: ${result.message}`
        : `Optional before-role-model capability hook degraded: ${result.message}`,
      policyOutcome
    });

    evidence.push(failureEvidence);

    if (rejectsTurn) {
      return Object.freeze({
        status: 'rejected',
        reason: runtimeCapabilityBeforeRoleModelCallRejectionReason,
        capabilityId: capability.manifest.id,
        message: result.message,
        evidence: Object.freeze([...evidence])
      } satisfies RuntimeCapabilityBeforeRoleModelCallHostResult);
    }
  }

  const boundedContext = boundCapabilityContextItems({
    context: options.context,
    contextItems
  });
  evidence.push(...boundedContext.evidence);

  if (boundedContext.status === 'rejected') {
    return Object.freeze({
      status: 'rejected',
      reason: runtimeCapabilityBeforeRoleModelCallRejectionReason,
      capabilityId: boundedContext.capabilityId,
      message: boundedContext.message,
      evidence: Object.freeze([...evidence])
    } satisfies RuntimeCapabilityBeforeRoleModelCallHostResult);
  }

  return Object.freeze({
    status: 'completed',
    contextItems: boundedContext.contextItems,
    runtimeNotes: Object.freeze([...runtimeNotes]),
    evidence: Object.freeze([...evidence])
  } satisfies RuntimeCapabilityBeforeRoleModelCallHostResult);
}

async function runHandleToolCall(options: {
  readonly capabilities: readonly AgentCapability[];
  readonly call: AgentCapabilityToolCall;
  readonly context: RuntimeCapabilityContext;
}): Promise<AgentCapabilityToolCallResult> {
  const capability = options.capabilities.find(
    (candidate) => candidate.manifest.id === options.call.capabilityId
  );

  if (capability === undefined) {
    return createRejectedToolCallResult({
      call: options.call,
      context: options.context,
      reason: 'capability_not_enabled',
      message: `Capability "${options.call.capabilityId}" is not enabled for this turn.`
    });
  }

  const providedTool = capability.providedTools.find(
    (tool) => tool.name === options.call.toolName
  );

  if (providedTool === undefined) {
    return createRejectedToolCallResult({
      call: options.call,
      context: options.context,
      reason: 'tool_not_declared',
      message: `Capability "${capability.manifest.id}" did not declare tool "${options.call.toolName}".`
    });
  }

  const hook = capability.lifecycleHooks.handleToolCall;
  const failureDegrades = handleToolCallFailureDegrades({
    capability,
    providedTool
  });

  if (hook === undefined) {
    return createRejectedToolCallResult({
      call: options.call,
      context: options.context,
      reason: 'handler_missing',
      message: `Capability "${capability.manifest.id}" has no handleToolCall hook.`,
      evidenceStatus: failureDegrades ? 'degraded' : 'rejected',
      policyOutcome: failureDegrades ? 'optional_degraded' : 'handler_rejected'
    });
  }

  try {
    return normalizeToolCallResult({
      capability,
      providedTool,
      context: options.context,
      value: await withCapabilityHookTimeout({
        capability,
        hookName: 'handleToolCall',
        operation: async () => await hook(options.call, options.context)
      })
    });
  } catch (error: unknown) {
    if (error instanceof CapabilityHookTimeoutError) {
      return createRejectedToolCallResult({
        call: options.call,
        context: options.context,
        reason: 'handler_timeout',
        message: error.message,
        evidenceStatus: failureDegrades ? 'degraded' : 'failed',
        policyOutcome: 'timeout'
      });
    }

    return createRejectedToolCallResult({
      call: options.call,
      context: options.context,
      reason: 'handler_failed',
      message: errorMessage(error),
      evidenceStatus: failureDegrades ? 'degraded' : 'rejected',
      policyOutcome: failureDegrades ? 'optional_degraded' : 'handler_rejected'
    });
  }
}

async function runHookPhase<TContext extends RuntimeCapabilityContext>(options: {
  readonly capabilities: readonly AgentCapability[];
  readonly context: TContext;
  readonly hookName: 'afterTurnCommitted' | 'onSessionEnd';
  readonly evidenceKind: Extract<AgentCapabilityEvidenceKind, 'after_turn_committed' | 'session_end'>;
  readonly hookForCapability: (
    capability: AgentCapability
  ) => ((context: TContext) => AgentCapabilityHookResult | Promise<AgentCapabilityHookResult>) | undefined;
}): Promise<RuntimeCapabilityHookHostResult> {
  const evidence: AgentCapabilityEvidenceSnapshot[] = [];
  let failed = false;

  for (const capability of options.capabilities) {
    const hook = options.hookForCapability(capability);

    if (hook === undefined) {
      continue;
    }

    const result = await invokeHook({
      capability,
      context: options.context,
      hookName: options.hookName,
      hook
    });

    if (result.status === 'failed') {
      failed = true;
      evidence.push(
        createHookFailureEvidence({
          capability,
          context: options.context,
          evidenceKind: options.evidenceKind,
          status: 'failed',
          summary: `${options.hookName} capability hook failed: ${result.message}`,
          ...failurePolicyOutcomeOption(options.evidenceKind, result.failureKind)
        })
      );
      continue;
    }

    evidence.push(...result.value.evidence);

    if (result.value.status === 'failed') {
      failed = true;

      if (
        !hookEvidenceRecordsFailure({
          evidence: result.value.evidence,
          evidenceKind: options.evidenceKind
        })
      ) {
        evidence.push(
          createHookFailureEvidence({
            capability,
            context: options.context,
            evidenceKind: options.evidenceKind,
            status: 'failed',
            summary: `${options.hookName} capability hook reported failure.`,
            ...failurePolicyOutcomeOption(options.evidenceKind, 'exception')
          })
        );
      }
    }
  }

  return Object.freeze({
    status: failed ? 'completed_with_failures' : 'completed',
    evidence: Object.freeze([...evidence])
  } satisfies RuntimeCapabilityHookHostResult);
}

function hookEvidenceRecordsFailure(options: {
  readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
  readonly evidenceKind: Extract<AgentCapabilityEvidenceKind, 'after_turn_committed' | 'session_end'>;
}): boolean {
  return evidenceRecordsStatus({
    evidence: options.evidence,
    evidenceKind: options.evidenceKind,
    statuses: ['failed']
  });
}

function evidenceRecordsStatus(options: {
  readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
  readonly evidenceKind: AgentCapabilityEvidenceKind;
  readonly statuses: readonly AgentCapabilityEvidenceStatus[];
}): boolean {
  return options.evidence.some(
    (item) =>
      item.evidenceKind === options.evidenceKind &&
      options.statuses.includes(item.status)
  );
}

function capabilityToolDefinitionsForEnabledCapabilities(
  capabilities: readonly AgentCapability[]
): readonly RoleModelCapabilityToolDefinition[] {
  return Object.freeze(
    capabilities.flatMap((capability) => {
      return routableModelFacingCapabilityTools(capability).map((tool) =>
        Object.freeze({
          capabilityId: capability.manifest.id,
          ...tool
        } satisfies RoleModelCapabilityToolDefinition)
      );
    })
  );
}

function routableModelFacingCapabilityTools(
  capability: AgentCapability
): readonly AgentCapabilityProvidedTool[] {
  if (capability.lifecycleHooks.handleToolCall === undefined) {
    return [];
  }

  return Object.freeze(capability.providedTools.filter(isModelFacingCapabilityTool));
}

function discoverableCurrentTurnCapabilityTools(
  capability: AgentCapability
): readonly AgentCapabilityProvidedTool[] {
  return Object.freeze(
    capability.providedTools.filter((tool) =>
      isDiscoverableCurrentTurnTool({ capability, tool })
    )
  );
}

function isDiscoverableCurrentTurnTool(options: {
  readonly capability: AgentCapability;
  readonly tool: AgentCapabilityProvidedTool;
}): boolean {
  if (isModelFacingCapabilityTool(options.tool)) {
    return options.capability.lifecycleHooks.handleToolCall !== undefined;
  }

  return isFirstPartyBuiltInModelTool(options);
}

function isFirstPartyBuiltInModelTool(options: {
  readonly capability: AgentCapability;
  readonly tool: AgentCapabilityProvidedTool;
}): boolean {
  return (
    options.capability.manifest.localTrustLevel === 'first_party' &&
    options.tool.validationOwner === 'built_in_model_tools' &&
    isBuiltInModelToolName(options.tool.name) &&
    !options.tool.requiresConfirmation &&
    options.tool.sideEffectLevel === 'none'
  );
}

function isModelFacingCapabilityTool(tool: AgentCapabilityProvidedTool): boolean {
  return (
    !isBuiltInModelToolName(tool.name) &&
    tool.validationOwner === 'capability_host' &&
    !tool.requiresConfirmation &&
    (tool.sideEffectLevel === 'none' || tool.sideEffectLevel === 'runtime_read')
  );
}

function normalizeToolCallResult(options: {
  readonly capability: AgentCapability;
  readonly providedTool: AgentCapabilityProvidedTool;
  readonly context: RuntimeCapabilityContext;
  readonly value: unknown;
}): AgentCapabilityToolCallResult {
  if (!isRecord(options.value)) {
    throw new TypeError('Capability tool result must be an object.');
  }

  const status = options.value['status'];

  if (status === 'accepted') {
    const evidence = normalizeEvidenceSnapshots({
      capability: options.capability,
      context: options.context,
      value: options.value['evidence']
    });

    assertAcceptedToolEvidenceSourceReferences({
      capability: options.capability,
      providedTool: options.providedTool,
      evidence
    });

    return Object.freeze({
      status: 'accepted',
      output: normalizeJsonValue(options.value['output']),
      evidence
    } satisfies AgentCapabilityToolCallResult);
  }

  if (status === 'rejected') {
    const reason = options.value['reason'];
    const message = options.value['message'];

    if (typeof reason !== 'string' || typeof message !== 'string') {
      throw new TypeError('Capability rejected tool result must include reason and message.');
    }

    const evidence = normalizeEvidenceSnapshots({
      capability: options.capability,
      context: options.context,
      value: options.value['evidence']
    });
    const evidenceWithRejection = evidenceRecordsStatus({
      evidence,
      evidenceKind: 'tool_invocation',
      statuses: ['rejected', 'failed']
    })
      ? evidence
      : Object.freeze([
          ...evidence,
          createHookFailureEvidence({
            capability: options.capability,
            context: options.context,
            evidenceKind: 'tool_invocation',
            status: 'rejected',
            summary: message,
            policyOutcome: 'handler_rejected'
          })
        ]);

    return Object.freeze({
      status: 'rejected',
      reason,
      message,
      evidence: evidenceWithRejection
    } satisfies AgentCapabilityToolCallResult);
  }

  throw new TypeError('Capability tool result status is not supported.');
}

function createRejectedToolCallResult(options: {
  readonly call: AgentCapabilityToolCall;
  readonly context: RuntimeCapabilityContext;
  readonly reason: string;
  readonly message: string;
  readonly evidenceStatus?: AgentCapabilityEvidenceStatus;
  readonly policyOutcome?: AgentCapabilityPolicyOutcome;
}): AgentCapabilityToolCallResult {
  return Object.freeze({
    status: 'rejected',
    reason: options.reason,
    message: options.message,
    evidence: Object.freeze([
      createAgentCapabilityEvidenceSnapshot({
        eventId: options.context.eventId,
        traceId: options.context.traceId,
        createdAt: options.context.timestamp,
        kind: 'agent_capability_evidence_snapshot',
        capabilityId: options.call.capabilityId,
        evidenceKind: 'tool_invocation',
        status: options.evidenceStatus ?? 'rejected',
        summary: options.message,
        policyOutcome: options.policyOutcome ?? 'handler_rejected',
        redactionLabels: options.context.privacy.redactionLabels
      })
    ])
  } satisfies AgentCapabilityToolCallResult);
}

function normalizeJsonValue(value: unknown): AgentCapabilityJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Capability tool output must be finite JSON.');
    }

    return value;
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map(normalizeJsonValue));
  }

  if (isRecord(value)) {
    const snapshot: Record<string, AgentCapabilityJsonValue> = {};

    for (const [key, item] of Object.entries(value)) {
      snapshot[key] = normalizeJsonValue(item);
    }

    return Object.freeze(snapshot);
  }

  throw new TypeError('Capability tool output must be JSON serializable.');
}

async function runHealth(options: {
  readonly capabilities: readonly AgentCapability[];
  readonly context: RuntimeCapabilityContext;
}): Promise<RuntimeCapabilityHealthHostResult> {
  const snapshots: AgentCapabilityHealthSnapshot[] = [];
  const evidence: AgentCapabilityEvidenceSnapshot[] = [];

  for (const capability of options.capabilities) {
    const hook = capability.lifecycleHooks.health;

    if (hook === undefined) {
      continue;
    }

    try {
      const snapshot = createAgentCapabilityHealthSnapshot(
        await withCapabilityHookTimeout({
          capability,
          hookName: 'health',
          operation: async () => await hook(options.context)
        })
      );

      assertSnapshotCapabilityId({
        capability,
        actualCapabilityId: snapshot.capabilityId,
        field: 'health.capabilityId'
      });
      snapshots.push(snapshot);
      const healthEvidence = createHealthSnapshotEvidence({
        capability,
        context: options.context,
        snapshot
      });

      if (healthEvidence !== undefined) {
        evidence.push(healthEvidence);
      }
    } catch (error: unknown) {
      const message = errorMessage(error);
      const policyOutcome =
        error instanceof CapabilityHookTimeoutError ? 'timeout' : 'health_degraded';

      snapshots.push(
        createAgentCapabilityHealthSnapshot({
          capabilityId: capability.manifest.id,
          status: 'unavailable',
          checkedAt: options.context.timestamp,
          summary: message,
          redactionLabels: mergedRedactionLabels({
            capability,
            context: options.context
          })
        })
      );
      evidence.push(
        createHookFailureEvidence({
          capability,
          context: options.context,
          evidenceKind: 'health',
          status:
            capability.manifest.runtimePolicy.failureBehavior.health === 'degrade'
              ? 'degraded'
              : 'failed',
          summary: `Capability health hook failed: ${message}`,
          policyOutcome
        })
      );
    }
  }

  return Object.freeze({
    snapshots: Object.freeze([...snapshots]),
    evidence: Object.freeze([...evidence])
  } satisfies RuntimeCapabilityHealthHostResult);
}

function createHealthSnapshotEvidence(options: {
  readonly capability: AgentCapability;
  readonly context: RuntimeCapabilityContext;
  readonly snapshot: AgentCapabilityHealthSnapshot;
}): AgentCapabilityEvidenceSnapshot | undefined {
  if (options.snapshot.status === 'ok') {
    return undefined;
  }

  return createHookFailureEvidence({
    capability: options.capability,
    context: options.context,
    evidenceKind: 'health',
    status: healthSnapshotEvidenceStatus(options),
    summary: `Capability health ${options.snapshot.status}: ${options.snapshot.summary}`,
    policyOutcome: 'health_degraded'
  });
}

function healthSnapshotEvidenceStatus(options: {
  readonly capability: AgentCapability;
  readonly snapshot: AgentCapabilityHealthSnapshot;
}): AgentCapabilityEvidenceStatus {
  if (
    options.snapshot.status === 'unavailable' &&
    options.capability.manifest.runtimePolicy.failureBehavior.health === 'reject_turn'
  ) {
    return 'failed';
  }

  return 'degraded';
}

async function invokeBeforeRoleModelCallHook(options: {
  readonly capability: AgentCapability;
  readonly context: RuntimeCapabilityContext;
  readonly hook: NonNullable<AgentCapability['lifecycleHooks']['beforeRoleModelCall']>;
}): Promise<BeforeRoleModelCallInvocationResult> {
  try {
    return Object.freeze({
      status: 'accepted',
      value: normalizeBeforeRoleModelCallResult({
        capability: options.capability,
        context: options.context,
        value: await withCapabilityHookTimeout({
          capability: options.capability,
          hookName: 'beforeRoleModelCall',
          operation: async () => await options.hook(options.context)
        })
      })
    } satisfies BeforeRoleModelCallInvocationResult);
  } catch (error: unknown) {
    return Object.freeze({
      status: 'failed',
      message: errorMessage(error),
      failureKind:
        error instanceof CapabilityHookTimeoutError ? 'timeout' : 'exception'
    } satisfies BeforeRoleModelCallInvocationResult);
  }
}

async function invokeHook<TContext extends RuntimeCapabilityContext>(options: {
  readonly capability: AgentCapability;
  readonly context: TContext;
  readonly hookName: 'afterTurnCommitted' | 'onSessionEnd';
  readonly hook: (context: TContext) => AgentCapabilityHookResult | Promise<AgentCapabilityHookResult>;
}): Promise<HookInvocationResult> {
  try {
    return Object.freeze({
      status: 'accepted',
      value: normalizeHookResult({
        capability: options.capability,
        context: options.context,
        value: await withCapabilityHookTimeout({
          capability: options.capability,
          hookName: options.hookName,
          operation: async () => await options.hook(options.context)
        })
      })
    } satisfies HookInvocationResult);
  } catch (error: unknown) {
    return Object.freeze({
      status: 'failed',
      message: errorMessage(error),
      failureKind:
        error instanceof CapabilityHookTimeoutError ? 'timeout' : 'exception'
    } satisfies HookInvocationResult);
  }
}

function normalizeBeforeRoleModelCallResult(options: {
  readonly capability: AgentCapability;
  readonly context: RuntimeCapabilityContext;
  readonly value: unknown;
}): AgentCapabilityBeforeRoleModelCallResult {
  if (!isRecord(options.value)) {
    throw new TypeError('beforeRoleModelCall hook result must be an object.');
  }

  return Object.freeze({
    contextItems: normalizeContextItems({
      capability: options.capability,
      value: options.value['contextItems']
    }),
    runtimeNotes: normalizeRuntimeNotes(options.value['runtimeNotes']),
    evidence: normalizeEvidenceSnapshots({
      capability: options.capability,
      context: options.context,
      value: options.value['evidence']
    })
  } satisfies AgentCapabilityBeforeRoleModelCallResult);
}

function normalizeHookResult(options: {
  readonly capability: AgentCapability;
  readonly context: RuntimeCapabilityContext;
  readonly value: unknown;
}): AgentCapabilityHookResult {
  if (!isRecord(options.value)) {
    throw new TypeError('Capability hook result must be an object.');
  }

  const status = options.value['status'];

  if (status !== 'completed' && status !== 'failed') {
    throw new TypeError('Capability hook result status is not supported.');
  }

  return Object.freeze({
    status,
    evidence: normalizeEvidenceSnapshots({
      capability: options.capability,
      context: options.context,
      value: options.value['evidence']
    })
  } satisfies AgentCapabilityHookResult);
}

function normalizeContextItems(options: {
  readonly capability: AgentCapability;
  readonly value: unknown;
}): readonly AgentCapabilityContextItem[] {
  const items = requiredArray(options.value, 'contextItems');

  return Object.freeze(
    items.map((item) => {
      const contextItem = createAgentCapabilityContextItem(item);

      assertSnapshotCapabilityId({
        capability: options.capability,
        actualCapabilityId: contextItem.capabilityId,
        field: 'contextItems.capabilityId'
      });
      assertContextItemSourceReferences({
        capability: options.capability,
        contextItem
      });

      return contextItem;
    })
  );
}

function boundCapabilityContextItems(options: {
  readonly context: RuntimeCapabilityContext;
  readonly contextItems: readonly CollectedCapabilityContextItem[];
}): BoundedCapabilityContextItemsResult {
  const totalEstimatedTokens = options.contextItems.reduce(
    (total, contextItem) => total + contextItem.item.budget.estimatedTokens,
    0
  );

  if (totalEstimatedTokens <= runtimeCapabilityContextEstimatedTokenBudget) {
    return Object.freeze({
      status: 'completed',
      contextItems: Object.freeze(
        options.contextItems.map((contextItem) => contextItem.item)
      ),
      evidence: Object.freeze([])
    });
  }

  const retainedIndexes = new Set<number>();
  let retainedEstimatedTokens = 0;

  for (const candidate of [...options.contextItems].sort(
    compareCollectedContextItemPriority
  )) {
    const nextEstimatedTokens =
      retainedEstimatedTokens + candidate.item.budget.estimatedTokens;

    if (nextEstimatedTokens > runtimeCapabilityContextEstimatedTokenBudget) {
      continue;
    }

    retainedIndexes.add(candidate.originalIndex);
    retainedEstimatedTokens = nextEstimatedTokens;
  }

  const retainedContextItems = options.contextItems
    .filter((contextItem) => retainedIndexes.has(contextItem.originalIndex))
    .map((contextItem) => contextItem.item);
  const droppedContextItems = options.contextItems.filter(
    (contextItem) => !retainedIndexes.has(contextItem.originalIndex)
  );
  const evidence = contextBudgetEvidence({
    context: options.context,
    droppedContextItems,
    retainedEstimatedTokens,
    totalEstimatedTokens
  });
  const rejectedContextItem =
    firstDroppedContextItemThatRejectsTurn(droppedContextItems);

  if (rejectedContextItem !== undefined) {
    return Object.freeze({
      status: 'rejected',
      capabilityId: rejectedContextItem.capability.manifest.id,
      message: requiredContextBudgetRejectionMessage(rejectedContextItem),
      evidence
    });
  }

  return Object.freeze({
    status: 'completed',
    contextItems: Object.freeze(retainedContextItems),
    evidence
  });
}

function compareCollectedContextItemPriority(
  left: CollectedCapabilityContextItem,
  right: CollectedCapabilityContextItem
): number {
  return (
    left.item.budget.priority - right.item.budget.priority ||
    left.originalIndex - right.originalIndex
  );
}

function contextBudgetEvidence(options: {
  readonly context: RuntimeCapabilityContext;
  readonly droppedContextItems: readonly CollectedCapabilityContextItem[];
  readonly retainedEstimatedTokens: number;
  readonly totalEstimatedTokens: number;
}): readonly AgentCapabilityEvidenceSnapshot[] {
  const droppedByCapability = new Map<
    string,
    {
      readonly capability: AgentCapability;
      readonly dropped: CollectedCapabilityContextItem[];
    }
  >();

  for (const droppedContextItem of options.droppedContextItems) {
    const capabilityId = droppedContextItem.capability.manifest.id;
    const entry = droppedByCapability.get(capabilityId);

    if (entry === undefined) {
      droppedByCapability.set(capabilityId, {
        capability: droppedContextItem.capability,
        dropped: [droppedContextItem]
      });
      continue;
    }

    entry.dropped.push(droppedContextItem);
  }

  return Object.freeze(
    [...droppedByCapability.values()].map((entry) => {
      const rejectsTurn = beforeRoleModelFailureRejectsTurn(entry.capability);

      return createHookFailureEvidence({
        capability: entry.capability,
        context: options.context,
        evidenceKind: 'before_role_model_call',
        status: rejectsTurn ? 'rejected' : 'degraded',
        summary: contextBudgetEvidenceSummary({
          droppedContextItems: entry.dropped,
          retainedEstimatedTokens: options.retainedEstimatedTokens,
          totalEstimatedTokens: options.totalEstimatedTokens
        }),
        policyOutcome: rejectsTurn ? 'required_rejected' : 'optional_degraded'
      });
    })
  );
}

function firstDroppedContextItemThatRejectsTurn(
  droppedContextItems: readonly CollectedCapabilityContextItem[]
): CollectedCapabilityContextItem | undefined {
  return droppedContextItems.find((contextItem) =>
    beforeRoleModelFailureRejectsTurn(contextItem.capability)
  );
}

function requiredContextBudgetRejectionMessage(
  contextItem: CollectedCapabilityContextItem
): string {
  return `Required before-role-model capability context exceeded the ${String(
    runtimeCapabilityContextEstimatedTokenBudget
  )}-token budget; dropped context item "${contextItem.item.id}".`;
}

function contextBudgetEvidenceSummary(options: {
  readonly droppedContextItems: readonly CollectedCapabilityContextItem[];
  readonly retainedEstimatedTokens: number;
  readonly totalEstimatedTokens: number;
}): string {
  const droppedIds = options.droppedContextItems
    .map((contextItem) => contextItem.item.id)
    .join(', ');

  return `Capability context budget kept ${String(
    options.retainedEstimatedTokens
  )}/${String(runtimeCapabilityContextEstimatedTokenBudget)} estimated tokens and dropped ${String(
    options.droppedContextItems.length
  )} item(s) from ${String(
    options.totalEstimatedTokens
  )} estimated tokens; dropped ids ${droppedIds}`;
}

function normalizeRuntimeNotes(value: unknown): readonly string[] {
  return Object.freeze(
    requiredArray(value, 'runtimeNotes').map((item) => {
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw new TypeError('runtimeNotes must contain non-empty strings.');
      }

      return redactAgentCapabilityText(item);
    })
  );
}

function normalizeEvidenceSnapshots(options: {
  readonly capability: AgentCapability;
  readonly context: RuntimeCapabilityContext;
  readonly value: unknown;
}): readonly AgentCapabilityEvidenceSnapshot[] {
  return Object.freeze(
    requiredArray(options.value, 'evidence').map((item) => {
      const evidence = createAgentCapabilityEvidenceSnapshot(
        item
      );

      assertSnapshotCapabilityId({
        capability: options.capability,
        actualCapabilityId: evidence.capabilityId,
        field: 'evidence.capabilityId'
      });
      assertSnapshotRuntimeIdentity({
        context: options.context,
        snapshot: evidence,
        field: 'evidence'
      });

      return evidence;
    })
  );
}

function createHookFailureEvidence(options: {
  readonly capability: AgentCapability;
  readonly context: RuntimeCapabilityContext;
  readonly evidenceKind: AgentCapabilityEvidenceKind;
  readonly status: AgentCapabilityEvidenceStatus;
  readonly summary: string;
  readonly policyOutcome?: AgentCapabilityPolicyOutcome;
}): AgentCapabilityEvidenceSnapshot {
  return createAgentCapabilityEvidenceSnapshot({
    eventId: options.context.eventId,
    traceId: options.context.traceId,
    createdAt: options.context.timestamp,
    kind: 'agent_capability_evidence_snapshot',
    capabilityId: options.capability.manifest.id,
    evidenceKind: options.evidenceKind,
    status: options.status,
    summary: options.summary,
    ...(options.policyOutcome === undefined
      ? {}
      : { policyOutcome: options.policyOutcome }),
    redactionLabels: mergedRedactionLabels({
      capability: options.capability,
      context: options.context
    }),
    ...(options.capability.manifest.config.fingerprint === undefined
      ? {}
      : { configFingerprint: options.capability.manifest.config.fingerprint })
  });
}

function failurePolicyOutcomeOption(
  evidenceKind: AgentCapabilityEvidenceKind,
  failureKind: 'exception' | 'timeout'
): { readonly policyOutcome?: AgentCapabilityPolicyOutcome } {
  if (failureKind === 'timeout') {
    return {
      policyOutcome: 'timeout'
    };
  }

  if (evidenceKind === 'after_turn_committed') {
    return {
      policyOutcome: 'after_commit_failed'
    };
  }

  return {};
}

function enabledCapabilityIdsForHost(options: {
  readonly capabilities: readonly AgentCapability[];
  readonly enabledCapabilityIds: readonly string[] | undefined;
}): readonly string[] {
  if (options.enabledCapabilityIds === undefined) {
    return Object.freeze(
      options.capabilities
        .filter((capability) => capability.manifest.activation.defaultEnabled)
        .map((capability) => capability.manifest.id)
    );
  }

  const capabilityIds = new Set(
    options.capabilities.map((capability) => capability.manifest.id)
  );
  const seenEnabledIds = new Set<string>();
  const enabledIds: string[] = [];

  for (const enabledId of options.enabledCapabilityIds) {
    if (!capabilityIds.has(enabledId)) {
      throw new TypeError(`Unknown enabled capability id "${enabledId}".`);
    }

    if (seenEnabledIds.has(enabledId)) {
      throw new TypeError(`Duplicate enabled capability id "${enabledId}".`);
    }

    seenEnabledIds.add(enabledId);
    enabledIds.push(enabledId);
  }

  if (!seenEnabledIds.has(runtimeCapabilityDiscoveryCapabilityId)) {
    enabledIds.unshift(runtimeCapabilityDiscoveryCapabilityId);
  }

  return Object.freeze(enabledIds);
}

function beforeRoleModelFailureRejectsTurn(capability: AgentCapability): boolean {
  return (
    capability.manifest.runtimePolicy.requiredForTurn ||
    capability.manifest.runtimePolicy.failureBehavior.beforeRoleModelCall ===
      'reject_turn'
  );
}

function handleToolCallFailureDegrades(options: {
  readonly capability: AgentCapability;
  readonly providedTool: AgentCapabilityProvidedTool;
}): boolean {
  return (
    !options.capability.manifest.runtimePolicy.requiredForTurn &&
    !options.providedTool.requiredForUserTurn &&
    options.capability.manifest.runtimePolicy.failureBehavior.handleToolCall ===
      'degrade'
  );
}

function assertSnapshotCapabilityId(options: {
  readonly capability: AgentCapability;
  readonly actualCapabilityId: string;
  readonly field: string;
}): void {
  if (options.actualCapabilityId === options.capability.manifest.id) {
    return;
  }

  throw new TypeError(
    `${options.field} must match capability "${options.capability.manifest.id}".`
  );
}

function assertSnapshotRuntimeIdentity(options: {
  readonly context: RuntimeCapabilityContext;
  readonly snapshot: Pick<AgentCapabilityEvidenceSnapshot, 'eventId' | 'traceId' | 'createdAt'>;
  readonly field: string;
}): void {
  if (
    options.snapshot.eventId === options.context.eventId &&
    options.snapshot.traceId === options.context.traceId &&
    options.snapshot.createdAt === options.context.timestamp
  ) {
    return;
  }

  throw new TypeError(
    `${options.field} identity must match current runtime event identity.`
  );
}

function assertContextItemSourceReferences(options: {
  readonly capability: AgentCapability;
  readonly contextItem: AgentCapabilityContextItem;
}): void {
  assertRequiredSourceReferences({
    sourceReferencesRequired:
      options.capability.manifest.runtimePolicy.sourceReferencesRequired,
    sourceReferences: options.contextItem.sourceReferences,
    message: `Capability "${options.capability.manifest.id}" context item "${options.contextItem.id}" requires source references.`
  });
}

function assertAcceptedToolEvidenceSourceReferences(options: {
  readonly capability: AgentCapability;
  readonly providedTool: AgentCapabilityProvidedTool;
  readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
}): void {
  assertRequiredSourceReferences({
    sourceReferencesRequired: options.providedTool.sourceReferencesRequired,
    sourceReferences: options.evidence.flatMap(
      (evidence) => evidence.sourceReferences ?? []
    ),
    message: `Capability "${options.capability.manifest.id}" tool "${options.providedTool.name}" accepted result requires source references.`
  });
}

function assertRequiredSourceReferences(options: {
  readonly sourceReferencesRequired: boolean;
  readonly sourceReferences: readonly AgentCapabilitySourceReference[] | undefined;
  readonly message: string;
}): void {
  if (!options.sourceReferencesRequired) {
    return;
  }

  if ((options.sourceReferences?.length ?? 0) > 0) {
    return;
  }

  throw new TypeError(options.message);
}

function mergedRedactionLabels(options: {
  readonly capability: AgentCapability;
  readonly context: RuntimeCapabilityContext;
}): readonly string[] {
  return Object.freeze([
    ...new Set([
      ...options.context.privacy.redactionLabels,
      ...options.capability.manifest.runtimePolicy.redactionLabels
    ])
  ]);
}

function requiredArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array.`);
  }

  return value;
}

class CapabilityHookTimeoutError extends Error {
  constructor(options: {
    readonly capabilityId: string;
    readonly hookName: string;
    readonly timeoutMs: number;
  }) {
    super(
      `Capability "${options.capabilityId}" ${options.hookName} timed out after ${String(
        options.timeoutMs
      )}ms.`
    );
    this.name = 'CapabilityHookTimeoutError';
  }
}

async function withCapabilityHookTimeout<T>(options: {
  readonly capability: AgentCapability;
  readonly hookName: string;
  readonly operation: () => T | Promise<T>;
}): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.capability.manifest.runtimePolicy.timeoutMs;

  try {
    return await Promise.race([
      Promise.resolve().then(options.operation),
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new CapabilityHookTimeoutError({
              capabilityId: options.capability.manifest.id,
              hookName: options.hookName,
              timeoutMs
            })
          );
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return 'Capability hook failed.';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
