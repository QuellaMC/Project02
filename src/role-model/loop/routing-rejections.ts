import {
  createRuntimePluginEvidenceSnapshot,
  type RuntimePluginContext,
  type RuntimePluginEvidenceStatus,
  type RuntimePluginPolicyOutcome,
  type RuntimePluginToolCall,
  type RuntimePluginToolCallResult,
} from '../../plugins/api/index.ts';

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
  readonly context: RuntimePluginContext;
  readonly reason: string;
  readonly message: string;
  readonly evidenceStatus?: RuntimePluginEvidenceStatus;
  readonly policyOutcome?: RuntimePluginPolicyOutcome;
}): RoleModelPluginToolRoutingEvidence {
  const message = options.message;

  return Object.freeze({
    callId: options.callId,
    call: options.call,
    dispatchedToHost: options.dispatchedToHost,
    result: Object.freeze({
      status: 'rejected',
      reason: options.reason,
      message,
      evidence: Object.freeze([
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

/** A tool the turn never offered: told to the model as a tool result, never dispatched. */
export function undeclaredToolRejection(options: {
  readonly callId: string;
  readonly call: RuntimePluginToolCall;
  readonly toolName: string;
  readonly context: RuntimePluginContext;
}): RoleModelPluginToolRoutingEvidence {
  return createRejectedToolRoutingEvidence({
    callId: options.callId,
    call: options.call,
    dispatchedToHost: false,
    context: options.context,
    reason: 'tool_not_declared',
    message: `Tool "${options.toolName}" is not declared for this turn.`,
    policyOutcome: 'disallowed_tool_call',
  });
}
