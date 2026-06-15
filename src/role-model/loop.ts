import {
  createDeterministicCharacterAgent,
  validateCharacterAgentReply,
  type CharacterAgent
} from '../core/conversation.ts';
import {
  roleModelPluginToolRejectedRejectionReason,
  createParsedRoleModelDecisionSnapshot,
  createRoleModelToolObservation,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
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
  type RoleModelPluginToolDefinition,
  type RejectedRoleModelDecisionResult,
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  type RoleModelInputEnvelope,
  type RoleModelIOSnapshot,
  type RoleModelProviderMetadata,
  type RoleModelToolObservation
} from './contracts.ts';
import {
  characterStatePatchModelToolName,
  createVisibleReplyModelToolCall,
  visibleReplyModelToolName,
  type ModelToolCall
} from './model-tools.ts';
import {
  freezeRoleModelChatMessage,
  renderRoleModelTurnContext,
  type RoleModelAssistantChatMessage,
  type RoleModelChatMessage,
  type RoleModelChatToolCall,
  type RoleModelToolChatMessage,
  type RoleModelTurnContext
} from './prompt.ts';
import type {
  RuntimePluginJsonObject,
  RuntimePluginJsonValue,
  RuntimePluginToolCall,
  RuntimePluginToolCallResult,
  RuntimePluginContext
} from '../plugins/types.ts';
import type { RuntimeEventIdentity, UserMessageRuntimeEvent } from '../runtime/event.ts';

export { parseRoleModelDecision } from './contracts.ts';

export type RoleModelAdapterRawOutput = {
  readonly rawOutputText: string;
  readonly providerMetadata?: RoleModelProviderMetadata;
  readonly rejection?: RoleModelDecisionRejection;
  readonly nativeAssistantMessage?: RoleModelAssistantChatMessage;
};

export type RoleModelAdapterInvocation = {
  readonly turnContext: RoleModelTurnContext;
};

export type RoleModelAdapter = {
  invoke(
    inputEnvelope: RoleModelInputEnvelope,
    invocation: RoleModelAdapterInvocation
  ): Promise<RoleModelAdapterRawOutput> | RoleModelAdapterRawOutput;
};

export type RunRoleModelLoopOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly adapter?: RoleModelAdapter;
  readonly pluginToolDefinitions?: readonly RoleModelPluginToolDefinition[];
  readonly pluginToolHost?: RoleModelPluginToolHost;
  readonly resolveToolPluginId?: (toolName: string) => string | undefined;
  readonly maxPluginToolRounds?: number;
  readonly maxToolRounds?: number;
  readonly onPluginToolCallStarted?: (
    event: RoleModelPluginToolCallStartedEvent
  ) => Promise<void> | void;
  readonly onPluginToolCallCompleted?: (
    event: RoleModelPluginToolCallCompletedEvent
  ) => Promise<void> | void;
  readonly onPluginToolCallsRequested?: (
    event: RoleModelPluginToolCallsRequestedEvent
  ) => Promise<void> | void;
  readonly onInterimVisibleReply?: (
    event: RoleModelInterimVisibleReplyEvent
  ) => Promise<void> | void;
  readonly runtimePluginContext?: RuntimePluginContext;
};

export type RoleModelPluginToolHost = {
  readonly handleToolCall: (
    call: RuntimePluginToolCall,
    context: RuntimePluginContext
  ) => RuntimePluginToolCallResult | Promise<RuntimePluginToolCallResult>;
};

export type RoleModelPluginToolRoutingEvidence = {
  readonly callId: string;
  readonly call: RuntimePluginToolCall;
  readonly result: RuntimePluginToolCallResult;
};

export type RoleModelInterimVisibleReplyEvent = {
  readonly round: number;
  readonly text: string;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
};

export type RoleModelPluginToolCallsRequestedEvent = {
  readonly round: number;
  readonly toolNames: readonly string[];
};

export type RoleModelPluginToolCallStartedEvent = {
  readonly callId: string;
  readonly round: number;
  readonly call: RuntimePluginToolCall;
};

export type RoleModelPluginToolCallCompletedEvent = {
  readonly callId: string;
  readonly pluginId: string;
  readonly round: number;
  readonly status: RuntimePluginToolCallResult['status'];
  readonly toolName: string;
  readonly result: RuntimePluginToolCallResult;
};

export type RoleModelLoopRound = {
  readonly round: number;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
};

export type AcceptedRoleModelLoopResult = {
  readonly status: 'accepted';
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly decisionResult: AcceptedRoleModelDecisionResult;
  readonly decision: CharacterDecision;
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
  readonly rounds: readonly RoleModelLoopRound[];
};

export type RejectedRoleModelLoopResult = {
  readonly status: 'rejected';
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly decisionResult: RejectedRoleModelDecisionResult;
  readonly rejection: RoleModelDecisionRejection;
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
  readonly rounds: readonly RoleModelLoopRound[];
};

export type RoleModelLoopResult =
  | AcceptedRoleModelLoopResult
  | RejectedRoleModelLoopResult;

export const defaultRoleModelMaxToolRounds = 99;
export const defaultRoleModelMaxPluginToolRounds =
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
        JSON.stringify({
          toolCalls: [createVisibleReplyModelToolCall(characterReply.text)]
        })
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
    options.maxPluginToolRounds ??
    defaultRoleModelMaxToolRounds;
  const identity = createSnapshotIdentity(options.event);
  const sessionId = options.decisionContext.sessionId;
  const rounds: RoleModelLoopRound[] = [];
  const allPluginToolResults: RoleModelPluginToolRoutingEvidence[] = [];
  let toolRounds = 0;
  let toolObservations: readonly RoleModelToolObservation[] = Object.freeze([]);
  let nativeAdditionalMessages: readonly RoleModelChatMessage[] = Object.freeze([]);

  for (let round = 1; ; round += 1) {
    const inputEnvelope = createRoleModelInputEnvelope({
      event: options.event,
      decisionContext: options.decisionContext,
      pluginToolDefinitions: options.pluginToolDefinitions ?? [],
      toolObservations
    });
    const turnContext = renderRoleModelTurnContext(inputEnvelope, {
      additionalMessages: nativeAdditionalMessages
    });
    const rawOutput: unknown = await adapter.invoke(inputEnvelope, {
      turnContext
    });
    const rawOutputValidation = validateRoleModelAdapterRawOutput(
      rawOutput,
      inputEnvelope.allowedTools,
      inputEnvelope.pluginToolDefinitions
    );
    const nativeAssistantMessage =
      rawOutputValidation.status === 'accepted'
        ? rawOutputValidation.nativeAssistantMessage
        : undefined;
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
            inputEnvelope.pluginToolDefinitions,
            toolObservations
          )
        : rawOutputValidation.decisionResult;
    const parsedDecisionSnapshot = createParsedRoleModelDecisionSnapshot({
      ...identity,
      sessionId,
      result: decisionResult
    });

    if (decisionResult.status === 'rejected') {
      const loopRound = createRoleModelLoopRound({
        pluginToolResults: [],
        inputEnvelope,
        ioSnapshot,
        parsedDecisionSnapshot,
        round
      });

      rounds.push(loopRound);

      return createRejectedRoleModelLoopResult({
        pluginToolResults: allPluginToolResults,
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
          pluginToolResults: [],
          inputEnvelope,
          ioSnapshot,
          parsedDecisionSnapshot,
          round
        });

        rounds.push(loopRound);

        return createRejectedRoleModelLoopResult({
          pluginToolResults: allPluginToolResults,
          decisionResult: rejectedDecisionResult,
          inputEnvelope,
          ioSnapshot,
          parsedDecisionSnapshot,
          rounds
        });
      }

      const loopRound = createRoleModelLoopRound({
        pluginToolResults: [],
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
        pluginToolResults: Object.freeze([...allPluginToolResults]),
        rounds: Object.freeze([...rounds])
      } satisfies AcceptedRoleModelLoopResult);
    }

    if (toolRounds >= maxToolRounds) {
      const rejectedDecisionResult = createRejectedRoleModelDecisionResult(
        roleModelPluginToolRejectedRejectionReason,
        `Role model exceeded maximum executable tool rounds (${String(maxToolRounds)}).`
      );
      const loopRound = createRoleModelLoopRound({
        pluginToolResults: [],
        inputEnvelope,
        ioSnapshot,
        parsedDecisionSnapshot,
        round
      });

      rounds.push(loopRound);

      return createRejectedRoleModelLoopResult({
        pluginToolResults: allPluginToolResults,
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

    await options.onPluginToolCallsRequested?.({
      round,
      toolNames: executableToolCalls.map((call) => call.name)
    });

    const pluginToolRouting = await routeExecutableToolCalls({
      toolCalls: executableToolCalls,
      identity,
      inputEnvelope,
      round,
      ...(options.resolveToolPluginId === undefined
        ? {}
        : { resolveToolPluginId: options.resolveToolPluginId }),
      ...(options.onPluginToolCallStarted === undefined
        ? {}
        : { onPluginToolCallStarted: options.onPluginToolCallStarted }),
      ...(options.pluginToolHost === undefined
        ? {}
        : { pluginToolHost: options.pluginToolHost }),
      ...(options.runtimePluginContext === undefined
        ? {}
        : { runtimePluginContext: options.runtimePluginContext })
    });

    for (const result of pluginToolRouting.results) {
      await options.onPluginToolCallCompleted?.({
        round,
        callId: result.callId,
        pluginId: result.call.pluginId,
        toolName: result.call.toolName,
        status: result.result.status,
        result: result.result
      });
    }

    allPluginToolResults.push(...pluginToolRouting.results);

    const loopRound = createRoleModelLoopRound({
      pluginToolResults: pluginToolRouting.results,
      inputEnvelope,
      ioSnapshot,
      parsedDecisionSnapshot,
      round
    });

    rounds.push(loopRound);

    if (pluginToolRouting.status === 'rejected') {
      return createRejectedRoleModelLoopResult({
        pluginToolResults: allPluginToolResults,
        decisionResult: pluginToolRouting.decisionResult,
        inputEnvelope,
        ioSnapshot,
        parsedDecisionSnapshot,
        rounds
      });
    }

    nativeAdditionalMessages = appendNativeToolRoundMessages({
      assistantMessage: nativeAssistantMessage,
      previousMessages: nativeAdditionalMessages,
      results: pluginToolRouting.results
    });

    toolRounds += 1;
    toolObservations = Object.freeze([
      ...toolObservations,
      ...pluginToolRouting.results.map((routing) =>
        createToolObservationFromRouting({ round, routing })
      )
    ]);
  }
}

type PluginToolRoutingResult =
  | {
      readonly status: 'accepted';
      readonly results: readonly RoleModelPluginToolRoutingEvidence[];
    }
  | {
      readonly status: 'rejected';
      readonly results: readonly RoleModelPluginToolRoutingEvidence[];
      readonly decisionResult: RejectedRoleModelDecisionResult;
    };

function createRoleModelLoopRound(options: {
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
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
    pluginToolResults: Object.freeze([...options.pluginToolResults])
  } satisfies RoleModelLoopRound);
}

function createRejectedRoleModelLoopResult(options: {
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
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
    pluginToolResults: Object.freeze([...options.pluginToolResults]),
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
  readonly routing: RoleModelPluginToolRoutingEvidence;
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
    pluginId: options.routing.call.pluginId,
    toolName: options.routing.call.toolName,
    input: options.routing.call.input,
    result
  });
}

function appendNativeToolRoundMessages(options: {
  readonly assistantMessage: RoleModelAssistantChatMessage | undefined;
  readonly previousMessages: readonly RoleModelChatMessage[];
  readonly results: readonly RoleModelPluginToolRoutingEvidence[];
}): readonly RoleModelChatMessage[] {
  if (
    options.assistantMessage === undefined ||
    options.results.length === 0
  ) {
    return options.previousMessages;
  }

  return Object.freeze([
    ...options.previousMessages,
    freezeRoleModelChatMessage(options.assistantMessage),
    ...createNativeToolResultMessages({
      assistantMessage: options.assistantMessage,
      results: options.results
    })
  ]);
}

function createNativeToolResultMessages(options: {
  readonly assistantMessage: RoleModelAssistantChatMessage;
  readonly results: readonly RoleModelPluginToolRoutingEvidence[];
}): readonly RoleModelToolChatMessage[] {
  let executableResultIndex = 0;
  const nativeToolCalls = options.assistantMessage.tool_calls ?? [];

  if (nativeToolCalls.length === 0) {
    return Object.freeze(
      options.results.map((result) =>
        Object.freeze({
          role: 'tool',
          tool_call_id: result.callId,
          content: JSON.stringify(createNativeToolResultMessageContent(result))
        } satisfies RoleModelToolChatMessage)
      )
    );
  }

  return Object.freeze(
    nativeToolCalls.map((toolCall) => {
      if (toolCall.function.name === visibleReplyModelToolName) {
        return Object.freeze({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(createNativeVisibleReplyToolResultContent())
        } satisfies RoleModelToolChatMessage);
      }

      const result = options.results[executableResultIndex];

      executableResultIndex += 1;

      return Object.freeze({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(
          result === undefined
            ? createNativeMissingToolResultContent(toolCall.function.name)
            : createNativeToolResultMessageContent(result)
        )
      } satisfies RoleModelToolChatMessage);
    })
  );
}

function createNativeToolResultMessageContent(
  result: RoleModelPluginToolRoutingEvidence
): Readonly<Record<string, RuntimePluginJsonValue>> {
  if (result.result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      pluginId: result.call.pluginId,
      toolName: result.call.toolName,
      output: result.result.output
    });
  }

  return Object.freeze({
    status: 'rejected',
    pluginId: result.call.pluginId,
    toolName: result.call.toolName,
    reason: result.result.reason,
    message: result.result.message
  });
}

function createNativeVisibleReplyToolResultContent(): Readonly<
  Record<string, RuntimePluginJsonValue>
> {
  return Object.freeze({
    status: 'accepted',
    toolName: visibleReplyModelToolName,
    output: Object.freeze({
      kind: 'interim_visible_reply'
    })
  });
}

function createNativeMissingToolResultContent(
  toolName: string
): Readonly<Record<string, RuntimePluginJsonValue>> {
  return Object.freeze({
    status: 'rejected',
    toolName,
    reason: 'tool_result_missing',
    message: `No routed plugin result was available for native tool call "${toolName}".`
  });
}

async function routeExecutableToolCalls(options: {
  readonly toolCalls: readonly ModelToolCall[];
  readonly identity: RuntimeEventIdentity;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly round: number;
  readonly pluginToolHost?: RoleModelPluginToolHost;
  readonly onPluginToolCallStarted?: (
    event: RoleModelPluginToolCallStartedEvent
  ) => Promise<void> | void;
  readonly resolveToolPluginId?: (toolName: string) => string | undefined;
  readonly runtimePluginContext?: RuntimePluginContext;
}): Promise<PluginToolRoutingResult> {
  const results: RoleModelPluginToolRoutingEvidence[] = [];

  for (const [index, toolCall] of options.toolCalls.entries()) {
    const toolDefinition = findPluginToolDefinition(
      options.inputEnvelope.pluginToolDefinitions,
      toolCall.name
    );
    const pluginId =
      options.resolveToolPluginId?.(toolCall.name) ??
      toolDefinition?.pluginId;

    const routedCall = createRuntimePluginToolCall({
      identity: options.identity,
      pluginId: pluginId ?? undeclaredToolPluginId(toolCall.name),
      toolCall
    });
    const callId = createToolCallId({
      index,
      round: options.round,
      toolName: toolCall.name
    });

    await options.onPluginToolCallStarted?.({
      callId,
      round: options.round,
      call: routedCall
    });

    if (
      pluginId === undefined ||
      options.pluginToolHost === undefined ||
      options.runtimePluginContext === undefined
    ) {
      const routingEvidence = createRejectedToolRoutingEvidence({
        callId,
        call: routedCall,
        reason:
          pluginId === undefined ? 'tool_not_declared' : 'tool_host_missing',
        message:
          pluginId === undefined
            ? `Tool "${toolCall.name}" is not declared for this turn.`
            : `Tool "${toolCall.name}" has no host handler for this turn.`
      });

      results.push(routingEvidence);
      return createRejectedPluginToolRoutingResult({
        results,
        routing: routingEvidence
      });
    }

    let hostResult: RuntimePluginToolCallResult;

    try {
      hostResult = await options.pluginToolHost.handleToolCall(
        routedCall,
        options.runtimePluginContext
      );
    } catch (error: unknown) {
      const routingEvidence = createRejectedToolRoutingEvidence({
        callId,
        call: routedCall,
        reason: 'handler_failed',
        message:
          error instanceof Error
            ? error.message
            : `Tool "${toolCall.name}" handler failed.`
      });

      results.push(routingEvidence);
      return createRejectedPluginToolRoutingResult({
        results,
        routing: routingEvidence
      });
    }

    let frozenHostResult: RuntimePluginToolCallResult;

    try {
      frozenHostResult = freezeRuntimePluginToolCallResult(hostResult);
    } catch (error: unknown) {
      const routingEvidence = createRejectedToolRoutingEvidence({
        callId,
        call: routedCall,
        reason: 'invalid_tool_output',
        message:
          error instanceof Error
            ? error.message
            : `Tool "${toolCall.name}" returned invalid output.`
      });

      results.push(routingEvidence);
      return createRejectedPluginToolRoutingResult({
        results,
        routing: routingEvidence
      });
    }

    const routingEvidence = Object.freeze({
      callId,
      call: routedCall,
      result: frozenHostResult
    } satisfies RoleModelPluginToolRoutingEvidence);

    results.push(routingEvidence);

    if (
      pluginToolResultRejectsLoop({
        routing: routingEvidence,
        toolDefinition
      })
    ) {
      return createRejectedPluginToolRoutingResult({
        results,
        routing: routingEvidence
      });
    }
  }

  return createAcceptedPluginToolRoutingResult(results);
}

function createAcceptedPluginToolRoutingResult(
  results: readonly RoleModelPluginToolRoutingEvidence[]
): PluginToolRoutingResult {
  return Object.freeze({
    status: 'accepted',
    results: Object.freeze([...results])
  } satisfies PluginToolRoutingResult);
}

function createRejectedPluginToolRoutingResult(options: {
  readonly results: readonly RoleModelPluginToolRoutingEvidence[];
  readonly routing: RoleModelPluginToolRoutingEvidence;
}): PluginToolRoutingResult {
  const result = options.routing.result;

  if (result.status !== 'rejected') {
    throw new Error('Expected rejected plugin tool routing result.');
  }

  return Object.freeze({
    status: 'rejected',
    results: Object.freeze([...options.results]),
    decisionResult: createRejectedRoleModelDecisionResult(
      roleModelPluginToolRejectedRejectionReason,
      `Plugin tool "${options.routing.call.toolName}" rejected the tool call: ${result.message}`
    )
  } satisfies PluginToolRoutingResult);
}

function createRejectedToolRoutingEvidence(options: {
  readonly callId: string;
  readonly call: RuntimePluginToolCall;
  readonly reason: string;
  readonly message: string;
}): RoleModelPluginToolRoutingEvidence {
  return Object.freeze({
    callId: options.callId,
    call: options.call,
    result: Object.freeze({
      status: 'rejected',
      reason: options.reason,
      message: options.message,
      evidence: Object.freeze([])
    } satisfies RuntimePluginToolCallResult)
  } satisfies RoleModelPluginToolRoutingEvidence);
}

function pluginToolResultRejectsLoop(options: {
  readonly routing: RoleModelPluginToolRoutingEvidence;
  readonly toolDefinition: RoleModelPluginToolDefinition | undefined;
}): boolean {
  const result = options.routing.result;

  if (result.status !== 'rejected') {
    return false;
  }

  if (options.toolDefinition?.requiredForUserTurn === true) {
    return true;
  }

  if (result.evidence.some(toolInvocationEvidenceRejectsLoop)) {
    return true;
  }

  return !result.evidence.some(
    (evidence) =>
      evidence.evidenceKind === 'tool_invocation' &&
      (evidence.status === 'degraded' ||
        evidence.policyOutcome === 'optional_degraded')
  );
}

function toolInvocationEvidenceRejectsLoop(
  evidence: RuntimePluginToolCallResult['evidence'][number]
): boolean {
  if (evidence.evidenceKind !== 'tool_invocation') {
    return false;
  }

  if (evidence.status === 'rejected' || evidence.status === 'failed') {
    return true;
  }

  return (
    evidence.policyOutcome === 'handler_rejected' ||
    evidence.policyOutcome === 'required_rejected' ||
    evidence.policyOutcome === 'disallowed_tool_call'
  );
}

function findPluginToolDefinition(
  definitions: readonly RoleModelPluginToolDefinition[],
  toolName: string
): RoleModelPluginToolDefinition | undefined {
  return definitions.find((definition) => definition.name === toolName);
}

function createRuntimePluginToolCall(options: {
  readonly identity: RuntimeEventIdentity;
  readonly pluginId: string;
  readonly toolCall: ModelToolCall;
}): RuntimePluginToolCall {
  return Object.freeze({
    eventId: options.identity.eventId,
    traceId: options.identity.traceId,
    createdAt: options.identity.createdAt,
    pluginId: options.pluginId,
    toolName: options.toolCall.name,
    input: freezeRuntimePluginJsonObject(options.toolCall.input)
  } satisfies RuntimePluginToolCall);
}

function undeclaredToolPluginId(toolName: string): string {
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

function freezeRuntimePluginToolCallResult(
  result: RuntimePluginToolCallResult
): RuntimePluginToolCallResult {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      output: freezeRuntimePluginJsonValue(result.output),
      evidence: Object.freeze([...result.evidence])
    } satisfies RuntimePluginToolCallResult);
  }

  return Object.freeze({
    status: 'rejected',
    reason: result.reason,
    message: result.message,
    evidence: Object.freeze([...result.evidence])
  } satisfies RuntimePluginToolCallResult);
}

function freezeRuntimePluginJsonObject(
  value: Readonly<Record<string, unknown>>
): RuntimePluginJsonObject {
  const snapshot: Record<string, RuntimePluginJsonValue> = {};

  for (const [key, item] of Object.entries(value)) {
    snapshot[key] = freezeRuntimePluginJsonValue(item);
  }

  return Object.freeze(snapshot);
}

function freezeRuntimePluginJsonValue(
  value: unknown
): RuntimePluginJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Plugin tool output must be finite JSON.');
    }

    return value;
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeRuntimePluginJsonValue));
  }

  if (isJsonRecord(value)) {
    return freezeRuntimePluginJsonObject(value);
  }

  throw new TypeError('Plugin tool output must be JSON serializable.');
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
      readonly nativeAssistantMessage?: RoleModelAssistantChatMessage;
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
  pluginToolDefinitions: readonly RoleModelPluginToolDefinition[]
): RoleModelAdapterRawOutputValidationResult {
  if (!isJsonRecord(rawOutput)) {
    return createMalformedAdapterRawOutputResult();
  }

  const rawOutputText = rawOutput['rawOutputText'];

  if (typeof rawOutputText !== 'string') {
    return createMalformedAdapterRawOutputResult();
  }

  const providerMetadataResult = optionalProviderMetadata(
    rawOutput['providerMetadata']
  );

  if (providerMetadataResult.status === 'rejected') {
    return createMalformedAdapterRawOutputResult(providerMetadataResult.details);
  }

  const providerMetadata = providerMetadataResult.providerMetadata;
  const rejection = optionalRoleModelDecisionRejection(rawOutput['rejection']);
  const nativeAssistantMessage = optionalRoleModelAssistantChatMessage(
    rawOutput['nativeAssistantMessage']
  );

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
        pluginToolDefinitions
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
    ...providerMetadataOption(providerMetadata),
    ...nativeAssistantMessageOption(nativeAssistantMessage)
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

function nativeAssistantMessageOption(
  nativeAssistantMessage: RoleModelAssistantChatMessage | undefined
): { readonly nativeAssistantMessage?: RoleModelAssistantChatMessage } {
  return nativeAssistantMessage === undefined ? {} : { nativeAssistantMessage };
}

function optionalRoleModelAssistantChatMessage(
  value: unknown
): RoleModelAssistantChatMessage | undefined {
  if (!isJsonRecord(value) || value['role'] !== 'assistant') {
    return undefined;
  }

  const content = value['content'];
  const toolCalls = optionalRoleModelChatToolCalls(value['tool_calls']);

  if (content !== null && typeof content !== 'string') {
    return undefined;
  }

  return Object.freeze({
    role: 'assistant',
    content,
    ...(toolCalls === undefined ? {} : { tool_calls: toolCalls })
  } satisfies RoleModelAssistantChatMessage);
}

function optionalRoleModelChatToolCalls(
  value: unknown
): readonly RoleModelChatToolCall[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const calls: RoleModelChatToolCall[] = [];

  for (const item of value) {
    const call = optionalRoleModelChatToolCall(item);

    if (call === undefined) {
      return undefined;
    }

    calls.push(call);
  }

  return Object.freeze(calls);
}

function optionalRoleModelChatToolCall(
  value: unknown
): RoleModelChatToolCall | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const id = value['id'];
  const type = value['type'];
  const fn = value['function'];

  if (typeof id !== 'string' || type !== 'function' || !isJsonRecord(fn)) {
    return undefined;
  }

  const name = fn['name'];
  const args = fn['arguments'];

  if (typeof name !== 'string' || typeof args !== 'string') {
    return undefined;
  }

  return Object.freeze({
    id,
    type: 'function',
    function: Object.freeze({
      name,
      arguments: args
    })
  } satisfies RoleModelChatToolCall);
}

function optionalProviderMetadata(
  value: unknown
):
  | {
      readonly status: 'accepted';
      readonly providerMetadata?: RoleModelProviderMetadata;
    }
  | {
      readonly status: 'rejected';
      readonly details: string;
    } {
  if (value === undefined) {
    return Object.freeze({ status: 'accepted' });
  }

  if (!isJsonRecord(value)) {
    return Object.freeze({ status: 'accepted' });
  }

  const provider = value['provider'];

  if (provider !== 'local' && provider !== 'nvidia') {
    return Object.freeze({ status: 'accepted' });
  }

  const model = value['model'];
  const request = optionalProviderRequestMetadata(value['request']);
  const response = optionalProviderResponseMetadata(value['response']);
  const error = optionalProviderErrorMetadata(value['error']);

  if (request?.status === 'rejected') {
    return request;
  }

  if (response?.status === 'rejected') {
    return response;
  }

  return Object.freeze({
    status: 'accepted',
    providerMetadata: Object.freeze({
      provider,
      ...(typeof model === 'string' ? { model } : {}),
      ...(request === undefined ? {} : { request: request.request }),
      ...(response === undefined ? {} : { response: response.response }),
      ...(error === undefined ? {} : { error })
    } satisfies RoleModelProviderMetadata)
  });
}

type ProviderRequestMetadata = NonNullable<RoleModelProviderMetadata['request']>;
type ProviderResponseMetadata = NonNullable<RoleModelProviderMetadata['response']>;

function optionalProviderRequestMetadata(
  value: unknown
):
  | {
      readonly status: 'accepted';
      readonly request: ProviderRequestMetadata;
    }
  | {
      readonly status: 'rejected';
      readonly details: string;
    }
  | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const endpoint = value['endpoint'];
  const messageCount = value['messageCount'];

  if (typeof messageCount === 'number' && !Number.isFinite(messageCount)) {
    return Object.freeze({
      status: 'rejected',
      details: 'providerMetadata.request.messageCount must be finite JSON.'
    });
  }

  return Object.freeze({
    status: 'accepted',
    request: Object.freeze({
      ...(typeof endpoint === 'string' ? { endpoint } : {}),
      ...(typeof messageCount === 'number' ? { messageCount } : {}),
      stream: false
    })
  });
}

function optionalProviderResponseMetadata(
  value: unknown
):
  | {
      readonly status: 'accepted';
      readonly response: ProviderResponseMetadata;
    }
  | {
      readonly status: 'rejected';
      readonly details: string;
    }
  | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const status = value['status'];

  if (typeof status === 'number' && !Number.isFinite(status)) {
    return Object.freeze({
      status: 'rejected',
      details: 'providerMetadata.response.status must be finite JSON.'
    });
  }

  return Object.freeze({
    status: 'accepted',
    response: Object.freeze({
      ...(typeof status === 'number' ? { status } : {})
    })
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
