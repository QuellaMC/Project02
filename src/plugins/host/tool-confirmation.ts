import {
  appliedRuntimePluginConfigUpdateOutput,
  applyPreparedRuntimePluginConfigEffect,
  createPreparedRuntimePluginConfigEffectConfirmationPreview,
  isRuntimeConfigConflictError,
  type RuntimePluginConfigControlHostState,
} from '../builtin/plugin-management/index.ts';
import {createRuntimePluginEvidenceSnapshot} from '../api/constructors.ts';
import {mergedRedactionLabels} from '../api/evidence-policy.ts';
import type {
  RuntimePluginEvidenceKind,
  RuntimePluginEvidenceStatus,
  RuntimePluginPolicyOutcome,
} from '../api/contract.ts';
import type {
  PreparedRuntimePluginConfigEffect,
  RuntimeConfigFieldDeclaration,
  RuntimePlugin,
  RuntimePluginContext,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginJsonObject,
  RuntimePluginProvidedTool,
  RuntimePluginToolCall,
  RuntimePluginToolCallExecutionResult,
  RuntimePluginToolCallResult,
} from '../api/types.ts';
import type {
  RuntimePluginConfigLiveApply,
  RuntimePluginConfigLiveApplyOutcome,
} from './reload.ts';

export type RuntimePluginToolConfirmationRequest = {
  readonly pluginId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly preview: RuntimePluginJsonObject;
};

type RuntimePluginToolConfirmationDecision =
  | {readonly status: 'approved'}
  | {readonly status: 'denied'}
  | {readonly status: 'cancelled'};

type RuntimePluginToolConfirmationContext = {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
};

export type RuntimePluginToolConfirmationHandler = (
  request: RuntimePluginToolConfirmationRequest,
  context: RuntimePluginToolConfirmationContext,
) =>
  | RuntimePluginToolConfirmationDecision
  | Promise<RuntimePluginToolConfirmationDecision>;

const runtimePluginToolApprovalTimeoutMs = 5 * 60_000;

async function requestRuntimePluginToolConfirmation(
  handler: RuntimePluginToolConfirmationHandler,
  request: RuntimePluginToolConfirmationRequest,
  timeoutMs: number,
): Promise<
  RuntimePluginToolConfirmationDecision | {readonly status: 'timed_out'}
> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const abortController = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;

  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        handler(request, {
          signal: abortController.signal,
          deadlineAt,
        }),
      ),
      new Promise<{readonly status: 'timed_out'}>(resolve => {
        timeoutId = setTimeout(() => {
          resolve(Object.freeze({status: 'timed_out' as const}));
          abortController.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    abortController.abort();
  }
}

/**
 * The whole change happens inside the tool call: the person sees the exact
 * change, and an approval writes it and brings it into the running host right
 * then. Anything but an approval leaves the authored config untouched.
 */
export async function confirmPreparedRuntimePluginToolResult(options: {
  readonly plugin: RuntimePlugin;
  readonly providedTool: RuntimePluginProvidedTool;
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly result: Extract<
    RuntimePluginToolCallExecutionResult,
    {readonly status: 'accepted'}
  >;
  readonly confirmationHandler:
    RuntimePluginToolConfirmationHandler | undefined;
  readonly confirmationTimeoutMs: number | undefined;
  readonly pluginConfigControl: RuntimePluginConfigControlHostState | undefined;
  readonly liveApply: RuntimePluginConfigLiveApply;
}): Promise<RuntimePluginToolCallResult> {
  const effect = options.result.preparedConfigEffect;
  const timeoutMs =
    options.confirmationTimeoutMs ?? runtimePluginToolApprovalTimeoutMs;

  if (
    effect === undefined ||
    options.confirmationHandler === undefined ||
    options.pluginConfigControl === undefined
  ) {
    // Unreachable: normalization rejects a result without its effect, and
    // the host's routing a gated tool it cannot confirm; this only narrows.
    throw new TypeError(
      'Approval-gated runtime config tool result is missing its prepared effect or its host approval state.',
    );
  }

  let preview: ReturnType<
    typeof createPreparedRuntimePluginConfigEffectConfirmationPreview
  >;

  try {
    preview = createPreparedRuntimePluginConfigEffectConfirmationPreview({
      effect,
      state: options.pluginConfigControl,
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
      policyOutcome: 'handler_rejected',
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
        preview,
      }),
      timeoutMs,
    );
  } catch {
    return createRejectedToolCallResult({
      call: options.call,
      context: options.context,
      reason: 'plugin_config_approval_unavailable',
      message: 'Plugin config update approval could not be completed.',
      evidenceStatus: 'rejected',
      policyOutcome: 'handler_rejected',
    });
  }

  if (decision.status === 'approved') {
    return await applyApprovedRuntimePluginConfigEffect({
      plugin: options.plugin,
      call: options.call,
      context: options.context,
      effect,
      preparedResult: options.result,
      pluginConfigControl: options.pluginConfigControl,
      liveApply: options.liveApply,
    });
  }

  const rejection =
    decision.status === 'timed_out'
      ? {
          reason: 'plugin_config_approval_timeout',
          message: `Plugin config update approval timed out after ${String(timeoutMs)}ms.`,
        }
      : decision.status === 'denied'
        ? {
            reason: 'plugin_config_approval_denied',
            message: 'Plugin config update was denied by the user.',
          }
        : {
            reason: 'plugin_config_approval_cancelled',
            message: 'Plugin config update approval was cancelled.',
          };

  return createRejectedToolCallResult({
    call: options.call,
    context: options.context,
    ...rejection,
    evidenceStatus: 'rejected',
    policyOutcome: 'handler_rejected',
  });
}

/**
 * Writes the approved change, then brings it into the running host. The
 * write is guarded by the fingerprint the person approved against; once it
 * has happened, a reload problem is reported, never undone.
 */
async function applyApprovedRuntimePluginConfigEffect(options: {
  readonly plugin: RuntimePlugin;
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly effect: PreparedRuntimePluginConfigEffect;
  readonly preparedResult: Extract<
    RuntimePluginToolCallExecutionResult,
    {readonly status: 'accepted'}
  >;
  readonly pluginConfigControl: RuntimePluginConfigControlHostState;
  readonly liveApply: RuntimePluginConfigLiveApply;
}): Promise<RuntimePluginToolCallResult> {
  const {effect} = options;
  let field: RuntimeConfigFieldDeclaration;

  try {
    field = applyPreparedRuntimePluginConfigEffect({
      effect,
      state: options.pluginConfigControl,
    });
  } catch (error: unknown) {
    return createRejectedToolCallResult({
      call: options.call,
      context: options.context,
      ...(isRuntimeConfigConflictError(error)
        ? {
            reason: 'plugin_config_fingerprint_conflict',
            message:
              'Plugin config changed during approval and was not updated. Inspect runtime.plugin.config again for the current fingerprint, then retry.',
          }
        : {
            reason: 'plugin_config_update_failed',
            message:
              error instanceof Error
                ? error.message
                : 'Plugin config update failed.',
          }),
      evidenceStatus: 'rejected',
      policyOutcome: 'handler_rejected',
    });
  }

  const outcome = await options.liveApply({
    pluginId: effect.targetPluginId,
    field,
    configFingerprint: effect.resultFingerprint,
  });
  const applied = describeLiveApplyOutcome(outcome, effect, field);
  const evidence = (input: {
    readonly evidenceKind: RuntimePluginEvidenceKind;
    readonly status: RuntimePluginEvidenceStatus;
    readonly summary: string;
    readonly policyOutcome?: RuntimePluginPolicyOutcome;
  }): RuntimePluginEvidenceSnapshot =>
    configEffectEvidence({
      plugin: options.plugin,
      context: options.context,
      effect,
      ...input,
    });

  return Object.freeze({
    status: 'accepted',
    output: appliedRuntimePluginConfigUpdateOutput({
      effect,
      field,
      appliesTo: applied.appliesTo,
      ...(applied.note === undefined ? {} : {note: applied.note}),
    }),
    evidence: Object.freeze([
      ...options.preparedResult.evidence,
      evidence({
        evidenceKind: 'policy',
        status: 'accepted',
        summary: `User approved one prepared config effect from plugin "${options.plugin.manifest.id}".`,
        policyOutcome: 'user_approved',
      }),
      evidence({
        evidenceKind: 'tool_invocation',
        status: 'accepted',
        summary: `Applied approved plugin "${effect.targetPluginId}" config field "${field.name}".`,
      }),
      ...(applied.reload === undefined
        ? []
        : [evidence({evidenceKind: 'tool_invocation', ...applied.reload})]),
    ]),
  } satisfies RuntimePluginToolCallResult);
}

/**
 * What the model and the log hear about a written change. A reload problem
 * is degraded evidence, never failed: the write it follows already happened,
 * and failed tool evidence would turn the whole result into a rejection.
 */
function describeLiveApplyOutcome(
  outcome: RuntimePluginConfigLiveApplyOutcome,
  effect: PreparedRuntimePluginConfigEffect,
  field: RuntimeConfigFieldDeclaration,
): {
  readonly appliesTo: 'now' | 'next_launch';
  readonly note?: string;
  readonly reload?: {
    readonly status: RuntimePluginEvidenceStatus;
    readonly summary: string;
  };
} {
  const target = `plugin "${effect.targetPluginId}" config field "${field.name}"`;

  switch (outcome.status) {
    case 'live':
      return {
        appliesTo: 'now',
        reload: {
          status: 'accepted',
          summary: `Live-applied ${target} by rebuilding its instance.`,
        },
      };
    case 'restart_required':
      return {appliesTo: 'next_launch'};
    case 'declined':
      return {
        appliesTo: 'next_launch',
        note: `Applies at the next launch instead of live: ${outcome.reason}.`,
        reload: {
          status: 'degraded',
          summary: `Wrote ${target}; it applies at the next launch instead of live: ${outcome.reason}.`,
        },
      };
    case 'failed':
      return {
        appliesTo: 'next_launch',
        note: `Written, but the live reload failed and the previous instance keeps serving: ${outcome.message} It takes effect at the next launch.`,
        reload: {
          status: 'degraded',
          summary: `Live reload for ${target} failed after the write; the previous instance keeps serving: ${outcome.message}`,
        },
      };
  }
}

function configEffectEvidence(options: {
  readonly plugin: RuntimePlugin;
  readonly context: RuntimePluginContext;
  readonly effect: PreparedRuntimePluginConfigEffect;
  readonly evidenceKind: RuntimePluginEvidenceKind;
  readonly status: RuntimePluginEvidenceStatus;
  readonly summary: string;
  readonly policyOutcome?: RuntimePluginPolicyOutcome;
}): RuntimePluginEvidenceSnapshot {
  return createRuntimePluginEvidenceSnapshot({
    eventId: options.context.eventId,
    traceId: options.context.traceId,
    createdAt: options.context.timestamp,
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: options.plugin.manifest.id,
    evidenceKind: options.evidenceKind,
    status: options.status,
    summary: options.summary,
    ...(options.policyOutcome === undefined
      ? {}
      : {policyOutcome: options.policyOutcome}),
    sourceReferences: [{kind: 'runtime', id: options.effect.effectId}],
    redactionLabels: mergedRedactionLabels({
      plugin: options.plugin,
      context: options.context,
    }),
    configFingerprint: options.effect.resultFingerprint,
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
  const message = options.message;

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
        redactionLabels: options.context.privacy.redactionLabels,
      }),
    ]),
  } satisfies RuntimePluginToolCallResult);
}
