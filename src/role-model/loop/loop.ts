import {createDeterministicLocalRoleModelAdapter} from '../providers/local.ts';
import {
  type RuntimeEventIdentity,
  type UserMessageRuntimeEvent,
  type VisibleMessage,
} from '../../core/index.ts';
import {
  type CharacterDecision,
  type ConversationToolCall,
  type DecisionContext,
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelPluginToolDefinition,
  type RoleModelCharacterRef,
  type RoleModelDecisionRejection,
  type RoleModelIOSnapshot,
} from '../api/contracts.ts';
import {
  assertRoleModelCharacterRefMatchesCharacter,
  createParsedRoleModelDecisionSnapshot,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
} from '../api/decision.ts';
import {
  executableModelToolCalls,
  parseRoleModelExecutionDecision,
} from './decision-parser.ts';
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
  undeclaredToolRejection,
  type RoleModelPluginToolRoutingEvidence,
} from './routing-rejections.ts';
import type {RoleModelAdapter} from '../api/adapter.ts';
import {type ModelToolCall} from '../api/model-tools.ts';
import {measureRoleModelPromptSize} from '../prompt/prompt-size.ts';
import {renderRoleModelTurnContext} from '../prompt/render.ts';
import {
  assertConversationHistoryMatchesWindow,
  createConversationToolRound,
  type ConversationTurn,
} from '../api/conversation-history.ts';
import {
  createRuntimePluginToolCallResultSnapshot,
  type RuntimePluginToolCall,
  type RuntimePluginToolCallResult,
  type RuntimePluginContext,
} from '../../plugins/api/index.ts';
import {runtimePluginToolResultHasBlockingEvidence} from '../../plugins/api/index.ts';
import {createJsonBoundaryObjectSnapshot} from '../../shared/json-boundary.ts';

export type RunRoleModelLoopOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly adapter?: RoleModelAdapter;
  readonly pluginToolDefinitions: readonly RoleModelPluginToolDefinition[];
  readonly pluginToolHost: RoleModelPluginToolHost;
  readonly maxToolRounds?: number;
  /**
   * Fires once per model round, accepted or refused, as soon as the output
   * is parsed and before anything is delivered or dispatched: the round is
   * on record before its consequences are.
   */
  readonly onRound: (event: RoleModelRoundEvent) => Promise<void> | void;
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
   * Fires for interim and terminal replies alike; required because an
   * undelivered reply is user-facing text lost. A rejected round delivers
   * nothing. Returns the message as committed: a tool round replays to the
   * model what the person was told.
   */
  readonly onVisibleReply: (
    event: RoleModelVisibleReplyEvent,
  ) => Promise<VisibleMessage> | VisibleMessage;
  readonly runtimePluginContext: RuntimePluginContext;
  readonly personaSections?: readonly string[];
  /** The person's name, when configured; the prompt then addresses them by it. */
  readonly userDisplayName?: string;
  /** The prior turns to replay; must be the turns the decision context names. */
  readonly conversationHistory?: readonly ConversationTurn[];
  readonly characterRef?: RoleModelCharacterRef;
};

export type RoleModelPluginToolHost = {
  readonly handleToolCall: (
    call: RuntimePluginToolCall,
    context: RuntimePluginContext,
  ) => RuntimePluginToolCallResult | Promise<RuntimePluginToolCallResult>;
};

export {type RoleModelPluginToolRoutingEvidence} from './routing-rejections.ts';

export type RoleModelRoundEvent = {
  readonly round: number;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
};

export type RoleModelVisibleReplyEvent = {
  readonly round: number;
  readonly text: string;
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
  readonly dispatchedToHost: boolean;
  readonly pluginId: string;
  readonly round: number;
  readonly status: RuntimePluginToolCallResult['status'];
  readonly toolName: string;
  readonly result: RuntimePluginToolCallResult;
};

export {
  executionVisibleReplyTexts,
  settleRejectedRound,
  terminalRoleModelLoopResult,
  type AcceptedRoleModelLoopResult,
  type RejectedRoleModelLoopResult,
  type RoleModelLoopResult,
  type RoleModelLoopState,
} from './round-outcome.ts';
import {
  executionVisibleReplyTexts,
  settleRejectedRound,
  terminalRoleModelLoopResult,
  type RoleModelLoopResult,
  type RoleModelLoopState,
} from './round-outcome.ts';

export const defaultRoleModelMaxToolRounds = 99;

export async function runRoleModelLoop(
  options: RunRoleModelLoopOptions,
): Promise<RoleModelLoopResult> {
  // Checked again by the snapshot constructor; this keeps a bad ref off the wire.
  if (options.characterRef !== undefined) {
    assertRoleModelCharacterRefMatchesCharacter(
      options.characterRef,
      options.decisionContext.characterSnapshot,
    );
  }

  const conversationHistory = options.conversationHistory ?? [];
  assertConversationHistoryMatchesWindow(
    conversationHistory,
    options.decisionContext.historyWindow,
  );

  const adapter = options.adapter ?? createDeterministicLocalRoleModelAdapter();
  const maxToolRounds = normalizeMaxToolRounds(options.maxToolRounds);
  const identity = createSnapshotIdentity(options.event);
  const sessionId = options.decisionContext.sessionId;
  const state: RoleModelLoopState = {
    allPluginToolResults: [],
    spentRounds: 0,
    toolRounds: Object.freeze([]),
    unusableReplyNote: undefined,
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
      const settled = settleRejectedRound({
        state,
        rejection: invokedRound.rejection,
        modelOutput: invokedRound.modelOutput,
        round,
        maxToolRounds,
      });

      if (settled === 'continue') {
        continue;
      }

      return settled;
    }

    const terminalResult = terminalRoleModelLoopResult({
      state,
      decision: invokedRound.decision,
      executableToolCalls: invokedRound.executableToolCalls,
      round,
      maxToolRounds,
    });

    if (terminalResult !== undefined) {
      if (terminalResult.status === 'accepted') {
        await deliverVisibleReply({
          options,
          round,
          decision: invokedRound.decision,
        });
      }

      return terminalResult;
    }

    const routed = await routeRoleModelLoopToolCalls({
      options,
      identity,
      invokedRound,
      round,
    });

    recordRoleModelLoopToolRound({
      state,
      invokedRound,
      ...routed,
      round,
    });
  }
}

async function deliverVisibleReply(delivery: {
  readonly options: RunRoleModelLoopOptions;
  readonly round: number;
  readonly decision: CharacterDecision;
}): Promise<readonly VisibleMessage[]> {
  const committed: VisibleMessage[] = [];

  for (const text of executionVisibleReplyTexts(delivery.decision)) {
    committed.push(
      await delivery.options.onVisibleReply({round: delivery.round, text}),
    );
  }

  return Object.freeze(committed);
}

type InvokedRoleModelLoopRound =
  | {
      readonly status: 'rejected';
      readonly rejection: RoleModelDecisionRejection;
      /** Whether the model wrote anything: nothing can go back when no output arrived. */
      readonly modelOutput: boolean;
    }
  | {
      readonly status: 'accepted';
      readonly decision: CharacterDecision;
      readonly executableToolCalls: readonly ModelToolCall[];
      readonly pluginToolDefinitions: readonly RoleModelPluginToolDefinition[];
    };

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
    pluginToolDefinitions: options.options.pluginToolDefinitions,
    toolRounds: options.state.toolRounds,
  });
  const conversationHistory = options.options.conversationHistory ?? [];
  // The note about an unusable reply rides exactly one round: the one the
  // model gets to respond to it in.
  const unusableReplyNote = options.state.unusableReplyNote;

  options.state.unusableReplyNote = undefined;
  const turnContext = renderRoleModelTurnContext(inputEnvelope, {
    ...(unusableReplyNote === undefined ? {} : {unusableReplyNote}),
    conversationHistory,
    ...(options.options.personaSections === undefined
      ? {}
      : {personaSections: options.options.personaSections}),
    ...(options.options.userDisplayName === undefined
      ? {}
      : {userDisplayName: options.options.userDisplayName}),
  });
  const rawOutput: unknown = await options.adapter.invoke(inputEnvelope, {
    turnContext,
    conversationHistory,
  });
  const rawOutputValidation = validateRoleModelAdapterRawOutput(rawOutput);
  const ioSnapshot = createRoleModelIOSnapshot({
    ...options.identity,
    sessionId: options.sessionId,
    inputEnvelope,
    rawOutputText: rawOutputValidation.rawOutputText,
    ...(options.options.characterRef === undefined
      ? {}
      : {characterRef: options.options.characterRef}),
    promptSize: measureRoleModelPromptSize(turnContext),
    ...providerMetadataOption(rawOutputValidation.providerMetadata),
    ...providerExchangeOption(rawOutputValidation.providerExchange),
  });
  const decisionResult =
    rawOutputValidation.status === 'accepted'
      ? parseRoleModelExecutionDecision(rawOutputValidation.rawOutputText)
      : rawOutputValidation.decisionResult;
  const parsedDecisionSnapshot = createParsedRoleModelDecisionSnapshot({
    ...options.identity,
    sessionId: options.sessionId,
    result: decisionResult,
  });

  await options.options.onRound({
    round: options.round,
    ioSnapshot,
    parsedDecisionSnapshot,
  });

  if (decisionResult.status === 'rejected') {
    return {
      status: 'rejected',
      rejection: decisionResult.rejection,
      modelOutput: rawOutputValidation.rawOutputText.length > 0,
    };
  }

  return {
    status: 'accepted',
    decision: decisionResult.decision,
    executableToolCalls: executableModelToolCalls(
      decisionResult.decision.toolCalls,
    ),
    pluginToolDefinitions: inputEnvelope.pluginToolDefinitions,
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
}): Promise<{
  readonly interimReplies: readonly VisibleMessage[];
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
}> {
  const interimReplies = await deliverVisibleReply({
    options: options.options,
    round: options.round,
    decision: options.invokedRound.decision,
  });

  await options.options.onPluginToolCallsRequested?.({
    round: options.round,
    toolNames: options.invokedRound.executableToolCalls.map(call => call.name),
  });

  const pluginToolResults = await routeExecutableToolCalls({
    toolCalls: options.invokedRound.executableToolCalls,
    identity: options.identity,
    pluginToolDefinitions: options.invokedRound.pluginToolDefinitions,
    round: options.round,
    ...(options.options.onPluginToolCallStarted === undefined
      ? {}
      : {onPluginToolCallStarted: options.options.onPluginToolCallStarted}),
    ...(options.options.onPluginToolCallCompleted === undefined
      ? {}
      : {onPluginToolCallCompleted: options.options.onPluginToolCallCompleted}),
    pluginToolHost: options.options.pluginToolHost,
    runtimePluginContext: options.options.runtimePluginContext,
  });

  return {interimReplies, pluginToolResults};
}

function recordRoleModelLoopToolRound(options: {
  readonly state: RoleModelLoopState;
  readonly invokedRound: Extract<
    InvokedRoleModelLoopRound,
    {status: 'accepted'}
  >;
  readonly interimReplies: readonly VisibleMessage[];
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
  readonly round: number;
}): void {
  const {decision} = options.invokedRound;

  options.state.allPluginToolResults.push(...options.pluginToolResults);
  options.state.spentRounds += 1;
  options.state.toolRounds = Object.freeze([
    ...options.state.toolRounds,
    createConversationToolRound({
      round: options.round,
      ...(decision.text === undefined ? {} : {text: decision.text}),
      interimReplies: options.interimReplies,
      toolCalls: options.pluginToolResults.map(conversationToolCallFromRouting),
    }),
  ]);
}

function normalizeMaxToolRounds(value: number | undefined): number {
  const maxToolRounds = value ?? defaultRoleModelMaxToolRounds;

  if (!Number.isSafeInteger(maxToolRounds) || maxToolRounds < 0) {
    throw new TypeError('maxToolRounds must be a non-negative safe integer.');
  }

  return maxToolRounds;
}

function conversationToolCallFromRouting(
  routing: RoleModelPluginToolRoutingEvidence,
): ConversationToolCall {
  return {
    toolCallId: routing.callId,
    pluginId: routing.call.pluginId,
    toolName: routing.call.toolName,
    input: routing.call.input,
    result:
      routing.result.status === 'accepted'
        ? {status: 'accepted', output: routing.result.output}
        : {
            status: 'rejected',
            reason: routing.result.reason,
            message: routing.result.message,
          },
  };
}

async function routeExecutableToolCalls(options: {
  readonly toolCalls: readonly ModelToolCall[];
  readonly identity: RuntimeEventIdentity;
  readonly pluginToolDefinitions: readonly RoleModelPluginToolDefinition[];
  readonly round: number;
  readonly pluginToolHost: RoleModelPluginToolHost;
  readonly onPluginToolCallStarted?: (
    event: RoleModelPluginToolCallStartedEvent,
  ) => Promise<void> | void;
  readonly onPluginToolCallCompleted?: (
    event: RoleModelPluginToolCallCompletedEvent,
  ) => Promise<void> | void;
  readonly runtimePluginContext: RuntimePluginContext;
}): Promise<readonly RoleModelPluginToolRoutingEvidence[]> {
  // Admission runs in call order: tool_call_started records must land in
  // the order the model asked so the terminal event's toolCallIds match.
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
    const toolDefinition = findPluginToolDefinition(
      options.pluginToolDefinitions,
      toolCall.name,
    );
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
      pluginId:
        toolDefinition?.pluginId ?? undeclaredToolPluginId(toolCall.name),
      toolCall,
    });

    await options.onPluginToolCallStarted?.({
      callId,
      round: options.round,
      call: routedCall,
    });

    if (toolDefinition === undefined) {
      results[slot] = await report(
        undeclaredToolRejection({
          callId,
          call: routedCall,
          toolName: toolCall.name,
          context: options.runtimePluginContext,
        }),
      );
      continue;
    }

    const executionMode: ToolBatchLockMode =
      toolDefinition.concurrency === 'shared' ? 'shared' : 'exclusive';
    const {pluginToolHost, runtimePluginContext} = options;

    admitted.push({
      slot,
      toolName: toolCall.name,
      mode: executionMode,
      async run() {
        let hostResult: RuntimePluginToolCallResult;

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

  const lock = createToolBatchLock();

  // Settled, not all: no call outruns the turn, and no failure cancels a sibling.
  const settled = await Promise.allSettled(
    admitted.map(async entry => {
      results[entry.slot] = await report(await lock.run(entry.mode, entry.run));
    }),
  );
  // Every cause, not the first: concurrent calls fail independently.
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

  return Object.freeze(results.filter(result => result !== undefined));
}

// Reported when the call settles, not the batch: its write is already durable.
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

// The routed view is redacted because hooks, rejections, and evidence carry
// it; the execution view keeps real values or the tool runs on placeholders.
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
