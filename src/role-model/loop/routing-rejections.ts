import {
  createRuntimePluginEvidenceSnapshot,
  redactRuntimePluginText,
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
