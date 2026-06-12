import {
  createAgentCapabilityContextItem,
  createAgentCapabilityEvidenceSnapshot,
  createAgentCapabilityHealthSnapshot,
  createAgentCapabilityRegistrySnapshot
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
  AgentCapabilityJsonValue,
  AgentCapabilityProvidedTool,
  AgentCapabilityToolCall,
  AgentCapabilityToolCallResult,
  AgentCapabilityPolicyOutcome,
  AgentCapabilityRegistrySnapshot,
  RuntimeCapabilityAfterTurnCommittedContext,
  RuntimeCapabilityContext
} from './agent-capabilities.ts';
import { isBuiltInModelToolName } from './model-tools.ts';
import {
  createRoleModelCapabilityToolDefinitions,
  type RoleModelCapabilityToolDefinition
} from './role-model-contracts.ts';

export const runtimeCapabilityBeforeRoleModelCallRejectionReason =
  'capability_before_role_model_call_rejected';

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

export function createRuntimeCapabilityHost(
  options: CreateRuntimeCapabilityHostOptions = {}
): RuntimeCapabilityHost {
  const capabilities = Object.freeze([...(options.capabilities ?? [])]);
  const registrySnapshot = createAgentCapabilityRegistrySnapshot(capabilities);
  const enabledIds = enabledCapabilityIdsForHost({
    capabilities,
    enabledCapabilityIds: options.enabledCapabilityIds
  });
  const enabledCapabilities = Object.freeze(
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

async function runBeforeRoleModelCall(options: {
  readonly capabilities: readonly AgentCapability[];
  readonly context: RuntimeCapabilityContext;
}): Promise<RuntimeCapabilityBeforeRoleModelCallHostResult> {
  const contextItems: AgentCapabilityContextItem[] = [];
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
      contextItems.push(...result.value.contextItems);
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

  return Object.freeze({
    status: 'completed',
    contextItems: Object.freeze([...contextItems]),
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

      if (result.value.evidence.length === 0) {
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

function capabilityToolDefinitionsForEnabledCapabilities(
  capabilities: readonly AgentCapability[]
): readonly RoleModelCapabilityToolDefinition[] {
  return Object.freeze(
    capabilities.flatMap((capability) => {
      if (capability.lifecycleHooks.handleToolCall === undefined) {
        return [];
      }

      return capability.providedTools
        .filter(isModelFacingCapabilityTool)
        .map((tool) =>
          Object.freeze({
            capabilityId: capability.manifest.id,
            ...tool
          } satisfies RoleModelCapabilityToolDefinition)
        );
    })
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
  readonly value: unknown;
}): AgentCapabilityToolCallResult {
  if (!isRecord(options.value)) {
    throw new TypeError('Capability tool result must be an object.');
  }

  const status = options.value['status'];

  if (status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      output: normalizeJsonValue(options.value['output']),
      evidence: normalizeEvidenceSnapshots({
        capability: options.capability,
        value: options.value['evidence']
      })
    } satisfies AgentCapabilityToolCallResult);
  }

  if (status === 'rejected') {
    const reason = options.value['reason'];
    const message = options.value['message'];

    if (typeof reason !== 'string' || typeof message !== 'string') {
      throw new TypeError('Capability rejected tool result must include reason and message.');
    }

    return Object.freeze({
      status: 'rejected',
      reason,
      message,
      evidence: normalizeEvidenceSnapshots({
        capability: options.capability,
        value: options.value['evidence']
      })
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
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
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
      value: options.value['evidence']
    })
  } satisfies AgentCapabilityBeforeRoleModelCallResult);
}

function normalizeHookResult(options: {
  readonly capability: AgentCapability;
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

function normalizeRuntimeNotes(value: unknown): readonly string[] {
  return Object.freeze(
    requiredArray(value, 'runtimeNotes').map((item) => {
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw new TypeError('runtimeNotes must contain non-empty strings.');
      }

      return item;
    })
  );
}

function normalizeEvidenceSnapshots(options: {
  readonly capability: AgentCapability;
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

function assertContextItemSourceReferences(options: {
  readonly capability: AgentCapability;
  readonly contextItem: AgentCapabilityContextItem;
}): void {
  if (!options.capability.manifest.runtimePolicy.sourceReferencesRequired) {
    return;
  }

  if (options.contextItem.sourceReferences.length > 0) {
    return;
  }

  throw new TypeError(
    `Capability "${options.capability.manifest.id}" context item "${options.contextItem.id}" requires source references.`
  );
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
