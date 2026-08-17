import {createRuntimePluginContextItem} from '../api/manifest-validation.ts';
import {createRuntimePluginCuratedContextSection} from '../api/curated-context.ts';
import {isRecord} from '../api/validation-primitives.ts';
import type {
  RuntimePlugin,
  RuntimePluginBeforeRoleModelCallResult,
  RuntimePluginContext,
  RuntimePluginContextItem,
  RuntimePluginCuratedContextSection,
  RuntimePluginEvidenceSnapshot,
} from '../api/types.ts';
import {
  runtimePluginBeforeRoleModelCallRejectionReason,
  type RuntimePluginBeforeRoleModelCallRejectionReason,
} from '../api/contract.ts';
import {beforeRoleModelFailureRejectsTurn} from '../api/evidence-policy.ts';
import {
  boundPromptContextBlock,
  type CollectedPluginContextItem,
} from '../policy/prompt-context-budget.ts';
import {
  runtimePluginAccessForPlugin,
  type RuntimePluginAccessMapByPluginId,
} from '../policy/access-control.ts';
import {pluginCanWriteModelInput} from '../policy/tool-policy.ts';
import {
  assertPluginCuratedContextWithinCaps,
  assertPluginRuntimeNotesWithinCaps,
  pluginCanWriteTrustedContext,
} from '../policy/trusted-context.ts';
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
  /** Recalled memories and plugin data, each block already held to its budget. */
  readonly contextItems: readonly RuntimePluginContextItem[];
  /** Runtime notes from plugins cleared for the trusted frame, cap-checked. */
  readonly runtimeNotes: readonly RuntimePluginContextItem[];
  readonly curatedContext: readonly RuntimePluginCuratedContextSection[];
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
      readonly runtimeNotes: readonly RuntimePluginContextItem[];
      readonly curatedContext: readonly RuntimePluginCuratedContextSection[];
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
  const runtimeNotes: RuntimePluginContextItem[] = [];
  const curatedContext: RuntimePluginCuratedContextSection[] = [];
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
    runtimeNotes.push(...outcome.runtimeNotes);
    curatedContext.push(...outcome.curatedContext);
  }

  const boundedBlocks = [
    boundPromptContextBlock({
      context: options.context,
      block: 'recalled_memory',
      contextItems: contextItems.filter(({item}) => item.kind === 'memory'),
    }),
    boundPromptContextBlock({
      context: options.context,
      block: 'untrusted_plugin_context',
      contextItems: contextItems.filter(({item}) => item.kind !== 'memory'),
    }),
  ];

  for (const boundedBlock of boundedBlocks) {
    evidence.push(...boundedBlock.evidence);
  }

  const rejectedBlock = boundedBlocks.find(
    boundedBlock => boundedBlock.status === 'rejected',
  );

  if (rejectedBlock?.status === 'rejected') {
    return Object.freeze({
      status: 'rejected',
      reason: runtimePluginBeforeRoleModelCallRejectionReason,
      pluginId: rejectedBlock.pluginId,
      message: rejectedBlock.message,
      evidence: Object.freeze([...evidence]),
    } satisfies RuntimePluginBeforeRoleModelCallHostResult);
  }

  return Object.freeze({
    status: 'completed',
    contextItems: Object.freeze(
      boundedBlocks.flatMap(boundedBlock =>
        boundedBlock.status === 'completed' ? boundedBlock.contextItems : [],
      ),
    ),
    runtimeNotes: Object.freeze([...runtimeNotes]),
    curatedContext: Object.freeze([...curatedContext]),
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
  const result = await invokeBeforeRoleModelCallHook({
    plugin,
    executionScope,
    // Built inside the invocation: opening a durable store takes its
    // mutation lease, and a lock that is already held must degrade the
    // plugin like any other hook failure, not reject the turn.
    createHookContext: () =>
      createPluginHookContext({
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
      }),
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

  const curatedContext = result.value.curatedContext ?? [];
  const trusted = pluginCanWriteTrustedContext(access);

  if (curatedContext.length > 0 && !trusted) {
    return failedBeforeRoleModelCallPlugin({
      plugin,
      context: options.context,
      message: `Plugin "${plugin.manifest.id}" returned curated context sections without granted trusted_context write access.`,
      acceptedEvidence: result.value.evidence,
    });
  }

  // A cleared plugin's runtime notes are trusted model input; every other
  // item, and every item from an uncleared plugin, stays in the budgeted blocks.
  const runtimeNotes = trusted
    ? result.value.contextItems.filter(item => item.kind === 'runtime_note')
    : [];

  try {
    assertPluginRuntimeNotesWithinCaps({
      pluginId: plugin.manifest.id,
      notes: runtimeNotes,
    });
  } catch (error: unknown) {
    return failedBeforeRoleModelCallPlugin({
      plugin,
      context: options.context,
      message: errorMessage(error),
      acceptedEvidence: result.value.evidence,
    });
  }

  return Object.freeze({
    status: 'continued',
    contextItems: Object.freeze(
      result.value.contextItems
        .filter(item => !runtimeNotes.includes(item))
        .map(item => ({plugin, item})),
    ),
    runtimeNotes: Object.freeze(runtimeNotes),
    curatedContext,
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
    runtimeNotes: Object.freeze([]),
    curatedContext: Object.freeze([]),
    evidence,
  });
}

async function invokeBeforeRoleModelCallHook(options: {
  readonly plugin: RuntimePlugin;
  readonly executionScope: PluginHookExecutionScope;
  readonly createHookContext: () => {
    readonly context: RuntimePluginContext;
    readonly revokeFileStoreWrites: () => void;
  };
  readonly hook: NonNullable<
    RuntimePlugin['lifecycleHooks']['beforeRoleModelCall']
  >;
}): Promise<BeforeRoleModelCallInvocationResult> {
  try {
    const hookContext = options.createHookContext();

    return Object.freeze({
      status: 'accepted',
      value: await withPluginHookTimeout({
        pluginId: options.plugin.manifest.id,
        policyManifest: options.plugin.manifest,
        hookName: 'beforeRoleModelCall',
        executionScope: options.executionScope,
        revokeFileStoreWrites: hookContext.revokeFileStoreWrites,
        operation: async deadlineAt =>
          normalizeBeforeRoleModelCallResult({
            plugin: options.plugin,
            context: hookContext.context,
            value: await options.hook(hookContext.context),
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
  const curatedContext = normalizeCuratedContextSections({
    plugin: options.plugin,
    value: value['curatedContext'],
  });

  return Object.freeze({
    contextItems,
    ...(curatedContext.length === 0 ? {} : {curatedContext}),
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

function normalizeCuratedContextSections(options: {
  readonly plugin: RuntimePlugin;
  readonly value: unknown;
}): readonly RuntimePluginCuratedContextSection[] {
  if (options.value === undefined) {
    return Object.freeze([]);
  }

  const entries = requiredArray(options.value, 'curatedContext');
  const sections = Object.freeze(
    entries.map(entry => {
      const section = createRuntimePluginCuratedContextSection(entry);

      assertSnapshotPluginId({
        plugin: options.plugin,
        actualPluginId: section.pluginId,
        field: 'curatedContext.pluginId',
      });
      return section;
    }),
  );

  assertPluginCuratedContextWithinCaps({
    pluginId: options.plugin.manifest.id,
    sections,
  });
  return sections;
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
