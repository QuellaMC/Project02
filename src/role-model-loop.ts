import {
  createDeterministicCharacterAgent,
  validateCharacterAgentReply,
  type CharacterAgent
} from './conversation.ts';
import {
  roleModelCapabilityToolRejectedRejectionReason,
  createParsedRoleModelDecisionSnapshot,
  createRoleModelToolObservation,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createVisibleReplyCharacterDecision,
  getVisibleReplyToolCall,
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
  type RoleModelProviderMetadata,
  type RoleModelToolObservation
} from './role-model-contracts.ts';
import {
  characterStatePatchModelToolName,
  visibleReplyModelToolName,
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
  readonly resolveToolCapabilityId?: (toolName: string) => string | undefined;
  readonly maxCapabilityToolRounds?: number;
  readonly maxToolRounds?: number;
  readonly onCapabilityToolCallStarted?: (
    event: RoleModelCapabilityToolCallStartedEvent
  ) => Promise<void> | void;
  readonly onCapabilityToolCallCompleted?: (
    event: RoleModelCapabilityToolCallCompletedEvent
  ) => Promise<void> | void;
  readonly onCapabilityToolCallsRequested?: (
    event: RoleModelCapabilityToolCallsRequestedEvent
  ) => Promise<void> | void;
  readonly onInterimVisibleReply?: (
    event: RoleModelInterimVisibleReplyEvent
  ) => Promise<void> | void;
  readonly runtimeCapabilityContext?: RuntimeCapabilityContext;
};

export type RoleModelCapabilityToolHost = {
  readonly handleToolCall: (
    call: AgentCapabilityToolCall,
    context: RuntimeCapabilityContext
  ) => AgentCapabilityToolCallResult | Promise<AgentCapabilityToolCallResult>;
};

export type RoleModelCapabilityToolRoutingEvidence = {
  readonly callId: string;
  readonly call: AgentCapabilityToolCall;
  readonly result: AgentCapabilityToolCallResult;
};

export type RoleModelInterimVisibleReplyEvent = {
  readonly round: number;
  readonly text: string;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
};

export type RoleModelCapabilityToolCallsRequestedEvent = {
  readonly round: number;
  readonly toolNames: readonly string[];
};

export type RoleModelCapabilityToolCallStartedEvent = {
  readonly callId: string;
  readonly round: number;
  readonly call: AgentCapabilityToolCall;
};

export type RoleModelCapabilityToolCallCompletedEvent = {
  readonly callId: string;
  readonly capabilityId: string;
  readonly round: number;
  readonly status: AgentCapabilityToolCallResult['status'];
  readonly toolName: string;
  readonly result: AgentCapabilityToolCallResult;
};

export type RoleModelLoopRound = {
  readonly round: number;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly capabilityToolResults: readonly RoleModelCapabilityToolRoutingEvidence[];
};

export type AcceptedRoleModelLoopResult = {
  readonly status: 'accepted';
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly decisionResult: AcceptedRoleModelDecisionResult;
  readonly decision: CharacterDecision;
  readonly capabilityToolResults: readonly RoleModelCapabilityToolRoutingEvidence[];
  readonly rounds: readonly RoleModelLoopRound[];
};

export type RejectedRoleModelLoopResult = {
  readonly status: 'rejected';
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly decisionResult: RejectedRoleModelDecisionResult;
  readonly rejection: RoleModelDecisionRejection;
  readonly capabilityToolResults: readonly RoleModelCapabilityToolRoutingEvidence[];
  readonly rounds: readonly RoleModelLoopRound[];
};

export type RoleModelLoopResult =
  | AcceptedRoleModelLoopResult
  | RejectedRoleModelLoopResult;

export const defaultRoleModelMaxToolRounds = 99;
export const defaultRoleModelMaxCapabilityToolRounds =
  defaultRoleModelMaxToolRounds;

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
  const adapter = options.adapter ?? createDeterministicLocalRoleModelAdapter();
  const maxToolRounds =
    options.maxToolRounds ??
    options.maxCapabilityToolRounds ??
    defaultRoleModelMaxToolRounds;
  const identity = createSnapshotIdentity(options.event);
  const sessionId = options.decisionContext.sessionId;
  const rounds: RoleModelLoopRound[] = [];
  const allCapabilityToolResults: RoleModelCapabilityToolRoutingEvidence[] = [];
  let toolRounds = 0;
  let toolObservations: readonly RoleModelToolObservation[] = Object.freeze([]);

  for (let round = 1; ; round += 1) {
    const inputEnvelope = createRoleModelInputEnvelope({
      event: options.event,
      decisionContext: options.decisionContext,
      capabilityToolDefinitions: options.capabilityToolDefinitions ?? [],
      toolObservations
    });
    const rawOutput: unknown = await adapter.invoke(inputEnvelope);
    const rawOutputValidation = validateRoleModelAdapterRawOutput(
      rawOutput,
      inputEnvelope.allowedTools,
      inputEnvelope.capabilityToolDefinitions
    );
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
    const parsedDecisionSnapshot = createParsedRoleModelDecisionSnapshot({
      ...identity,
      sessionId,
      result: decisionResult
    });

    if (decisionResult.status === 'rejected') {
      const loopRound = createRoleModelLoopRound({
        capabilityToolResults: [],
        inputEnvelope,
        ioSnapshot,
        parsedDecisionSnapshot,
        round
      });

      rounds.push(loopRound);

      return createRejectedRoleModelLoopResult({
        capabilityToolResults: allCapabilityToolResults,
        decisionResult,
        inputEnvelope,
        ioSnapshot,
        parsedDecisionSnapshot,
        rounds
      });
    }

    const executableToolCalls = executableModelToolCalls(
      decisionResult.decision.toolCalls
    );

    if (executableToolCalls.length === 0) {
      if (
        getVisibleReplyToolCall(decisionResult.decision) === undefined &&
        decisionResult.nonCommittedText === undefined
      ) {
        const rejectedDecisionResult = createRejectedRoleModelDecisionResult(
          roleModelMalformedOutputRejectionReason,
          'Terminal model output must include visible_reply or top-level text.'
        );
        const loopRound = createRoleModelLoopRound({
          capabilityToolResults: [],
          inputEnvelope,
          ioSnapshot,
          parsedDecisionSnapshot,
          round
        });

        rounds.push(loopRound);

        return createRejectedRoleModelLoopResult({
          capabilityToolResults: allCapabilityToolResults,
          decisionResult: rejectedDecisionResult,
          inputEnvelope,
          ioSnapshot,
          parsedDecisionSnapshot,
          rounds
        });
      }

      const loopRound = createRoleModelLoopRound({
        capabilityToolResults: [],
        inputEnvelope,
        ioSnapshot,
        parsedDecisionSnapshot,
        round
      });

      rounds.push(loopRound);

      return Object.freeze({
        status: 'accepted',
        inputEnvelope,
        ioSnapshot,
        parsedDecisionSnapshot,
        decisionResult,
        decision: decisionResult.decision,
        capabilityToolResults: Object.freeze([...allCapabilityToolResults]),
        rounds: Object.freeze([...rounds])
      } satisfies AcceptedRoleModelLoopResult);
    }

    if (toolRounds >= maxToolRounds) {
      const rejectedDecisionResult = createRejectedRoleModelDecisionResult(
        roleModelCapabilityToolRejectedRejectionReason,
        `Role model exceeded maximum executable tool rounds (${String(maxToolRounds)}).`
      );
      const loopRound = createRoleModelLoopRound({
        capabilityToolResults: [],
        inputEnvelope,
        ioSnapshot,
        parsedDecisionSnapshot,
        round
      });

      rounds.push(loopRound);

      return createRejectedRoleModelLoopResult({
        capabilityToolResults: allCapabilityToolResults,
        decisionResult: rejectedDecisionResult,
        inputEnvelope,
        ioSnapshot,
        parsedDecisionSnapshot,
        rounds
      });
    }

    const visibleReply = getVisibleReplyToolCall(decisionResult.decision);

    if (visibleReply !== undefined) {
      await options.onInterimVisibleReply?.({
        round,
        text: visibleReply.input.text,
        inputEnvelope,
        ioSnapshot,
        parsedDecisionSnapshot
      });
    }

    await options.onCapabilityToolCallsRequested?.({
      round,
      toolNames: executableToolCalls.map((call) => call.name)
    });

    const capabilityToolRouting = await routeExecutableToolCalls({
      toolCalls: executableToolCalls,
      identity,
      inputEnvelope,
      round,
      ...(options.resolveToolCapabilityId === undefined
        ? {}
        : { resolveToolCapabilityId: options.resolveToolCapabilityId }),
      ...(options.onCapabilityToolCallStarted === undefined
        ? {}
        : { onCapabilityToolCallStarted: options.onCapabilityToolCallStarted }),
      ...(options.capabilityToolHost === undefined
        ? {}
        : { capabilityToolHost: options.capabilityToolHost }),
      ...(options.runtimeCapabilityContext === undefined
        ? {}
        : { runtimeCapabilityContext: options.runtimeCapabilityContext })
    });

    for (const result of capabilityToolRouting.results) {
      await options.onCapabilityToolCallCompleted?.({
        round,
        callId: result.callId,
        capabilityId: result.call.capabilityId,
        toolName: result.call.toolName,
        status: result.result.status,
        result: result.result
      });
    }

    allCapabilityToolResults.push(...capabilityToolRouting.results);

    const loopRound = createRoleModelLoopRound({
      capabilityToolResults: capabilityToolRouting.results,
      inputEnvelope,
      ioSnapshot,
      parsedDecisionSnapshot,
      round
    });

    rounds.push(loopRound);

    toolRounds += 1;
    toolObservations = Object.freeze([
      ...toolObservations,
      ...capabilityToolRouting.results.map((routing) =>
        createToolObservationFromRouting({ round, routing })
      )
    ]);
  }
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

function createRoleModelLoopRound(options: {
  readonly capabilityToolResults: readonly RoleModelCapabilityToolRoutingEvidence[];
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly round: number;
}): RoleModelLoopRound {
  return Object.freeze({
    round: options.round,
    inputEnvelope: options.inputEnvelope,
    ioSnapshot: options.ioSnapshot,
    parsedDecisionSnapshot: options.parsedDecisionSnapshot,
    capabilityToolResults: Object.freeze([...options.capabilityToolResults])
  } satisfies RoleModelLoopRound);
}

function createRejectedRoleModelLoopResult(options: {
  readonly capabilityToolResults: readonly RoleModelCapabilityToolRoutingEvidence[];
  readonly decisionResult: RejectedRoleModelDecisionResult;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly rounds: readonly RoleModelLoopRound[];
}): RejectedRoleModelLoopResult {
  return Object.freeze({
    status: 'rejected',
    inputEnvelope: options.inputEnvelope,
    ioSnapshot: options.ioSnapshot,
    parsedDecisionSnapshot: options.parsedDecisionSnapshot,
    decisionResult: options.decisionResult,
    rejection: options.decisionResult.rejection,
    capabilityToolResults: Object.freeze([...options.capabilityToolResults]),
    rounds: Object.freeze([...options.rounds])
  } satisfies RejectedRoleModelLoopResult);
}

function executableModelToolCalls(
  toolCalls: readonly ModelToolCall[]
): readonly ModelToolCall[] {
  return Object.freeze(
    toolCalls.filter((toolCall) => toolCall.name !== visibleReplyModelToolName)
  );
}

function createToolObservationFromRouting(options: {
  readonly round: number;
  readonly routing: RoleModelCapabilityToolRoutingEvidence;
}): RoleModelToolObservation {
  const result =
    options.routing.result.status === 'accepted'
      ? {
          status: 'accepted',
          output: options.routing.result.output
        } as const
      : {
          status: 'rejected',
          reason: options.routing.result.reason,
          message: options.routing.result.message
        } as const;

  return createRoleModelToolObservation({
    round: options.round,
    capabilityId: options.routing.call.capabilityId,
    toolName: options.routing.call.toolName,
    input: options.routing.call.input,
    result
  });
}

async function routeExecutableToolCalls(options: {
  readonly toolCalls: readonly ModelToolCall[];
  readonly identity: RuntimeEventIdentity;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly round: number;
  readonly capabilityToolHost?: RoleModelCapabilityToolHost;
  readonly onCapabilityToolCallStarted?: (
    event: RoleModelCapabilityToolCallStartedEvent
  ) => Promise<void> | void;
  readonly resolveToolCapabilityId?: (toolName: string) => string | undefined;
  readonly runtimeCapabilityContext?: RuntimeCapabilityContext;
}): Promise<CapabilityToolRoutingResult> {
  const results: RoleModelCapabilityToolRoutingEvidence[] = [];

  for (const [index, toolCall] of options.toolCalls.entries()) {
    const capabilityId =
      options.resolveToolCapabilityId?.(toolCall.name) ??
      findCapabilityToolDefinition(
      options.inputEnvelope.capabilityToolDefinitions,
      toolCall.name
      )?.capabilityId;

    const routedCall = createAgentCapabilityToolCall({
      identity: options.identity,
      capabilityId: capabilityId ?? undeclaredToolCapabilityId(toolCall.name),
      toolCall
    });
    const callId = createToolCallId({
      index,
      round: options.round,
      toolName: toolCall.name
    });

    await options.onCapabilityToolCallStarted?.({
      callId,
      round: options.round,
      call: routedCall
    });

    if (
      capabilityId === undefined ||
      options.capabilityToolHost === undefined ||
      options.runtimeCapabilityContext === undefined
    ) {
      results.push(
        createRejectedToolRoutingEvidence({
          callId,
          call: routedCall,
          reason:
            capabilityId === undefined
              ? 'tool_not_declared'
              : 'tool_host_missing',
          message:
            capabilityId === undefined
              ? `Tool "${toolCall.name}" is not declared for this turn.`
              : `Tool "${toolCall.name}" has no host handler for this turn.`
        })
      );
      continue;
    }

    let hostResult: AgentCapabilityToolCallResult;

    try {
      hostResult = await options.capabilityToolHost.handleToolCall(
        routedCall,
        options.runtimeCapabilityContext
      );
    } catch (error: unknown) {
      results.push(
        createRejectedToolRoutingEvidence({
          callId,
          call: routedCall,
          reason: 'handler_failed',
          message:
          error instanceof Error
            ? error.message
            : `Tool "${toolCall.name}" handler failed.`
        })
      );
      continue;
    }

    const routingEvidence = Object.freeze({
      callId,
      call: routedCall,
      result: freezeAgentCapabilityToolCallResult(hostResult)
    } satisfies RoleModelCapabilityToolRoutingEvidence);

    results.push(routingEvidence);
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

function createRejectedToolRoutingEvidence(options: {
  readonly callId: string;
  readonly call: AgentCapabilityToolCall;
  readonly reason: string;
  readonly message: string;
}): RoleModelCapabilityToolRoutingEvidence {
  return Object.freeze({
    callId: options.callId,
    call: options.call,
    result: Object.freeze({
      status: 'rejected',
      reason: options.reason,
      message: options.message,
      evidence: Object.freeze([])
    } satisfies AgentCapabilityToolCallResult)
  } satisfies RoleModelCapabilityToolRoutingEvidence);
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

function undeclaredToolCapabilityId(toolName: string): string {
  if (toolName === characterStatePatchModelToolName) {
    return 'character-state';
  }

  return `undeclared.${toolName}`;
}

function createToolCallId(options: {
  readonly index: number;
  readonly round: number;
  readonly toolName: string;
}): string {
  return `round-${String(options.round)}.${String(options.index + 1)}.${options.toolName}`;
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
