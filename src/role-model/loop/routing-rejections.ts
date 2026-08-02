import {
  createRuntimePluginEvidenceSnapshot,
  redactRuntimePluginText,
  type RuntimePluginContext,
  type RuntimePluginEvidenceStatus,
  type RuntimePluginPolicyOutcome,
  type RuntimePluginToolCall,
  type RuntimePluginToolCallResult,
} from '../../plugins/api/index.ts';
import {
  type RoleModelPluginToolDefinition,
  type RoleModelToolObservation,
} from '../api/contracts.ts';
import {type ModelToolCall} from '../api/model-tools.ts';

export type RoleModelPluginToolRoutingEvidence = {
  readonly callId: string;
  readonly call: RuntimePluginToolCall;
  readonly dispatchedToHost: boolean;
  readonly result: RuntimePluginToolCallResult;
};

export function createRejectedToolRoutingEvidence(options: {
  readonly callId: string;
  readonly call: RuntimePluginToolCall;
  readonly dispatchedToHost: boolean;
  readonly context?: RuntimePluginContext;
  readonly reason: string;
  readonly message: string;
  readonly evidenceStatus?: RuntimePluginEvidenceStatus;
  readonly policyOutcome?: RuntimePluginPolicyOutcome;
}): RoleModelPluginToolRoutingEvidence {
  const reason = redactRuntimePluginText(options.reason);
  const message = redactRuntimePluginText(options.message);

  return Object.freeze({
    callId: options.callId,
    call: options.call,
    dispatchedToHost: options.dispatchedToHost,
    result: Object.freeze({
      status: 'rejected',
      reason,
      message,
      evidence:
        options.context === undefined
          ? Object.freeze([])
          : Object.freeze([
              createRuntimePluginEvidenceSnapshot({
                eventId: options.context.eventId,
                traceId: options.context.traceId,
                createdAt: options.context.timestamp,
                kind: 'runtime_plugin_evidence_snapshot',
                pluginId: options.call.pluginId,
                evidenceKind: 'tool_invocation',
                status: options.evidenceStatus ?? 'rejected',
                summary: message,
                policyOutcome: options.policyOutcome ?? 'handler_rejected',
                redactionLabels: options.context.privacy.redactionLabels,
              }),
            ]),
    } satisfies RuntimePluginToolCallResult),
  } satisfies RoleModelPluginToolRoutingEvidence);
}

export function missingRoutingTargetRejection(options: {
  readonly callId: string;
  readonly call: RuntimePluginToolCall;
  readonly toolName: string;
  readonly pluginDeclared: boolean;
  readonly context: RuntimePluginContext | undefined;
}): RoleModelPluginToolRoutingEvidence {
  return createRejectedToolRoutingEvidence({
    callId: options.callId,
    call: options.call,
    dispatchedToHost: false,
    ...(options.context === undefined ? {} : {context: options.context}),
    reason: options.pluginDeclared ? 'tool_host_missing' : 'tool_not_declared',
    message: options.pluginDeclared
      ? `Tool "${options.toolName}" has no host handler for this turn.`
      : `Tool "${options.toolName}" is not declared for this turn.`,
    policyOutcome: options.pluginDeclared
      ? 'handler_rejected'
      : 'disallowed_tool_call',
  });
}

/**
 * Converts a user_turn call-budget violation into a rejected routing result
 * instead of failing the decision: the model sees the rejection as a tool
 * observation on the next round and can still finish the turn. Attempts
 * count regardless of outcome, so rejected calls consume budget too.
 */
export function userTurnCallLimitRoutingRejection(options: {
  readonly callId: string;
  readonly call: RuntimePluginToolCall;
  readonly toolCall: ModelToolCall;
  readonly toolDefinition: RoleModelPluginToolDefinition | undefined;
  readonly priorToolObservations: readonly RoleModelToolObservation[];
  /**
   * Tool names already attempted in this batch. A limit bounds attempts,
   * so a call still executing counts the same as a finished one.
   */
  readonly batchToolNames: readonly string[];
  readonly context: RuntimePluginContext | undefined;
}): RoleModelPluginToolRoutingEvidence | undefined {
  const callLimit = options.toolDefinition?.callLimit;

  if (callLimit === undefined || callLimit.scope !== 'user_turn') {
    return undefined;
  }

  const attemptCount =
    options.priorToolObservations.filter(
      observation => observation.toolName === options.toolCall.name,
    ).length +
    options.batchToolNames.filter(name => name === options.toolCall.name)
      .length;

  if (attemptCount < callLimit.maxCalls) {
    return undefined;
  }

  return createRejectedToolRoutingEvidence({
    callId: options.callId,
    call: options.call,
    dispatchedToHost: false,
    ...(options.context === undefined ? {} : {context: options.context}),
    reason: 'tool_call_limit_reached',
    message: `Tool "${options.toolCall.name}" was already attempted ${String(
      attemptCount,
    )} ${
      attemptCount === 1 ? 'time' : 'times'
    } this turn; user_turn maxCalls is ${String(
      callLimit.maxCalls,
    )}. Do not request it again.`,
    policyOutcome: 'disallowed_tool_call',
  });
}
