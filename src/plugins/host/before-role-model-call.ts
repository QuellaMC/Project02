import {createRuntimePluginContextItem} from '../api/manifest-validation.ts';
import {isRecord} from '../api/validation-primitives.ts';
import type {
  RuntimePlugin,
  RuntimePluginBeforeRoleModelCallResult,
  RuntimePluginContext,
  RuntimePluginContextItem,
  RuntimePluginEvidenceSnapshot,
} from '../api/types.ts';
import {
  runtimePluginBeforeRoleModelCallRejectionReason,
  type RuntimePluginBeforeRoleModelCallRejectionReason,
} from '../api/contract.ts';
import {beforeRoleModelFailureRejectsTurn} from '../api/evidence-policy.ts';
import {
  boundPluginPromptContext,
  type CollectedPluginContextItem,
} from '../policy/prompt-context-budget.ts';
import {
  runtimePluginAccessForPlugin,
  type RuntimePluginAccessMapByPluginId,
} from '../policy/access-control.ts';
import {pluginCanWriteModelInput} from '../policy/tool-policy.ts';
import {
  assertSnapshotPluginId,
  createHookFailureEvidence,
  normalizeEvidenceSnapshots,
  requiredArray,
} from './hook-evidence.ts';
import {
  createPluginHookContext,
  type PluginHookCapabilityOptions,
} from './hook-context.ts';
import {
  createPluginHookExecutionScope,
  errorMessage,
  PluginHookTimeoutError,
  snapshotPluginHookResult,
  withPluginHookTimeout,
  type PluginHookExecutionScope,
} from './hook-execution.ts';

export type RuntimePluginBeforeRoleModelCallCompletedResult = {
  readonly status: 'completed';
  readonly contextItems: readonly RuntimePluginContextItem[];
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
};

type RuntimePluginBeforeRoleModelCallRejectedResult = {
  readonly status: 'rejected';
  readonly reason: RuntimePluginBeforeRoleModelCallRejectionReason;
  readonly pluginId: string;
  readonly message: string;
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
};

export type RuntimePluginBeforeRoleModelCallHostResult =
  | RuntimePluginBeforeRoleModelCallCompletedResult
  | RuntimePluginBeforeRoleModelCallRejectedResult;

type BeforeRoleModelCallInvocationResult =
  | {
      readonly status: 'accepted';
      readonly value: RuntimePluginBeforeRoleModelCallResult;
    }
  | {
      readonly status: 'failed';
      readonly message: string;
      readonly failureKind: 'exception' | 'timeout';
    };

export type BeforeRoleModelCallOptions = {
  readonly plugins: readonly RuntimePlugin[];
  readonly context: RuntimePluginContext;
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
} & PluginHookCapabilityOptions & {};

type BeforeRoleModelCallPluginOutcome =
  | {
      readonly status: 'continued';
      readonly contextItems: readonly CollectedPluginContextItem[];
      readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
    }
  | {
      readonly status: 'rejected';
      readonly pluginId: string;
      readonly message: string;
      readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
    };

export async function runBeforeRoleModelCall(
  options: BeforeRoleModelCallOptions,
): Promise<RuntimePluginBeforeRoleModelCallHostResult> {
  const contextItems: CollectedPluginContextItem[] = [];
  const evidence: RuntimePluginEvidenceSnapshot[] = [];

  for (const plugin of options.plugins) {
    const outcome = await runBeforeRoleModelCallPlugin(plugin, options);

    evidence.push(...outcome.evidence);
    if (outcome.status === 'rejected') {
      return Object.freeze({
        status: 'rejected',
        reason: runtimePluginBeforeRoleModelCallRejectionReason,
        pluginId: outcome.pluginId,
        message: outcome.message,
        evidence: Object.freeze([...evidence]),
      } satisfies RuntimePluginBeforeRoleModelCallHostResult);
    }

    contextItems.push(...outcome.contextItems);
  }

  const boundedContext = boundPluginPromptContext({
    context: options.context,
    contextItems,
  });
  evidence.push(...boundedContext.evidence);

  if (boundedContext.status === 'rejected') {
    return Object.freeze({
      status: 'rejected',
      reason: runtimePluginBeforeRoleModelCallRejectionReason,
      pluginId: boundedContext.pluginId,
      message: boundedContext.message,
      evidence: Object.freeze([...evidence]),
    } satisfies RuntimePluginBeforeRoleModelCallHostResult);
  }

  return Object.freeze({
    status: 'completed',
    contextItems: boundedContext.contextItems,
    evidence: Object.freeze([...evidence]),
  } satisfies RuntimePluginBeforeRoleModelCallHostResult);
}

async function runBeforeRoleModelCallPlugin(
  plugin: RuntimePlugin,
  options: BeforeRoleModelCallOptions,
): Promise<BeforeRoleModelCallPluginOutcome> {
  const hook = plugin.lifecycleHooks.beforeRoleModelCall;

  if (hook === undefined) {
    return continuedBeforeRoleModelCall();
  }

  const access = runtimePluginAccessForPlugin({
    plugin,
    accessByPluginId: options.accessByPluginId,
  });
  const executionScope = createPluginHookExecutionScope(plugin.manifest);
  const hookContext = createPluginHookContext({
    context: options.context,
    plugin,
    access,
    deadlineAt: executionScope.deadlineAt,
    signal: executionScope.abortController.signal,
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    sessionIdentity: options.sessionIdentity,
    createFileStore: options.createFileStore,
    sessionHistory: options.sessionHistory,
    openPluginDatabase: options.openPluginDatabase,
  });
  const result = await invokeBeforeRoleModelCallHook({
    plugin,
    context: hookContext.context,
    executionScope,
    revokeFileStoreWrites: hookContext.revokeFileStoreWrites,
    hook,
  });

  if (result.status === 'failed') {
    return failedBeforeRoleModelCallPlugin({
      plugin,
      context: options.context,
      message: result.message,
      failureKind: result.failureKind,
    });
  }

  if (evidenceRecordsBlockingBeforeRoleModelCall(result.value.evidence)) {
    return failedBeforeRoleModelCallPlugin({
      plugin,
      context: options.context,
      message: `Plugin "${plugin.manifest.id}" accepted beforeRoleModelCall result included blocking before-role-model evidence.`,
      acceptedEvidence: result.value.evidence,
    });
  }

  if (
    !pluginCanWriteModelInput(access) &&
    result.value.contextItems.length > 0
  ) {
    return failedBeforeRoleModelCallPlugin({
      plugin,
      context: options.context,
      message: `Plugin "${plugin.manifest.id}" returned beforeRoleModelCall model input contributions without declaring model_input write access.`,
      acceptedEvidence: result.value.evidence,
    });
  }

  return Object.freeze({
    status: 'continued',
    contextItems: Object.freeze(
      result.value.contextItems.map(item => ({plugin, item})),
    ),
    evidence: result.value.evidence,
  } satisfies BeforeRoleModelCallPluginOutcome);
}

function failedBeforeRoleModelCallPlugin(options: {
  readonly plugin: RuntimePlugin;
  readonly context: RuntimePluginContext;
  readonly message: string;
  readonly failureKind?: 'exception' | 'timeout';
  readonly acceptedEvidence?: readonly RuntimePluginEvidenceSnapshot[];
}): BeforeRoleModelCallPluginOutcome {
  const rejectsTurn = beforeRoleModelFailureRejectsTurn(options.plugin);
  const policyOutcome =
    options.failureKind === 'timeout'
      ? 'timeout'
      : rejectsTurn
        ? 'required_rejected'
        : 'optional_degraded';
  const failureEvidence = createHookFailureEvidence({
    plugin: options.plugin,
    context: options.context,
    evidenceKind: 'before_role_model_call',
    status: rejectsTurn ? 'rejected' : 'degraded',
    summary: rejectsTurn
      ? `Required before-role-model plugin hook rejected the turn: ${options.message}`
      : `Optional before-role-model plugin hook degraded: ${options.message}`,
    policyOutcome,
  });
  const evidence = Object.freeze([
    ...(options.acceptedEvidence ?? []),
    failureEvidence,
  ]);

  return rejectsTurn
    ? Object.freeze({
        status: 'rejected',
        pluginId: options.plugin.manifest.id,
        message: options.message,
        evidence,
      })
    : continuedBeforeRoleModelCall(evidence);
}

function continuedBeforeRoleModelCall(
  evidence: readonly RuntimePluginEvidenceSnapshot[] = [],
): BeforeRoleModelCallPluginOutcome {
  return Object.freeze({
    status: 'continued',
    contextItems: Object.freeze([]),
    evidence,
  });
}

async function invokeBeforeRoleModelCallHook(options: {
  readonly plugin: RuntimePlugin;
  readonly context: RuntimePluginContext;
  readonly executionScope: PluginHookExecutionScope;
  readonly revokeFileStoreWrites: () => void;
  readonly hook: NonNullable<
    RuntimePlugin['lifecycleHooks']['beforeRoleModelCall']
  >;
}): Promise<BeforeRoleModelCallInvocationResult> {
  try {
    return Object.freeze({
      status: 'accepted',
      value: await withPluginHookTimeout({
        pluginId: options.plugin.manifest.id,
        policyManifest: options.plugin.manifest,
        hookName: 'beforeRoleModelCall',
        executionScope: options.executionScope,
        revokeFileStoreWrites: options.revokeFileStoreWrites,
        operation: async deadlineAt =>
          normalizeBeforeRoleModelCallResult({
            plugin: options.plugin,
            context: options.context,
            value: await options.hook(options.context),
            deadlineAt,
          }),
      }),
    } satisfies BeforeRoleModelCallInvocationResult);
  } catch (error: unknown) {
    return Object.freeze({
      status: 'failed',
      message: errorMessage(error),
      failureKind:
        error instanceof PluginHookTimeoutError ? 'timeout' : 'exception',
    } satisfies BeforeRoleModelCallInvocationResult);
  }
}

function normalizeBeforeRoleModelCallResult(options: {
  readonly plugin: RuntimePlugin;
  readonly context: RuntimePluginContext;
  readonly value: unknown;
  readonly deadlineAt: number;
}): RuntimePluginBeforeRoleModelCallResult {
  const value = snapshotPluginHookResult({
    pluginId: options.plugin.manifest.id,
    policyManifest: options.plugin.manifest,
    hookName: 'beforeRoleModelCall',
    value: options.value,
    deadlineAt: options.deadlineAt,
  });

  if (!isRecord(value)) {
    throw new TypeError('beforeRoleModelCall hook result must be an object.');
  }

  if (Object.hasOwn(value, 'runtimeNotes')) {
    throw new TypeError(
      'beforeRoleModelCall runtimeNotes are not supported; return source-attributed contextItems.',
    );
  }

  const contextItems = normalizeContextItems({
    plugin: options.plugin,
    value: value['contextItems'],
  });

  return Object.freeze({
    contextItems,
    evidence: normalizeEvidenceSnapshots({
      plugin: options.plugin,
      context: options.context,
      value: value['evidence'],
    }),
  } satisfies RuntimePluginBeforeRoleModelCallResult);
}

function normalizeContextItems(options: {
  readonly plugin: RuntimePlugin;
  readonly value: unknown;
}): readonly RuntimePluginContextItem[] {
  const items = requiredArray(options.value, 'contextItems');
  if (items.length > 64) {
    throw new TypeError('contextItems exceed the 64-record limit.');
  }

  return Object.freeze(
    items.map(item => {
      const contextItem = createRuntimePluginContextItem(item);

      assertSnapshotPluginId({
        plugin: options.plugin,
        actualPluginId: contextItem.pluginId,
        field: 'contextItems.pluginId',
      });
      return contextItem;
    }),
  );
}

function evidenceRecordsBlockingBeforeRoleModelCall(
  evidence: readonly RuntimePluginEvidenceSnapshot[],
): boolean {
  return evidence.some(
    item =>
      item.evidenceKind === 'before_role_model_call' &&
      (item.status === 'rejected' ||
        item.status === 'failed' ||
        item.policyOutcome === 'required_rejected'),
  );
}
