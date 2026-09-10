import {type RuntimeEventIdentity} from '../../core/index.ts';
import {type RoleModelPluginToolDefinition} from '../api/contracts.ts';
import {type ModelToolCall} from '../api/model-tools.ts';
import {
  createRuntimePluginToolCallResultSnapshot,
  runtimePluginToolResultHasBlockingEvidence,
  type RuntimePluginContext,
  type RuntimePluginToolCall,
  type RuntimePluginToolCallResult,
} from '../../plugins/api/index.ts';
import {createJsonBoundaryObjectSnapshot} from '../../shared/json-boundary.ts';
import {
  createRejectedToolRoutingEvidence,
  undeclaredToolRejection,
  type RoleModelPluginToolRoutingEvidence,
} from './routing-rejections.ts';
import {
  createToolBatchLock,
  type ToolBatchLockMode,
} from './tool-batch-lock.ts';

export type RoleModelPluginToolHost = {
  readonly handleToolCall: (
    call: RuntimePluginToolCall,
    context: RuntimePluginContext,
  ) => RuntimePluginToolCallResult | Promise<RuntimePluginToolCallResult>;
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

export async function routeExecutableToolCalls(options: {
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
