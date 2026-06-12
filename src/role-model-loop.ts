import {
  createDeterministicCharacterAgent,
  validateCharacterAgentReply,
  type CharacterAgent
} from './conversation.ts';
import {
  roleModelCapabilityToolRejectedRejectionReason,
  createParsedRoleModelDecisionSnapshot,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createVisibleReplyCharacterDecision,
  roleModelAdapterRejectionNotReplayableDetails,
  isRoleModelRawOutputReplayableDecisionEvidence,
  parseRoleModelDecision,
  roleModelAdapterRawOutputMissingTextRejectionDetails,
  roleModelDecisionRejectionReasons,
  roleModelMalformedOutputRejectionReason,
  type AcceptedRoleModelDecisionResult,
  type CharacterDecision,
  type DecisionContext,
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelAllowedToolName,
  type RoleModelCapabilityToolDefinition,
  type RejectedRoleModelDecisionResult,
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  type RoleModelInputEnvelope,
  type RoleModelIOSnapshot,
  type RoleModelProviderMetadata
} from './role-model-contracts.ts';
import {
  isBuiltInModelToolName,
  type ModelToolCall
} from './model-tools.ts';
import type {
  AgentCapabilityJsonObject,
  AgentCapabilityJsonValue,
  AgentCapabilityToolCall,
  AgentCapabilityToolCallResult,
  RuntimeCapabilityContext
} from './agent-capabilities.ts';
import type { RuntimeEventIdentity, UserMessageRuntimeEvent } from './runtime-event.ts';

export { parseRoleModelDecision } from './role-model-contracts.ts';

export type RoleModelAdapterRawOutput = {
  readonly rawOutputText: string;
  readonly providerMetadata?: RoleModelProviderMetadata;
  readonly rejection?: RoleModelDecisionRejection;
};

export type RoleModelAdapter = {
  invoke(
    inputEnvelope: RoleModelInputEnvelope
  ): Promise<RoleModelAdapterRawOutput> | RoleModelAdapterRawOutput;
};

export type RunRoleModelLoopOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly adapter?: RoleModelAdapter;
  readonly capabilityToolDefinitions?: readonly RoleModelCapabilityToolDefinition[];
  readonly capabilityToolHost?: RoleModelCapabilityToolHost;
  readonly runtimeCapabilityContext?: RuntimeCapabilityContext;
};

export type RoleModelCapabilityToolHost = {
  readonly handleToolCall: (
    call: AgentCapabilityToolCall,
    context: RuntimeCapabilityContext
  ) => AgentCapabilityToolCallResult | Promise<AgentCapabilityToolCallResult>;
};

export type RoleModelCapabilityToolRoutingEvidence = {
  readonly call: AgentCapabilityToolCall;
  readonly result: AgentCapabilityToolCallResult;
};

export type AcceptedRoleModelLoopResult = {
  readonly status: 'accepted';
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly decisionResult: AcceptedRoleModelDecisionResult;
  readonly decision: CharacterDecision;
  readonly capabilityToolResults: readonly RoleModelCapabilityToolRoutingEvidence[];
};

export type RejectedRoleModelLoopResult = {
  readonly status: 'rejected';
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly decisionResult: RejectedRoleModelDecisionResult;
  readonly rejection: RoleModelDecisionRejection;
  readonly capabilityToolResults: readonly RoleModelCapabilityToolRoutingEvidence[];
};

export type RoleModelLoopResult =
  | AcceptedRoleModelLoopResult
  | RejectedRoleModelLoopResult;

export function createDeterministicLocalRoleModelAdapter(): RoleModelAdapter {
  return createRoleModelAdapterFromCharacterAgent(
    createDeterministicCharacterAgent()
  );
}

export function createRoleModelAdapterFromCharacterAgent(
  agent: CharacterAgent
): RoleModelAdapter {
  return Object.freeze({
    async invoke(inputEnvelope) {
      const reply = await agent.reply({
        character: inputEnvelope.decisionContext.characterSnapshot,
        message: inputEnvelope.event.payload.currentUserMessage,
        recentVisibleMessages: inputEnvelope.decisionContext.recentVisibleMessages
      });
      const characterReply = validateCharacterAgentReply(reply);

      return createRoleModelAdapterRawOutput(
        JSON.stringify(createVisibleReplyCharacterDecision(characterReply.text))
      );
    }
  } satisfies RoleModelAdapter);
}

export async function runRoleModelLoop(
  options: RunRoleModelLoopOptions
): Promise<RoleModelLoopResult> {
  const inputEnvelope = createRoleModelInputEnvelope({
    event: options.event,
    decisionContext: options.decisionContext,
    capabilityToolDefinitions: options.capabilityToolDefinitions ?? []
  });
  const adapter = options.adapter ?? createDeterministicLocalRoleModelAdapter();
  const rawOutput: unknown = await adapter.invoke(inputEnvelope);
  const rawOutputValidation = validateRoleModelAdapterRawOutput(
    rawOutput,
    inputEnvelope.allowedTools,
    inputEnvelope.capabilityToolDefinitions
  );
  const identity = createSnapshotIdentity(inputEnvelope.event);
  const sessionId = inputEnvelope.decisionContext.sessionId;
  const ioSnapshot = createRoleModelIOSnapshot({
    ...identity,
    sessionId,
    inputEnvelope,
    rawOutputText: rawOutputValidation.rawOutputText,
    ...providerMetadataOption(rawOutputValidation.providerMetadata)
  });
  const decisionResult =
    rawOutputValidation.status === 'accepted'
      ? parseRoleModelDecision(
          rawOutputValidation.rawOutputText,
          inputEnvelope.allowedTools,
          inputEnvelope.capabilityToolDefinitions
        )
      : rawOutputValidation.decisionResult;
  const capabilityToolRouting =
    decisionResult.status === 'accepted'
      ? await routeCapabilityToolCalls({
          decision: decisionResult.decision,
          identity,
          inputEnvelope,
          ...(options.capabilityToolHost === undefined
            ? {}
            : { capabilityToolHost: options.capabilityToolHost }),
          ...(options.runtimeCapabilityContext === undefined
            ? {}
            : { runtimeCapabilityContext: options.runtimeCapabilityContext })
        })
      : createAcceptedCapabilityToolRoutingResult([]);
  const finalDecisionResult =
    capabilityToolRouting.status === 'accepted'
      ? decisionResult
      : capabilityToolRouting.decisionResult;
  const parsedDecisionSnapshot = createParsedRoleModelDecisionSnapshot({
    ...identity,
    sessionId,
    result: finalDecisionResult
  });

  if (finalDecisionResult.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      inputEnvelope,
      ioSnapshot,
      parsedDecisionSnapshot,
      decisionResult: finalDecisionResult,
      decision: finalDecisionResult.decision,
      capabilityToolResults: capabilityToolRouting.results
    } satisfies AcceptedRoleModelLoopResult);
  }

  return Object.freeze({
    status: 'rejected',
    inputEnvelope,
    ioSnapshot,
    parsedDecisionSnapshot,
    decisionResult: finalDecisionResult,
    rejection: finalDecisionResult.rejection,
    capabilityToolResults: capabilityToolRouting.results
  } satisfies RejectedRoleModelLoopResult);
}

type CapabilityToolRoutingResult =
  | {
      readonly status: 'accepted';
      readonly results: readonly RoleModelCapabilityToolRoutingEvidence[];
    }
  | {
      readonly status: 'rejected';
      readonly results: readonly RoleModelCapabilityToolRoutingEvidence[];
      readonly decisionResult: RejectedRoleModelDecisionResult;
    };

async function routeCapabilityToolCalls(options: {
  readonly decision: CharacterDecision;
  readonly identity: RuntimeEventIdentity;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly capabilityToolHost?: RoleModelCapabilityToolHost;
  readonly runtimeCapabilityContext?: RuntimeCapabilityContext;
}): Promise<CapabilityToolRoutingResult> {
  const results: RoleModelCapabilityToolRoutingEvidence[] = [];

  for (const toolCall of options.decision.toolCalls) {
    if (isBuiltInModelToolName(toolCall.name)) {
      continue;
    }

    const capabilityToolDefinition = findCapabilityToolDefinition(
      options.inputEnvelope.capabilityToolDefinitions,
      toolCall.name
    );

    if (capabilityToolDefinition === undefined) {
      return createRejectedCapabilityToolRoutingResult({
        results,
        reason: roleModelCapabilityToolRejectedRejectionReason,
        details: `Capability tool "${toolCall.name}" is not declared for this turn.`
      });
    }

    if (
      options.capabilityToolHost === undefined ||
      options.runtimeCapabilityContext === undefined
    ) {
      return createRejectedCapabilityToolRoutingResult({
        results,
        reason: roleModelCapabilityToolRejectedRejectionReason,
        details: `Capability tool "${toolCall.name}" has no host handler for this turn.`
      });
    }

    const routedCall = createAgentCapabilityToolCall({
      identity: options.identity,
      capabilityId: capabilityToolDefinition.capabilityId,
      toolCall
    });
    let hostResult: AgentCapabilityToolCallResult;

    try {
      hostResult = await options.capabilityToolHost.handleToolCall(
        routedCall,
        options.runtimeCapabilityContext
      );
    } catch (error: unknown) {
      return createRejectedCapabilityToolRoutingResult({
        results,
        reason: roleModelCapabilityToolRejectedRejectionReason,
        details:
          error instanceof Error
            ? error.message
            : `Capability tool "${toolCall.name}" handler failed.`
      });
    }

    const routingEvidence = Object.freeze({
      call: routedCall,
      result: freezeAgentCapabilityToolCallResult(hostResult)
    } satisfies RoleModelCapabilityToolRoutingEvidence);

    results.push(routingEvidence);

    if (routingEvidence.result.status === 'rejected') {
      return createRejectedCapabilityToolRoutingResult({
        results,
        reason: roleModelCapabilityToolRejectedRejectionReason,
        details: routingEvidence.result.message
      });
    }
  }

  return createAcceptedCapabilityToolRoutingResult(results);
}

function createAcceptedCapabilityToolRoutingResult(
  results: readonly RoleModelCapabilityToolRoutingEvidence[]
): CapabilityToolRoutingResult {
  return Object.freeze({
    status: 'accepted',
    results: Object.freeze([...results])
  } satisfies CapabilityToolRoutingResult);
}

function createRejectedCapabilityToolRoutingResult(options: {
  readonly results: readonly RoleModelCapabilityToolRoutingEvidence[];
  readonly reason: RoleModelDecisionRejectionReason;
  readonly details: string;
}): CapabilityToolRoutingResult {
  return Object.freeze({
    status: 'rejected',
    results: Object.freeze([...options.results]),
    decisionResult: createRejectedRoleModelDecisionResult(
      options.reason,
      options.details
    )
  } satisfies CapabilityToolRoutingResult);
}

function findCapabilityToolDefinition(
  definitions: readonly RoleModelCapabilityToolDefinition[],
  toolName: string
): RoleModelCapabilityToolDefinition | undefined {
  return definitions.find((definition) => definition.name === toolName);
}

function createAgentCapabilityToolCall(options: {
  readonly identity: RuntimeEventIdentity;
  readonly capabilityId: string;
  readonly toolCall: ModelToolCall;
}): AgentCapabilityToolCall {
  return Object.freeze({
    eventId: options.identity.eventId,
    traceId: options.identity.traceId,
    createdAt: options.identity.createdAt,
    capabilityId: options.capabilityId,
    toolName: options.toolCall.name,
    input: freezeAgentCapabilityJsonObject(options.toolCall.input)
  } satisfies AgentCapabilityToolCall);
}

function freezeAgentCapabilityToolCallResult(
  result: AgentCapabilityToolCallResult
): AgentCapabilityToolCallResult {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      output: freezeAgentCapabilityJsonValue(result.output),
      evidence: Object.freeze([...result.evidence])
    } satisfies AgentCapabilityToolCallResult);
  }

  return Object.freeze({
    status: 'rejected',
    reason: result.reason,
    message: result.message,
    evidence: Object.freeze([...result.evidence])
  } satisfies AgentCapabilityToolCallResult);
}

function freezeAgentCapabilityJsonObject(
  value: Readonly<Record<string, unknown>>
): AgentCapabilityJsonObject {
  const snapshot: Record<string, AgentCapabilityJsonValue> = {};

  for (const [key, item] of Object.entries(value)) {
    snapshot[key] = freezeAgentCapabilityJsonValue(item);
  }

  return Object.freeze(snapshot);
}

function freezeAgentCapabilityJsonValue(
  value: unknown
): AgentCapabilityJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeAgentCapabilityJsonValue));
  }

  if (isJsonRecord(value)) {
    return freezeAgentCapabilityJsonObject(value);
  }

  throw new TypeError('Capability tool input must be JSON serializable.');
}

function createRoleModelAdapterRawOutput(
  rawOutputText: string
): RoleModelAdapterRawOutput {
  return Object.freeze({
    rawOutputText
  } satisfies RoleModelAdapterRawOutput);
}

type RoleModelAdapterRawOutputValidationResult =
  | {
      readonly status: 'accepted';
      readonly rawOutputText: string;
      readonly providerMetadata?: RoleModelProviderMetadata;
    }
  | {
      readonly status: 'rejected';
      readonly rawOutputText: string;
      readonly providerMetadata?: RoleModelProviderMetadata;
      readonly decisionResult: RejectedRoleModelDecisionResult;
    };

function validateRoleModelAdapterRawOutput(
  rawOutput: unknown,
  allowedTools: readonly RoleModelAllowedToolName[],
  capabilityToolDefinitions: readonly RoleModelCapabilityToolDefinition[]
): RoleModelAdapterRawOutputValidationResult {
  if (!isJsonRecord(rawOutput)) {
    return createMalformedAdapterRawOutputResult();
  }

  const rawOutputText = rawOutput['rawOutputText'];

  if (typeof rawOutputText !== 'string') {
    return createMalformedAdapterRawOutputResult();
  }

  const providerMetadata = optionalProviderMetadata(rawOutput['providerMetadata']);
  const rejection = optionalRoleModelDecisionRejection(rawOutput['rejection']);

  if (rejection !== undefined) {
    const decisionResult = createRejectedRoleModelDecisionResult(
      rejection.reason,
      rejection.details
    );

    if (
      !isRoleModelRawOutputReplayableDecisionEvidence({
        rawOutputText,
        providerMetadata,
        decisionResult,
        allowedTools,
        capabilityToolDefinitions
      })
    ) {
      return createMalformedAdapterRawOutputResult(
        roleModelAdapterRejectionNotReplayableDetails
      );
    }

    return Object.freeze({
      status: 'rejected',
      rawOutputText,
      ...providerMetadataOption(providerMetadata),
      decisionResult
    } satisfies RoleModelAdapterRawOutputValidationResult);
  }

  return Object.freeze({
    status: 'accepted',
    rawOutputText,
    ...providerMetadataOption(providerMetadata)
  } satisfies RoleModelAdapterRawOutputValidationResult);
}

function createMalformedAdapterRawOutputResult(
  details = roleModelAdapterRawOutputMissingTextRejectionDetails
): RoleModelAdapterRawOutputValidationResult {
  return Object.freeze({
    status: 'rejected',
    rawOutputText: '',
    decisionResult: createRejectedRoleModelDecisionResult(
      roleModelMalformedOutputRejectionReason,
      details
    )
  } satisfies RoleModelAdapterRawOutputValidationResult);
}

function providerMetadataOption(
  providerMetadata: RoleModelProviderMetadata | undefined
): { readonly providerMetadata?: RoleModelProviderMetadata } {
  return providerMetadata === undefined ? {} : { providerMetadata };
}

function optionalProviderMetadata(
  value: unknown
): RoleModelProviderMetadata | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isJsonRecord(value)) {
    return undefined;
  }

  const provider = value['provider'];

  if (provider !== 'local' && provider !== 'nvidia') {
    return undefined;
  }

  const model = value['model'];
  const request = optionalProviderRequestMetadata(value['request']);
  const response = optionalProviderResponseMetadata(value['response']);
  const error = optionalProviderErrorMetadata(value['error']);

  return Object.freeze({
    provider,
    ...(typeof model === 'string' ? { model } : {}),
    ...(request === undefined ? {} : { request }),
    ...(response === undefined ? {} : { response }),
    ...(error === undefined ? {} : { error })
  } satisfies RoleModelProviderMetadata);
}

function optionalProviderRequestMetadata(
  value: unknown
): RoleModelProviderMetadata['request'] | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const endpoint = value['endpoint'];
  const messageCount = value['messageCount'];

  return Object.freeze({
    ...(typeof endpoint === 'string' ? { endpoint } : {}),
    ...(typeof messageCount === 'number' ? { messageCount } : {}),
    stream: false
  });
}

function optionalProviderResponseMetadata(
  value: unknown
): RoleModelProviderMetadata['response'] | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const status = value['status'];

  return Object.freeze({
    ...(typeof status === 'number' ? { status } : {})
  });
}

function optionalProviderErrorMetadata(
  value: unknown
): RoleModelProviderMetadata['error'] | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const code = value['code'];
  const message = value['message'];

  if (typeof code !== 'string' || typeof message !== 'string') {
    return undefined;
  }

  return Object.freeze({ code, message });
}

function optionalRoleModelDecisionRejection(
  value: unknown
): RoleModelDecisionRejection | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const reason = value['reason'];
  const details = value['details'];

  if (!isRoleModelDecisionRejectionReason(reason)) {
    return undefined;
  }

  return Object.freeze({
    reason,
    ...(typeof details === 'string' ? { details } : {})
  } satisfies RoleModelDecisionRejection);
}

function isRoleModelDecisionRejectionReason(
  value: unknown
): value is RoleModelDecisionRejectionReason {
  return (
    typeof value === 'string' &&
    roleModelDecisionRejectionReasons.includes(value as RoleModelDecisionRejectionReason)
  );
}

function createSnapshotIdentity(
  event: UserMessageRuntimeEvent
): RuntimeEventIdentity {
  return Object.freeze({
    eventId: event.eventId,
    traceId: event.traceId,
    createdAt: event.createdAt
  } satisfies RuntimeEventIdentity);
}

function isJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
