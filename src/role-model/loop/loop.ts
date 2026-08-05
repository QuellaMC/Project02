import {createDeterministicLocalRoleModelAdapter} from '../providers/local.ts';
import {isDeepStrictEqual} from 'node:util';

import {
  type RuntimeEventIdentity,
  type UserMessageRuntimeEvent,
} from '../../core/index.ts';
import {
  type AcceptedRoleModelDecisionResult,
  type CharacterDecision,
  type DecisionContext,
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelPluginToolDefinition,
  type RejectedRoleModelDecisionResult,
  type RoleModelCharacterRef,
  type RoleModelInputEnvelope,
  type RoleModelIOSnapshot,
  type RoleModelToolObservation,
} from '../api/contracts.ts';
import {
  assertRoleModelCharacterRefMatchesCharacter,
  createParsedRoleModelDecisionSnapshot,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createRoleModelToolObservation,
} from '../api/decision.ts';
import {parseRoleModelExecutionDecision} from './decision-parser.ts';
import {
  createToolBatchLock,
  type ToolBatchLockMode,
} from './tool-batch-lock.ts';
import {
  providerExchangeOption,
  providerMetadataOption,
  validateRoleModelAdapterRawOutput,
} from './adapter-raw-output.ts';
import {
  createRejectedToolRoutingEvidence,
  missingRoutingTargetRejection,
  type RoleModelPluginToolRoutingEvidence,
} from './routing-rejections.ts';
import type {
  RoleModelAdapter,
  RoleModelNativeToolCallArgumentError,
} from '../api/adapter.ts';
import {
  visibleReplyModelToolName,
  type ModelToolCall,
} from '../api/model-tools.ts';
import {type RoleModelAllowedToolName} from '../api/tool-names.ts';
import {
  freezeRoleModelChatMessage,
  type RoleModelAssistantChatMessage,
  type RoleModelChatMessage,
  type RoleModelChatToolCall,
  type RoleModelProviderToolNameMapping,
  type RoleModelToolChatMessage,
} from '../api/chat-wire.ts';
import {renderRoleModelTurnContext} from '../prompt/render.ts';
import {runtimeToolNameForProviderToolName} from '../prompt/tool-wire.ts';
import {
  createPreparedRuntimePluginConfigEffect,
  createRuntimePluginToolCallResultSnapshot,
  type PreparedRuntimePluginConfigEffect,
  type RuntimePluginJsonValue,
  type RuntimePluginToolCall,
  type RuntimePluginToolCallExecutionResult,
  type RuntimePluginToolCallResult,
  type RuntimePluginContext,
} from '../../plugins/api/index.ts';
import {runtimePluginToolResultHasBlockingEvidence} from '../../plugins/api/index.ts';
import {createJsonBoundaryObjectSnapshot} from '../../shared/json-boundary.ts';

export type RunRoleModelLoopOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly adapter?: RoleModelAdapter;
  readonly allowedTools?: readonly RoleModelAllowedToolName[];
  readonly pluginToolDefinitions: readonly RoleModelPluginToolDefinition[];
  readonly pluginToolHost?: RoleModelPluginToolHost;
  readonly preparedConfigEffectsByToolCallId?: Map<
    string,
    PreparedRuntimePluginConfigEffect
  >;
  readonly maxToolRounds?: number;
  readonly onPluginToolCallStarted?: (
    event: RoleModelPluginToolCallStartedEvent,
  ) => Promise<void> | void;
  readonly onPluginToolCallCompleted?: (
    event: RoleModelPluginToolCallCompletedEvent,
  ) => Promise<void> | void;
  readonly onPluginToolCallsRequested?: (
    event: RoleModelPluginToolCallsRequestedEvent,
  ) => Promise<void> | void;
  /**
   * Every visible reply of an accepted round, interim or terminal.
   * Required, because an undelivered reply is user-facing text lost. A
   * rejected round delivers nothing: it commits no part of itself.
   */
  readonly onVisibleReply: (
    event: RoleModelVisibleReplyEvent,
  ) => Promise<void> | void;
  readonly runtimePluginContext?: RuntimePluginContext;
  readonly personaSections?: readonly string[];
  readonly characterRef?: RoleModelCharacterRef;
};

export type RoleModelPluginToolHost = {
  readonly handleToolCall: (
    call: RuntimePluginToolCall,
    context: RuntimePluginContext,
  ) =>
    | RuntimePluginToolCallExecutionResult
    | Promise<RuntimePluginToolCallExecutionResult>;
};

export {type RoleModelPluginToolRoutingEvidence} from './routing-rejections.ts';

export type RoleModelVisibleReplyEvent = {
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
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
};

export type RoleModelPluginToolCallCompletedEvent = {
  readonly callId: string;
  readonly dispatchedToHost: boolean;
  readonly pluginId: string;
  readonly round: number;
  readonly status: RuntimePluginToolCallResult['status'];
  readonly toolName: string;
  readonly result: RuntimePluginToolCallResult;
};

export {
  appendRejectedRoleModelLoopRound,
  createRoleModelLoopRound,
  executionVisibleReplyTexts,
  terminalRoleModelLoopResult,
  type AcceptedRoleModelLoopResult,
  type RejectedRoleModelLoopResult,
  type RoleModelLoopResult,
  type RoleModelLoopRound,
  type RoleModelLoopState,
} from './round-outcome.ts';
import {
  appendRejectedRoleModelLoopRound,
  createRoleModelLoopRound,
  executionVisibleReplyTexts,
  terminalRoleModelLoopResult,
  type RoleModelLoopResult,
  type RoleModelLoopState,
} from './round-outcome.ts';

export const defaultRoleModelMaxToolRounds = 99;

export async function runRoleModelLoop(
  options: RunRoleModelLoopOptions,
): Promise<RoleModelLoopResult> {
  // The snapshot constructor enforces this too, but rejecting up front
  // keeps a contradictory ref from reaching the provider at all.
  if (options.characterRef !== undefined) {
    assertRoleModelCharacterRefMatchesCharacter(
      options.characterRef,
      options.decisionContext.characterSnapshot,
    );
  }

  const adapter = options.adapter ?? createDeterministicLocalRoleModelAdapter();
  const maxToolRounds = normalizeMaxToolRounds(options.maxToolRounds);
  const identity = createSnapshotIdentity(options.event);
  const sessionId = options.decisionContext.sessionId;
  const state: RoleModelLoopState = {
    rounds: [],
    allPluginToolResults: [],
    toolRounds: 0,
    toolObservations: Object.freeze([]),
    nativeAdditionalMessages: Object.freeze([]),
  };

  for (let round = 1; ; round += 1) {
    const invokedRound = await invokeRoleModelLoopRound({
      options,
      adapter,
      identity,
      sessionId,
      round,
      state,
    });

    if (invokedRound.status === 'rejected') {
      return appendRejectedRoleModelLoopRound({state, invokedRound, round});
    }

    const terminalResult = terminalRoleModelLoopResult({
      state,
      invokedRound,
      identity,
      sessionId,
      round,
      maxToolRounds,
    });

    if (terminalResult === 'continue') {
      continue;
    }

    if (terminalResult !== undefined) {
      if (terminalResult.status === 'accepted') {
        // From the execution decision, not the evidence snapshot, which
        // may hold a redacted projection of the text.
        await deliverVisibleReply({
          options,
          round,
          decision: invokedRound.decisionResult.decision,
          inputEnvelope: terminalResult.inputEnvelope,
          ioSnapshot: terminalResult.ioSnapshot,
          parsedDecisionSnapshot: terminalResult.parsedDecisionSnapshot,
        });
      }

      return terminalResult;
    }

    const pluginToolRouting = await routeRoleModelLoopToolCalls({
      options,
      identity,
      invokedRound,
      round,
      toolObservations: state.toolObservations,
    });

    recordRoleModelLoopToolRound({
      state,
      invokedRound,
      pluginToolRouting,
      round,
    });
  }
}

async function deliverVisibleReply(delivery: {
  readonly options: RunRoleModelLoopOptions;
  readonly round: number;
  readonly decision: CharacterDecision;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
}): Promise<void> {
  for (const text of executionVisibleReplyTexts(delivery.decision)) {
    await delivery.options.onVisibleReply({
      round: delivery.round,
      text,
      inputEnvelope: delivery.inputEnvelope,
      ioSnapshot: delivery.ioSnapshot,
      parsedDecisionSnapshot: delivery.parsedDecisionSnapshot,
    });
  }
}

type InvokedRoleModelLoopRoundBase = {
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
};

type InvokedRoleModelLoopRound =
  | (InvokedRoleModelLoopRoundBase & {
      readonly status: 'rejected';
      readonly decisionResult: RejectedRoleModelDecisionResult;
    })
  | (InvokedRoleModelLoopRoundBase & {
      readonly status: 'accepted';
      readonly decisionResult: AcceptedRoleModelDecisionResult;
      readonly executableToolCalls: readonly ModelToolCall[];
      readonly nativeAssistantMessage?: RoleModelAssistantChatMessage;
      readonly nativeToolCallArgumentErrors: readonly RoleModelNativeToolCallArgumentError[];
      readonly toolNameMappings: readonly RoleModelProviderToolNameMapping[];
    });

async function invokeRoleModelLoopRound(options: {
  readonly options: RunRoleModelLoopOptions;
  readonly adapter: RoleModelAdapter;
  readonly identity: RuntimeEventIdentity;
  readonly sessionId: string;
  readonly round: number;
  readonly state: RoleModelLoopState;
}): Promise<InvokedRoleModelLoopRound> {
  const inputEnvelope = createRoleModelInputEnvelope({
    event: options.options.event,
    decisionContext: options.options.decisionContext,
    ...(options.options.allowedTools === undefined
      ? {}
      : {allowedTools: options.options.allowedTools}),
    pluginToolDefinitions: options.options.pluginToolDefinitions,
    toolObservations: options.state.toolObservations,
  });
  const turnContext = renderRoleModelTurnContext(inputEnvelope, {
    additionalMessages: options.state.nativeAdditionalMessages,
    ...(options.options.personaSections === undefined
      ? {}
      : {personaSections: options.options.personaSections}),
  });
  const rawOutput: unknown = await options.adapter.invoke(inputEnvelope, {
    turnContext,
  });
  const rawOutputValidation = validateRoleModelAdapterRawOutput(
    rawOutput,
    inputEnvelope.allowedTools,
    inputEnvelope.pluginToolDefinitions,
    inputEnvelope.toolObservations,
  );
  const ioSnapshot = createRoleModelIOSnapshot({
    ...options.identity,
    sessionId: options.sessionId,
    inputEnvelope,
    rawOutputText: rawOutputValidation.rawOutputText,
    ...(options.options.characterRef === undefined
      ? {}
      : {characterRef: options.options.characterRef}),
    ...providerMetadataOption(rawOutputValidation.providerMetadata),
    ...providerExchangeOption(rawOutputValidation.providerExchange),
  });
  const decisionResult =
    rawOutputValidation.status === 'accepted'
      ? parseRoleModelExecutionDecision(
          rawOutputValidation.rawOutputText,
          inputEnvelope.allowedTools,
          inputEnvelope.pluginToolDefinitions,
        )
      : rawOutputValidation.decisionResult;
  const parsedDecisionSnapshot = createParsedRoleModelDecisionSnapshot({
    ...options.identity,
    sessionId: options.sessionId,
    result: decisionResult,
  });

  if (decisionResult.status === 'rejected') {
    return {
      status: 'rejected',
      decisionResult,
      inputEnvelope,
      ioSnapshot,
      parsedDecisionSnapshot,
    };
  }

  const nativeToolCallArgumentErrors =
    rawOutputValidation.status === 'accepted'
      ? (rawOutputValidation.nativeToolCallArgumentErrors ?? [])
      : [];
  const toolNameMappings =
    rawOutputValidation.providerExchange?.toolNameMappings ?? [];
  const nativeAssistantMessage = nativeAssistantMessageForAcceptedDecision({
    assistantMessage:
      rawOutputValidation.status === 'accepted'
        ? rawOutputValidation.nativeAssistantMessage
        : undefined,
    decision: decisionResult.decision,
    allowedTools: inputEnvelope.allowedTools,
    pluginToolDefinitions: inputEnvelope.pluginToolDefinitions,
    toolObservations: options.state.toolObservations,
    toolNameMappings,
    nativeToolCallArgumentErrors,
  });

  return {
    status: 'accepted',
    decisionResult,
    inputEnvelope,
    ioSnapshot,
    parsedDecisionSnapshot,
    executableToolCalls: executableModelToolCalls(
      decisionResult.decision.toolCalls,
    ),
    ...(nativeAssistantMessage === undefined ? {} : {nativeAssistantMessage}),
    nativeToolCallArgumentErrors,
    toolNameMappings,
  };
}

async function routeRoleModelLoopToolCalls(options: {
  readonly options: RunRoleModelLoopOptions;
  readonly identity: RuntimeEventIdentity;
  readonly invokedRound: Extract<
    InvokedRoleModelLoopRound,
    {status: 'accepted'}
  >;
  readonly round: number;
  readonly toolObservations: readonly RoleModelToolObservation[];
}): Promise<PluginToolRoutingResult> {
  await deliverVisibleReply({
    options: options.options,
    round: options.round,
    decision: options.invokedRound.decisionResult.decision,
    inputEnvelope: options.invokedRound.inputEnvelope,
    ioSnapshot: options.invokedRound.ioSnapshot,
    parsedDecisionSnapshot: options.invokedRound.parsedDecisionSnapshot,
  });

  await options.options.onPluginToolCallsRequested?.({
    round: options.round,
    toolNames: options.invokedRound.executableToolCalls.map(call => call.name),
  });

  const pluginToolRouting = await routeExecutableToolCalls({
    toolCalls: options.invokedRound.executableToolCalls,
    identity: options.identity,
    inputEnvelope: options.invokedRound.inputEnvelope,
    ioSnapshot: options.invokedRound.ioSnapshot,
    parsedDecisionSnapshot: options.invokedRound.parsedDecisionSnapshot,
    round: options.round,
    priorToolObservations: options.toolObservations,
    ...(options.options.onPluginToolCallStarted === undefined
      ? {}
      : {onPluginToolCallStarted: options.options.onPluginToolCallStarted}),
    ...(options.options.onPluginToolCallCompleted === undefined
      ? {}
      : {onPluginToolCallCompleted: options.options.onPluginToolCallCompleted}),
    ...(options.options.pluginToolHost === undefined
      ? {}
      : {pluginToolHost: options.options.pluginToolHost}),
    ...(options.options.preparedConfigEffectsByToolCallId === undefined
      ? {}
      : {
          preparedConfigEffectsByToolCallId:
            options.options.preparedConfigEffectsByToolCallId,
        }),
    ...(options.options.runtimePluginContext === undefined
      ? {}
      : {runtimePluginContext: options.options.runtimePluginContext}),
    nativeToolCallArgumentErrors:
      options.invokedRound.nativeToolCallArgumentErrors,
  });

  return pluginToolRouting;
}

function recordRoleModelLoopToolRound(options: {
  readonly state: RoleModelLoopState;
  readonly invokedRound: Extract<
    InvokedRoleModelLoopRound,
    {status: 'accepted'}
  >;
  readonly pluginToolRouting: PluginToolRoutingResult;
  readonly round: number;
}): void {
  options.state.allPluginToolResults.push(...options.pluginToolRouting.results);
  options.state.rounds.push(
    createRoleModelLoopRound({
      pluginToolResults: options.pluginToolRouting.results,
      inputEnvelope: options.invokedRound.inputEnvelope,
      ioSnapshot: options.invokedRound.ioSnapshot,
      parsedDecisionSnapshot: options.invokedRound.parsedDecisionSnapshot,
      round: options.round,
    }),
  );
  options.state.nativeAdditionalMessages = appendNativeToolRoundMessages({
    assistantMessage: options.invokedRound.nativeAssistantMessage,
    previousMessages: options.state.nativeAdditionalMessages,
    results: options.pluginToolRouting.results,
    toolNameMappings: options.invokedRound.toolNameMappings,
  });
  options.state.toolRounds += 1;
  options.state.toolObservations = Object.freeze([
    ...options.state.toolObservations,
    ...options.pluginToolRouting.results.map(routing =>
      createToolObservationFromRouting({round: options.round, routing}),
    ),
  ]);
}

function normalizeMaxToolRounds(value: number | undefined): number {
  const maxToolRounds = value ?? defaultRoleModelMaxToolRounds;

  if (!Number.isSafeInteger(maxToolRounds) || maxToolRounds < 0) {
    throw new TypeError('maxToolRounds must be a non-negative safe integer.');
  }

  return maxToolRounds;
}

type PluginToolRoutingResult = {
  readonly status: 'accepted';
  readonly results: readonly RoleModelPluginToolRoutingEvidence[];
};

function executableModelToolCalls(
  toolCalls: readonly ModelToolCall[],
): readonly ModelToolCall[] {
  return Object.freeze(
    toolCalls.filter(toolCall => toolCall.name !== visibleReplyModelToolName),
  );
}

function nativeAssistantMessageForAcceptedDecision(options: {
  readonly assistantMessage: RoleModelAssistantChatMessage | undefined;
  readonly decision: CharacterDecision;
  readonly allowedTools: readonly RoleModelAllowedToolName[];
  readonly pluginToolDefinitions: readonly RoleModelPluginToolDefinition[];
  readonly toolObservations: readonly RoleModelToolObservation[];
  readonly toolNameMappings: readonly RoleModelProviderToolNameMapping[];
  readonly nativeToolCallArgumentErrors: readonly RoleModelNativeToolCallArgumentError[];
}): RoleModelAssistantChatMessage | undefined {
  const nativeToolCalls = options.assistantMessage?.tool_calls;

  if (options.assistantMessage === undefined || nativeToolCalls === undefined) {
    return undefined;
  }

  if (!nativeToolCallIdsAreValid(nativeToolCalls)) {
    return undefined;
  }

  const expectedExecutableToolCalls = executableModelToolCalls(
    options.decision.toolCalls,
  );
  const argumentErrorsByExecutableIndex =
    nativeToolCallArgumentErrorsByExecutableIndex(
      options.nativeToolCallArgumentErrors,
      expectedExecutableToolCalls,
    );

  if (argumentErrorsByExecutableIndex === undefined) {
    return undefined;
  }

  const normalizedNativeToolCalls = normalizeNativeAssistantToolCalls({
    nativeToolCalls,
    expectedExecutableToolCalls,
    argumentErrorsByExecutableIndex,
    toolNameMappings: options.toolNameMappings,
  });

  if (normalizedNativeToolCalls === undefined) {
    return undefined;
  }

  const nativeDecisionResult = parseRoleModelExecutionDecision(
    JSON.stringify({
      toolCalls: normalizedNativeToolCalls,
    }),
    options.allowedTools,
    options.pluginToolDefinitions,
  );

  if (
    nativeDecisionResult.status === 'rejected' ||
    !isDeepStrictEqual(
      nativeDecisionResult.decision.toolCalls,
      options.decision.toolCalls,
    )
  ) {
    return undefined;
  }

  return options.assistantMessage;
}

function nativeToolCallIdsAreValid(
  nativeToolCalls: readonly RoleModelChatToolCall[],
): boolean {
  const nativeToolCallIds = new Set<string>();

  for (const nativeToolCall of nativeToolCalls) {
    if (
      nativeToolCall.id.length === 0 ||
      nativeToolCallIds.has(nativeToolCall.id)
    ) {
      return false;
    }

    nativeToolCallIds.add(nativeToolCall.id);
  }

  return true;
}

function nativeToolCallArgumentErrorsByExecutableIndex(
  errors: readonly RoleModelNativeToolCallArgumentError[],
  expectedExecutableToolCalls: readonly ModelToolCall[],
): ReadonlyMap<number, RoleModelNativeToolCallArgumentError> | undefined {
  const errorsByIndex = new Map<number, RoleModelNativeToolCallArgumentError>();

  for (const error of errors) {
    const expectedToolCall = expectedExecutableToolCalls[error.executableIndex];

    if (
      expectedToolCall === undefined ||
      expectedToolCall.name !== error.toolName ||
      errorsByIndex.has(error.executableIndex)
    ) {
      return undefined;
    }

    errorsByIndex.set(error.executableIndex, error);
  }

  return errorsByIndex;
}

function normalizeNativeAssistantToolCalls(options: {
  readonly nativeToolCalls: readonly RoleModelChatToolCall[];
  readonly expectedExecutableToolCalls: readonly ModelToolCall[];
  readonly argumentErrorsByExecutableIndex: ReadonlyMap<
    number,
    RoleModelNativeToolCallArgumentError
  >;
  readonly toolNameMappings: readonly RoleModelProviderToolNameMapping[];
}): readonly Readonly<{name: string; input: unknown}>[] | undefined {
  const normalizedNativeToolCalls: Array<
    Readonly<{name: string; input: unknown}>
  > = [];
  let executableIndex = 0;

  for (const nativeToolCall of options.nativeToolCalls) {
    const runtimeToolName = runtimeToolNameForProviderToolName(
      nativeToolCall.function.name,
      options.toolNameMappings,
    );
    const expectedExecutableToolCall =
      runtimeToolName === visibleReplyModelToolName
        ? undefined
        : options.expectedExecutableToolCalls[executableIndex];

    if (
      runtimeToolName !== visibleReplyModelToolName &&
      (expectedExecutableToolCall === undefined ||
        expectedExecutableToolCall.name !== runtimeToolName)
    ) {
      return undefined;
    }

    const inputResult = nativeAssistantToolCallInput({
      nativeToolCall,
      expectedExecutableToolCall,
      argumentError:
        runtimeToolName === visibleReplyModelToolName
          ? undefined
          : options.argumentErrorsByExecutableIndex.get(executableIndex),
    });

    if (inputResult.status === 'rejected') {
      return undefined;
    }

    normalizedNativeToolCalls.push(
      Object.freeze({
        name: runtimeToolName,
        input: inputResult.input,
      }),
    );

    if (runtimeToolName !== visibleReplyModelToolName) {
      executableIndex += 1;
    }
  }

  return executableIndex === options.expectedExecutableToolCalls.length
    ? normalizedNativeToolCalls
    : undefined;
}

function nativeAssistantToolCallInput(options: {
  readonly nativeToolCall: RoleModelChatToolCall;
  readonly expectedExecutableToolCall: ModelToolCall | undefined;
  readonly argumentError: RoleModelNativeToolCallArgumentError | undefined;
}):
  | {readonly status: 'accepted'; readonly input: unknown}
  | {readonly status: 'rejected'} {
  if (options.argumentError !== undefined) {
    return {
      status: 'accepted',
      input: options.expectedExecutableToolCall?.input,
    };
  }

  try {
    return {
      status: 'accepted',
      input: JSON.parse(options.nativeToolCall.function.arguments) as unknown,
    };
  } catch {
    return {status: 'rejected'};
  }
}

function createToolObservationFromRouting(options: {
  readonly round: number;
  readonly routing: RoleModelPluginToolRoutingEvidence;
}): RoleModelToolObservation {
  const result =
    options.routing.result.status === 'accepted'
      ? ({
          status: 'accepted',
          output: options.routing.result.output,
        } as const)
      : ({
          status: 'rejected',
          reason: options.routing.result.reason,
          message: options.routing.result.message,
        } as const);

  return createRoleModelToolObservation({
    round: options.round,
    pluginId: options.routing.call.pluginId,
    toolName: options.routing.call.toolName,
    input: options.routing.call.input,
    result,
  });
}

function appendNativeToolRoundMessages(options: {
  readonly assistantMessage: RoleModelAssistantChatMessage | undefined;
  readonly previousMessages: readonly RoleModelChatMessage[];
  readonly results: readonly RoleModelPluginToolRoutingEvidence[];
  readonly toolNameMappings: readonly RoleModelProviderToolNameMapping[];
}): readonly RoleModelChatMessage[] {
  if (options.assistantMessage === undefined || options.results.length === 0) {
    return options.previousMessages;
  }

  return Object.freeze([
    ...options.previousMessages,
    freezeRoleModelChatMessage(options.assistantMessage),
    ...createNativeToolResultMessages({
      assistantMessage: options.assistantMessage,
      results: options.results,
      toolNameMappings: options.toolNameMappings,
    }),
  ]);
}

function createNativeToolResultMessages(options: {
  readonly assistantMessage: RoleModelAssistantChatMessage;
  readonly results: readonly RoleModelPluginToolRoutingEvidence[];
  readonly toolNameMappings: readonly RoleModelProviderToolNameMapping[];
}): readonly RoleModelToolChatMessage[] {
  let executableResultIndex = 0;
  const nativeToolCalls = options.assistantMessage.tool_calls ?? [];

  if (nativeToolCalls.length === 0) {
    return Object.freeze(
      options.results.map(result =>
        Object.freeze({
          role: 'tool',
          tool_call_id: result.callId,
          content: JSON.stringify(createNativeToolResultMessageContent(result)),
        } satisfies RoleModelToolChatMessage),
      ),
    );
  }

  return Object.freeze(
    nativeToolCalls.map(toolCall => {
      const runtimeToolName = runtimeToolNameForProviderToolName(
        toolCall.function.name,
        options.toolNameMappings,
      );

      if (runtimeToolName === visibleReplyModelToolName) {
        return Object.freeze({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(createNativeVisibleReplyToolResultContent()),
        } satisfies RoleModelToolChatMessage);
      }

      const result = options.results[executableResultIndex];

      executableResultIndex += 1;

      return Object.freeze({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(
          result === undefined
            ? createNativeMissingToolResultContent(runtimeToolName)
            : createNativeToolResultMessageContent(result),
        ),
      } satisfies RoleModelToolChatMessage);
    }),
  );
}

function createNativeToolResultMessageContent(
  result: RoleModelPluginToolRoutingEvidence,
): Readonly<Record<string, RuntimePluginJsonValue>> {
  if (result.result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      pluginId: result.call.pluginId,
      toolName: result.call.toolName,
      output: result.result.output,
    });
  }

  return Object.freeze({
    status: 'rejected',
    pluginId: result.call.pluginId,
    toolName: result.call.toolName,
    reason: result.result.reason,
    message: result.result.message,
  });
}

function createNativeVisibleReplyToolResultContent(): Readonly<
  Record<string, RuntimePluginJsonValue>
> {
  return Object.freeze({
    status: 'accepted',
    toolName: visibleReplyModelToolName,
    output: Object.freeze({
      kind: 'visible_reply_delivered',
    }),
  });
}

function createNativeMissingToolResultContent(
  toolName: string,
): Readonly<Record<string, RuntimePluginJsonValue>> {
  return Object.freeze({
    status: 'rejected',
    toolName,
    reason: 'tool_result_missing',
    message: `No routed plugin result was available for native tool call "${toolName}".`,
  });
}

async function routeExecutableToolCalls(options: {
  readonly toolCalls: readonly ModelToolCall[];
  readonly identity: RuntimeEventIdentity;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly round: number;
  readonly pluginToolHost?: RoleModelPluginToolHost;
  readonly preparedConfigEffectsByToolCallId?: Map<
    string,
    PreparedRuntimePluginConfigEffect
  >;
  readonly onPluginToolCallStarted?: (
    event: RoleModelPluginToolCallStartedEvent,
  ) => Promise<void> | void;
  readonly onPluginToolCallCompleted?: (
    event: RoleModelPluginToolCallCompletedEvent,
  ) => Promise<void> | void;
  readonly runtimePluginContext?: RuntimePluginContext;
  readonly nativeToolCallArgumentErrors?: readonly RoleModelNativeToolCallArgumentError[];
  readonly priorToolObservations: readonly RoleModelToolObservation[];
}): Promise<PluginToolRoutingResult> {
  // Admission runs in call order because it appends the tool_call_started
  // record for each call, and those must land in the order the model asked
  // so the terminal event's toolCallIds match. Execution then runs
  // concurrently under the batch lock, with results reassembled by slot.
  const results: (RoleModelPluginToolRoutingEvidence | undefined)[] = [];
  const admitted: {
    readonly slot: number;
    readonly toolName: string;
    readonly mode: ToolBatchLockMode;
    readonly run: () => Promise<RoleModelPluginToolRoutingEvidence>;
  }[] = [];

  const report = createSettledToolCallReporter({
    round: options.round,
    ...(options.onPluginToolCallCompleted === undefined
      ? {}
      : {onPluginToolCallCompleted: options.onPluginToolCallCompleted}),
  });

  for (const [index, toolCall] of options.toolCalls.entries()) {
    const slot = results.push(undefined) - 1;
    const toolAllowed = options.inputEnvelope.allowedTools.some(
      allowed => allowed === toolCall.name,
    );
    const toolDefinition = toolAllowed
      ? findPluginToolDefinition(
          options.inputEnvelope.pluginToolDefinitions,
          toolCall.name,
        )
      : undefined;
    const pluginId = toolDefinition?.pluginId;

    const callId = createToolCallId({
      eventId: options.identity.eventId,
      traceId: options.identity.traceId,
      index,
      round: options.round,
      toolName: toolCall.name,
    });
    const {routedCall, executionCall} = createRuntimePluginToolCallViews({
      callId,
      identity: options.identity,
      pluginId: pluginId ?? undeclaredToolPluginId(toolCall.name),
      toolCall,
    });

    await options.onPluginToolCallStarted?.({
      callId,
      round: options.round,
      call: routedCall,
      ioSnapshot: options.ioSnapshot,
      parsedDecisionSnapshot: options.parsedDecisionSnapshot,
    });

    const nativeArgumentRejection = nativeToolCallArgumentRejection({
      callId,
      call: routedCall,
      executableIndex: index,
      toolName: toolCall.name,
      errors: options.nativeToolCallArgumentErrors,
      context: options.runtimePluginContext,
    });

    if (nativeArgumentRejection !== undefined) {
      results[slot] = await report(nativeArgumentRejection);
      continue;
    }

    if (
      pluginId === undefined ||
      options.pluginToolHost === undefined ||
      options.runtimePluginContext === undefined
    ) {
      results[slot] = await report(
        missingRoutingTargetRejection({
          callId,
          call: routedCall,
          toolName: toolCall.name,
          pluginDeclared: pluginId !== undefined,
          context: options.runtimePluginContext,
        }),
      );
      continue;
    }

    const executionMode: ToolBatchLockMode =
      toolDefinition?.concurrency === 'shared' ? 'shared' : 'exclusive';
    const pluginToolHost = options.pluginToolHost;
    const runtimePluginContext = options.runtimePluginContext;

    admitted.push({
      slot,
      toolName: toolCall.name,
      mode: executionMode,
      async run() {
        let hostResult: RuntimePluginToolCallExecutionResult;

        try {
          hostResult = await pluginToolHost.handleToolCall(
            executionCall,
            runtimePluginContext,
          );
        } catch (error: unknown) {
          return createRejectedToolRoutingEvidence({
            callId,
            call: routedCall,
            dispatchedToHost: true,
            context: runtimePluginContext,
            reason: 'handler_failed',
            message:
              error instanceof Error
                ? error.message
                : `Tool "${toolCall.name}" handler failed.`,
            evidenceStatus: 'failed',
            policyOutcome: 'handler_rejected',
          });
        }

        try {
          const routableHostResult = normalizeRoutablePluginToolResult({
            result: freezeRuntimePluginToolCallResult(hostResult, {
              call: executionCall,
            }),
            toolName: toolCall.name,
          });

          capturePreparedConfigEffect({
            call: executionCall,
            result: hostResult,
            routableResult: routableHostResult,
            effectsByToolCallId: options.preparedConfigEffectsByToolCallId,
          });

          return Object.freeze({
            callId,
            call: routedCall,
            dispatchedToHost: true,
            result: routableHostResult,
          } satisfies RoleModelPluginToolRoutingEvidence);
        } catch (error: unknown) {
          return createRejectedToolRoutingEvidence({
            callId,
            call: routedCall,
            dispatchedToHost: true,
            context: runtimePluginContext,
            reason: 'invalid_tool_output',
            message:
              error instanceof Error
                ? error.message
                : `Tool "${toolCall.name}" returned invalid output.`,
            evidenceStatus: 'failed',
            policyOutcome: 'handler_rejected',
          });
        }
      },
    });
  }

  // One failing call never cancels its siblings: the model receives the
  // complete result set and decides what to do next.
  const lock = createToolBatchLock();

  // Settled, not all: a failing report must not leave siblings running
  // past the turn that owns them, so every call finishes before the
  // first failure propagates.
  const settled = await Promise.allSettled(
    admitted.map(async entry => {
      results[entry.slot] = await report(await lock.run(entry.mode, entry.run));
    }),
  );
  // Every cause, not the first: concurrent calls fail for independent
  // reasons, and a turn that lost two records must not report one.
  const failures = settled.flatMap((outcome): unknown[] =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );

  if (failures.length === 1) {
    throw failures[0];
  }

  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `${String(failures.length)} tool calls in one batch failed.`,
    );
  }

  return createAcceptedPluginToolRoutingResult(
    results.filter(result => result !== undefined),
  );
}

/**
 * The provider rejected this call's arguments before it could run, so it
 * is answered from the error rather than dispatched.
 */
function nativeToolCallArgumentRejection(options: {
  readonly callId: string;
  readonly call: RuntimePluginToolCall;
  readonly executableIndex: number;
  readonly toolName: string;
  readonly errors: readonly RoleModelNativeToolCallArgumentError[] | undefined;
  readonly context: RuntimePluginContext | undefined;
}): RoleModelPluginToolRoutingEvidence | undefined {
  const argumentError = options.errors?.find(
    candidate =>
      candidate.executableIndex === options.executableIndex &&
      candidate.toolName === options.toolName,
  );

  if (argumentError === undefined) {
    return undefined;
  }

  return createRejectedToolRoutingEvidence({
    callId: options.callId,
    call: options.call,
    dispatchedToHost: false,
    ...(options.context === undefined ? {} : {context: options.context}),
    reason: argumentError.reason,
    message: argumentError.message,
    evidenceStatus: 'rejected',
    policyOutcome: 'handler_rejected',
  });
}

/**
 * Reports a call as soon as it settles rather than when the batch does:
 * a tool's write is durable when its call returns, so a crash in that
 * window would leave a started call and no record of the effect.
 */
function createSettledToolCallReporter(options: {
  readonly round: number;
  readonly onPluginToolCallCompleted?: (
    event: RoleModelPluginToolCallCompletedEvent,
  ) => Promise<void> | void;
}): (
  result: RoleModelPluginToolRoutingEvidence,
) => Promise<RoleModelPluginToolRoutingEvidence> {
  return async result => {
    await options.onPluginToolCallCompleted?.({
      round: options.round,
      callId: result.callId,
      dispatchedToHost: result.dispatchedToHost,
      pluginId: result.call.pluginId,
      toolName: result.call.toolName,
      status: result.result.status,
      result: result.result,
    });

    return result;
  };
}

function capturePreparedConfigEffect(options: {
  readonly call: RuntimePluginToolCall;
  readonly result: RuntimePluginToolCallExecutionResult;
  readonly routableResult: RuntimePluginToolCallResult;
  readonly effectsByToolCallId:
    Map<string, PreparedRuntimePluginConfigEffect> | undefined;
}): void {
  if (
    options.result.status !== 'accepted' ||
    options.result.preparedConfigEffect === undefined ||
    options.routableResult.status !== 'accepted' ||
    options.effectsByToolCallId === undefined
  ) {
    return;
  }

  const effect = createPreparedRuntimePluginConfigEffect(
    options.result.preparedConfigEffect,
  );
  const toolCallId = options.call.toolCallId;

  if (toolCallId === undefined || effect.effectId !== toolCallId) {
    throw new TypeError(
      'Prepared runtime config effect must match its routed tool call id.',
    );
  }

  if (options.effectsByToolCallId.has(toolCallId)) {
    throw new TypeError(
      'Prepared runtime config effect tool call id must be unique.',
    );
  }

  options.effectsByToolCallId.set(toolCallId, effect);
}

function createAcceptedPluginToolRoutingResult(
  results: readonly RoleModelPluginToolRoutingEvidence[],
): PluginToolRoutingResult {
  return Object.freeze({
    status: 'accepted',
    results: Object.freeze([...results]),
  } satisfies PluginToolRoutingResult);
}

function normalizeRoutablePluginToolResult(options: {
  readonly result: RuntimePluginToolCallResult;
  readonly toolName: string;
}): RuntimePluginToolCallResult {
  if (
    options.result.status === 'accepted' &&
    runtimePluginToolResultHasBlockingEvidence(options.result)
  ) {
    return Object.freeze({
      status: 'rejected',
      reason: 'blocking_tool_invocation_evidence',
      message: `Tool "${options.toolName}" returned accepted output with blocking tool invocation evidence.`,
      evidence: options.result.evidence,
    } satisfies RuntimePluginToolCallResult);
  }

  return options.result;
}

function findPluginToolDefinition(
  definitions: readonly RoleModelPluginToolDefinition[],
  toolName: string,
): RoleModelPluginToolDefinition | undefined {
  return definitions.find(definition => definition.name === toolName);
}

/**
 * One proposed tool call, two views. The routed view is what hooks,
 * rejections, and evidence carry, so credential-shaped input values are
 * redacted before anything records or displays them. The execution view
 * is what the plugin runs on and keeps the real values — redacting it
 * would execute the tool against "[redacted]" placeholders. Both are
 * built from one identity here so the views cannot drift apart.
 */
function createRuntimePluginToolCallViews(options: {
  readonly callId: string;
  readonly identity: RuntimeEventIdentity;
  readonly pluginId: string;
  readonly toolCall: ModelToolCall;
}): {
  readonly routedCall: RuntimePluginToolCall;
  readonly executionCall: RuntimePluginToolCall;
} {
  const sharedIdentity = {
    toolCallId: options.callId,
    eventId: options.identity.eventId,
    traceId: options.identity.traceId,
    createdAt: options.identity.createdAt,
    pluginId: options.pluginId,
    toolName: options.toolCall.name,
  };

  return Object.freeze({
    routedCall: Object.freeze({
      ...sharedIdentity,
      input: createJsonBoundaryObjectSnapshot(options.toolCall.input, {
        field: 'Plugin tool input',
        redact: true,
      }),
    } satisfies RuntimePluginToolCall),
    executionCall: Object.freeze({
      ...sharedIdentity,
      input: createJsonBoundaryObjectSnapshot(options.toolCall.input, {
        field: 'Plugin tool execution input',
      }),
    } satisfies RuntimePluginToolCall),
  });
}

function undeclaredToolPluginId(toolName: string): string {
  return `undeclared.${toolName}`;
}

function createToolCallId(options: {
  readonly eventId: string;
  readonly index: number;
  readonly round: number;
  readonly traceId: string;
  readonly toolName: string;
}): string {
  return `${options.eventId}.${options.traceId}.round-${String(options.round)}.${String(options.index + 1)}.${options.toolName}`;
}

function freezeRuntimePluginToolCallResult(
  result: RuntimePluginToolCallResult,
  options: {readonly call: RuntimePluginToolCall},
): RuntimePluginToolCallResult {
  let boundedResult: RuntimePluginToolCallResult;

  try {
    boundedResult = createRuntimePluginToolCallResultSnapshot(result);
  } catch (error: unknown) {
    if (error instanceof TypeError && error.message.includes('finite JSON')) {
      throw new TypeError('Plugin tool output must be finite JSON.', {
        cause: error,
      });
    }

    if (
      error instanceof TypeError &&
      error.message.includes('JSON serializable')
    ) {
      throw new TypeError('Plugin tool output must be JSON serializable.', {
        cause: error,
      });
    }

    throw error;
  }

  assertRoutedPluginEvidenceIdentity(boundedResult.evidence, options.call);
  return boundedResult;
}

function assertRoutedPluginEvidenceIdentity(
  evidence: readonly RuntimePluginToolCallResult['evidence'][number][],
  call: RuntimePluginToolCall,
): void {
  for (const snapshot of evidence) {
    if (
      snapshot.eventId !== call.eventId ||
      snapshot.traceId !== call.traceId ||
      snapshot.createdAt !== call.createdAt ||
      snapshot.pluginId !== call.pluginId
    ) {
      throw new TypeError(
        'Plugin tool evidence identity must match the routed call.',
      );
    }
  }
}

function createSnapshotIdentity(
  event: UserMessageRuntimeEvent,
): RuntimeEventIdentity {
  return Object.freeze({
    eventId: event.eventId,
    traceId: event.traceId,
    createdAt: event.createdAt,
  } satisfies RuntimeEventIdentity);
}
