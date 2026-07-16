import {
  createPreparedRuntimePluginConfigEffectConfirmationPreview,
  isRuntimeConfigConflictError,
  preparedRuntimePluginConfigEffectIsStillCurrent,
  type RuntimePluginConfigControlHostState
} from './builtin/runtime-plugin/index.ts';
import { createRuntimePluginEvidenceSnapshot } from './constructors.ts';
import { mergedRedactionLabels } from './tool-evidence-policy.ts';
import { redactRuntimePluginText } from './validation-primitives.ts';
import type {
  RuntimePluginEvidenceStatus,
  RuntimePluginPolicyOutcome
} from './contract.ts';
import type {
  PreparedRuntimePluginConfigEffect,
  RuntimePlugin,
  RuntimePluginContext,
  RuntimePluginJsonObject,
  RuntimePluginProvidedTool,
  RuntimePluginToolCall,
  RuntimePluginToolCallExecutionResult,
  RuntimePluginToolCallResult
} from './plugin-types.ts';

export type RuntimePluginToolConfirmationRequest = {
  readonly pluginId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly preview: RuntimePluginJsonObject;
};

export type RuntimePluginToolConfirmationDecision =
  | { readonly status: 'approved' }
  | { readonly status: 'denied' }
  | { readonly status: 'cancelled' };

export type RuntimePluginToolConfirmationContext = {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
};

export type RuntimePluginToolConfirmationHandler = (
  request: RuntimePluginToolConfirmationRequest,
  context: RuntimePluginToolConfirmationContext
) =>
  | RuntimePluginToolConfirmationDecision
  | Promise<RuntimePluginToolConfirmationDecision>;

export const runtimePluginToolApprovalTimeoutMs = 5 * 60_000;

export async function requestRuntimePluginToolConfirmation(
  handler: RuntimePluginToolConfirmationHandler,
  request: RuntimePluginToolConfirmationRequest,
  timeoutMs = runtimePluginToolApprovalTimeoutMs
): Promise<RuntimePluginToolConfirmationDecision | { readonly status: 'timed_out' }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const abortController = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;

  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        handler(request, {
          signal: abortController.signal,
          deadlineAt
        })
      ),
      new Promise<{ readonly status: 'timed_out' }>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve(Object.freeze({ status: 'timed_out' as const }));
          abortController.abort();
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    abortController.abort();
  }
}

export async function confirmPreparedRuntimePluginToolResult(options: {
  readonly plugin: RuntimePlugin;
  readonly providedTool: RuntimePluginProvidedTool;
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly result: Extract<
    RuntimePluginToolCallExecutionResult,
    { readonly status: 'accepted' }
  >;
  readonly confirmationHandler: RuntimePluginToolConfirmationHandler;
  readonly pluginConfigControl: RuntimePluginConfigControlHostState;
  readonly storeRoot?: string;
}): Promise<RuntimePluginToolCallExecutionResult> {
  const effect = options.result.preparedConfigEffect;

  if (effect === undefined) {
    throw new TypeError(
      'Approval-gated runtime config tool result is missing its prepared effect.'
    );
  }

  let preview: ReturnType<
    typeof createPreparedRuntimePluginConfigEffectConfirmationPreview
  >;

  try {
    preview = createPreparedRuntimePluginConfigEffectConfirmationPreview({
      effect,
      state: options.pluginConfigControl,
      ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot })
    });
  } catch (error: unknown) {
    if (!isRuntimeConfigConflictError(error)) {
      throw error;
    }

    return createRejectedToolCallResult({
      call: options.call,
      context: options.context,
      reason: 'plugin_config_fingerprint_conflict',
      message:
        'Plugin config changed before approval and the prepared update was discarded.',
      evidenceStatus: 'rejected',
      policyOutcome: 'handler_rejected'
    });
  }

  let decision: Awaited<
    ReturnType<typeof requestRuntimePluginToolConfirmation>
  >;

  try {
    decision = await requestRuntimePluginToolConfirmation(
      options.confirmationHandler,
      Object.freeze({
        pluginId: options.plugin.manifest.id,
        toolName: options.providedTool.name,
        summary: options.providedTool.description,
        preview
      })
    );
  } catch {
    return createRejectedToolCallResult({
      call: options.call,
      context: options.context,
      reason: 'plugin_config_approval_unavailable',
      message: 'Plugin config update approval could not be completed.',
      evidenceStatus: 'rejected',
      policyOutcome: 'handler_rejected'
    });
  }

  if (decision.status === 'approved') {
    if (
      !preparedRuntimePluginConfigEffectIsStillCurrent({
        effect,
        state: options.pluginConfigControl,
        ...(options.storeRoot === undefined
          ? {}
          : { storeRoot: options.storeRoot })
      })
    ) {
      return createRejectedToolCallResult({
        call: options.call,
        context: options.context,
        reason: 'plugin_config_fingerprint_conflict',
        message:
          'Plugin config changed during approval and the prepared update was discarded.',
        evidenceStatus: 'rejected',
        policyOutcome: 'handler_rejected'
      });
    }
    return withRuntimePluginToolApprovalEvidence({
      plugin: options.plugin,
      context: options.context,
      effect,
      result: options.result
    });
  }

  const rejection =
    decision.status === 'timed_out'
      ? {
          reason: 'plugin_config_approval_timeout',
          message: `Plugin config update approval timed out after ${String(runtimePluginToolApprovalTimeoutMs)}ms.`
        }
      : decision.status === 'denied'
        ? {
            reason: 'plugin_config_approval_denied',
            message: 'Plugin config update was denied by the user.'
          }
        : {
            reason: 'plugin_config_approval_cancelled',
            message: 'Plugin config update approval was cancelled.'
          };

  return createRejectedToolCallResult({
    call: options.call,
    context: options.context,
    ...rejection,
    evidenceStatus: 'rejected',
    policyOutcome: 'handler_rejected'
  });
}

function withRuntimePluginToolApprovalEvidence(options: {
  readonly plugin: RuntimePlugin;
  readonly context: RuntimePluginContext;
  readonly effect: PreparedRuntimePluginConfigEffect;
  readonly result: Extract<
    RuntimePluginToolCallExecutionResult,
    { readonly status: 'accepted' }
  >;
}): RuntimePluginToolCallExecutionResult {
  const approvalEvidence = createRuntimePluginEvidenceSnapshot({
    eventId: options.context.eventId,
    traceId: options.context.traceId,
    createdAt: options.context.timestamp,
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: options.plugin.manifest.id,
    evidenceKind: 'policy',
    status: 'accepted',
    summary: `User approved one prepared config effect from plugin "${options.plugin.manifest.id}".`,
    policyOutcome: 'user_approved',
    sourceReferences: [
      {
        kind: 'runtime',
        id: options.effect.effectId
      }
    ],
    redactionLabels: mergedRedactionLabels({
      plugin: options.plugin,
      context: options.context
    }),
    configFingerprint: options.effect.resultFingerprint
  });

  return Object.freeze({
    ...options.result,
    evidence: Object.freeze([...options.result.evidence, approvalEvidence])
  });
}

export function createRejectedToolCallResult(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly reason: string;
  readonly message: string;
  readonly evidenceStatus?: RuntimePluginEvidenceStatus;
  readonly policyOutcome?: RuntimePluginPolicyOutcome;
}): RuntimePluginToolCallResult {
  const message = redactRuntimePluginText(options.message);

  return Object.freeze({
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
        redactionLabels: options.context.privacy.redactionLabels
      })
    ])
  } satisfies RuntimePluginToolCallResult);
}
