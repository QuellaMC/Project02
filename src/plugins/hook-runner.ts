import {
  createPreparedRuntimePluginConfigEffect,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginHealthSnapshot,
  createRuntimePluginRegistrySnapshot,
  createRuntimePluginToolCallResultSnapshot
} from './constructors.ts';
import { createRuntimePluginContextItem } from './manifest-validation.ts';
import { redactRuntimePluginText } from './validation-primitives.ts';
import type {
  RuntimePluginEvidenceKind,
  RuntimePluginEvidenceStatus,
  RuntimePluginPolicyOutcome
} from './contract.ts';
import type {
  RuntimePlugin,
  RuntimePluginBeforeRoleModelCallResult,
  RuntimePluginContextItem,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginHealthSnapshot,
  RuntimePluginHookResult,
  RuntimePluginJsonValue,
  RuntimePluginProvidedTool,
  PreparedRuntimePluginConfigEffect,
  RuntimePluginToolCall,
  RuntimePluginToolCallExecutionResult,
  RuntimePluginToolCallResult,
  RuntimePluginRegistrySnapshot,
  RuntimePluginSourceReference,
  RuntimePluginAfterTurnCommittedContext,
  RuntimePluginContext
} from './plugin-types.ts';
import {
  resolveRuntimePluginAccessForPlugins,
  runtimePluginAccessForPlugin,
  type RuntimePluginAccessMapByPluginId
} from './access-control.ts';
import {
  createHostScopedFirstPartyRuntimePlugins,
  isHostOwnedFirstPartyRuntimePlugin,
  isHostScopedFirstPartyRuntimePluginId
} from './catalog.ts';
import { createPluginHookContext } from './hook-context.ts';
import {
  createRuntimePluginFileStoreTransaction,
  type RuntimePluginFileStorePreparedTransaction,
  type RuntimePluginFileStoreTransaction
} from './file-store.ts';
import { isApprovalGatedRuntimePluginTool } from './tool-contract.ts';
import type { RuntimeEventIdentity } from '../runtime/event.ts';
import { validateModelToolInputAgainstContract } from '../role-model/model-tools.ts';
import {
  isModelFacingPluginTool,
  pluginCanWriteModelInput,
  pluginToolHasRequiredGrantedAccess,
  pluginToolDefinitionsForEnabledPlugins,
  routableModelFacingPluginTools,
  toolAllowsFileStoreWrites
} from './tool-policy.ts';
import { runtimePluginEvidenceBlocksToolInvocation } from './tool-evidence-policy.ts';
import {
  createRoleModelPluginToolDefinitions,
  type RoleModelPluginToolDefinition
} from '../role-model/contracts.ts';
import {
  createJsonBoundarySnapshot
} from '../shared/json-boundary.ts';
import {
  createPreparedRuntimePluginConfigEffectConfirmationPreview,
  preparedRuntimePluginConfigEffectIsStillCurrent,
  createRuntimePluginConfigControlHostStateSnapshot,
  reconcilePreparedRuntimePluginConfigEffect,
  type RuntimePluginConfigControlHostState
} from './builtin/runtime-plugin/index.ts';
import {
  requestRuntimePluginToolConfirmation,
  runtimePluginToolApprovalTimeoutMs,
  type RuntimePluginToolConfirmationHandler
} from './tool-confirmation.ts';

export { runtimePluginId } from './contract.ts';

export const runtimePluginBeforeRoleModelCallRejectionReason =
  'plugin_before_role_model_call_rejected';

export type RuntimePluginBeforeRoleModelCallRejectionReason =
  typeof runtimePluginBeforeRoleModelCallRejectionReason;

export type CreateRuntimePluginHostOptions = {
  readonly plugins?: readonly RuntimePlugin[];
  readonly enabledPluginIds?: readonly string[];
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionIdentity?: object | undefined;
  readonly pluginInventoryState?: RuntimePluginConfigControlHostState;
  readonly pluginConfigControl?: RuntimePluginConfigControlHostState;
  readonly toolConfirmationHandler?: RuntimePluginToolConfirmationHandler;
};

export type RuntimePluginBeforeRoleModelCallCompletedResult = {
  readonly status: 'completed';
  readonly contextItems: readonly RuntimePluginContextItem[];
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
};

export type RuntimePluginBeforeRoleModelCallRejectedResult = {
  readonly status: 'rejected';
  readonly reason: RuntimePluginBeforeRoleModelCallRejectionReason;
  readonly pluginId: string;
  readonly message: string;
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
};

export type RuntimePluginBeforeRoleModelCallHostResult =
  | RuntimePluginBeforeRoleModelCallCompletedResult
  | RuntimePluginBeforeRoleModelCallRejectedResult;

export type RuntimePluginHookHostResult = {
  readonly status: 'completed' | 'completed_with_failures';
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
};

export type RuntimePluginSessionEndOptions = {
  readonly allowFileStoreWrites?: boolean;
};

export type RunRuntimePluginSessionEndHooksOptions = {
  readonly plugins: readonly RuntimePlugin[];
  readonly context: RuntimePluginContext;
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionIdentity?: object | undefined;
  readonly hookOptions?: RuntimePluginSessionEndOptions;
};

export type RunRuntimePluginShutdownHooksOptions = {
  readonly plugins: readonly RuntimePlugin[];
  readonly context: RuntimePluginContext;
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionIdentity?: object | undefined;
};

type RunRuntimePluginSessionEndHooksWithResolvedPermissionsOptions = {
  readonly plugins: readonly RuntimePlugin[];
  readonly context: RuntimePluginContext;
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionIdentity?: object | undefined;
  readonly hookOptions?: RuntimePluginSessionEndOptions;
};

type RunRuntimePluginShutdownHooksWithResolvedPermissionsOptions = {
  readonly plugins: readonly RuntimePlugin[];
  readonly context: RuntimePluginContext;
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionIdentity?: object | undefined;
};

export type RuntimePluginHealthHostResult = {
  readonly snapshots: readonly RuntimePluginHealthSnapshot[];
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
};

const runtimePluginContextEstimatedTokenBudget = 256;

export type RuntimePluginHost = {
  registrySnapshot(): RuntimePluginRegistrySnapshot;
  enabledPluginIds(): readonly string[];
  pluginToolDefinitions(): readonly RoleModelPluginToolDefinition[];
  beforeRoleModelCall(
    context: RuntimePluginContext
  ): Promise<RuntimePluginBeforeRoleModelCallHostResult>;
  handleToolCall(
    call: RuntimePluginToolCall,
    context: RuntimePluginContext
  ): Promise<RuntimePluginToolCallExecutionResult>;
  reconcileConfigEffect?(
    effect: PreparedRuntimePluginConfigEffect
  ): RuntimePluginEvidenceSnapshot;
  beginFileStoreTransaction?(): void;
  prepareFileStoreTransaction?(
    identity: RuntimeEventIdentity
  ): Promise<RuntimePluginFileStorePreparedTransaction | undefined>;
  rollbackFileStoreTransaction?(): void;
  afterTurnCommitted(
    context: RuntimePluginAfterTurnCommittedContext
  ): Promise<RuntimePluginHookHostResult>;
  onSessionEnd(
    context: RuntimePluginContext,
    options?: RuntimePluginSessionEndOptions
  ): Promise<RuntimePluginHookHostResult>;
  shutdown(
    context: RuntimePluginContext
  ): Promise<RuntimePluginHookHostResult>;
  health(context: RuntimePluginContext): Promise<RuntimePluginHealthHostResult>;
};

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

type HookInvocationResult =
  | {
      readonly status: 'accepted';
      readonly value: RuntimePluginHookResult;
    }
    | {
        readonly status: 'failed';
        readonly message: string;
        readonly failureKind: 'exception' | 'timeout';
      };

type CollectedPluginContextItem = {
  readonly plugin: RuntimePlugin;
  readonly item: RuntimePluginContextItem;
};

type CollectedPluginPromptContext = {
  readonly plugin: RuntimePlugin;
  readonly promptIndex: number;
  readonly estimatedTokens: number;
  readonly priority: number;
  readonly contextItem: CollectedPluginContextItem;
};

type BoundedPluginPromptContextResult =
  | {
      readonly status: 'completed';
      readonly contextItems: readonly RuntimePluginContextItem[];
      readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
    }
  | {
      readonly status: 'rejected';
      readonly pluginId: string;
      readonly message: string;
      readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
    };

type RuntimePluginHostState = {
  readonly sessionIdentity: object | undefined;
  readonly pluginConfigControl: RuntimePluginConfigControlHostState | undefined;
  readonly enabledIds: readonly string[];
  readonly enabledPlugins: readonly RuntimePlugin[];
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  readonly registrySnapshot: RuntimePluginRegistrySnapshot;
  readonly pluginToolDefinitions: readonly RoleModelPluginToolDefinition[];
};

export function createRuntimePluginHost(
  options: CreateRuntimePluginHostOptions = {}
): RuntimePluginHost {
  const {
    sessionIdentity,
    pluginConfigControl,
    enabledIds,
    enabledPlugins,
    accessByPluginId,
    registrySnapshot,
    pluginToolDefinitions
  } = createRuntimePluginHostState(options);
  let activeFileStoreTransaction:
    | RuntimePluginFileStoreTransaction
    | undefined;
  let shutdownResult: Promise<RuntimePluginHookHostResult> | undefined;

  return Object.freeze({
    registrySnapshot() {
      return registrySnapshot;
    },
    enabledPluginIds() {
      return Object.freeze([...enabledIds]);
    },
    pluginToolDefinitions() {
      return pluginToolDefinitions;
    },
    async beforeRoleModelCall(context) {
      return await runBeforeRoleModelCall({
        plugins: enabledPlugins,
        context,
        accessByPluginId,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        sessionIdentity,
        ...(activeFileStoreTransaction === undefined
          ? {}
          : { fileStoreTransaction: activeFileStoreTransaction })
      });
    },
    async handleToolCall(call, context) {
      return await runHandleToolCall({
        plugins: enabledPlugins,
        call,
        context,
        accessByPluginId,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        sessionIdentity,
        ...(options.toolConfirmationHandler === undefined
          ? {}
          : { toolConfirmationHandler: options.toolConfirmationHandler }),
        ...(pluginConfigControl === undefined
          ? {}
          : { pluginConfigControl }),
        ...(activeFileStoreTransaction === undefined
          ? {}
          : { fileStoreTransaction: activeFileStoreTransaction })
      });
    },
    reconcileConfigEffect(effect) {
      if (pluginConfigControl === undefined) {
        throw new Error(
          'Runtime plugin config reconciliation requires configured host control state.'
        );
      }

      return reconcilePreparedRuntimePluginConfigEffect({
        effect,
        state: pluginConfigControl,
        ...(options.storeRoot === undefined
          ? {}
          : { storeRoot: options.storeRoot })
      });
    },
    beginFileStoreTransaction() {
      if (activeFileStoreTransaction !== undefined) {
        throw new Error('Plugin fileStore transaction is already active.');
      }

      activeFileStoreTransaction = createRuntimePluginFileStoreTransaction();
    },
    async prepareFileStoreTransaction(identity) {
      const transaction = activeFileStoreTransaction;

      activeFileStoreTransaction = undefined;
      return await transaction?.prepare(identity);
    },
    rollbackFileStoreTransaction() {
      const transaction = activeFileStoreTransaction;

      activeFileStoreTransaction = undefined;
      transaction?.rollback();
    },
    async afterTurnCommitted(context) {
      const hookResult = await runHookPhase({
        plugins: enabledPlugins,
        context,
        accessByPluginId,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        sessionIdentity,
        hookName: 'afterTurnCommitted',
        evidenceKind: 'after_turn_committed',
        hookForPlugin: (plugin) =>
          plugin.lifecycleHooks.afterTurnCommitted
      });

      return Object.freeze({
        status: hookResult.status,
        evidence: hookResult.evidence
      } satisfies RuntimePluginHookHostResult);
    },
    async onSessionEnd(context, hookOptions) {
      return await runRuntimePluginSessionEndHooksWithResolvedPermissions({
        plugins: enabledPlugins,
        context,
        accessByPluginId,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        sessionIdentity,
        ...(hookOptions === undefined ? {} : { hookOptions })
      });
    },
    shutdown(context) {
      shutdownResult ??= runRuntimePluginShutdownHooksWithResolvedPermissions({
        plugins: enabledPlugins,
        context,
        accessByPluginId,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        sessionIdentity
      });

      return shutdownResult;
    },
    async health(context) {
      return await runHealth({
        plugins: enabledPlugins,
        context,
        accessByPluginId,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        sessionIdentity,
        ...(activeFileStoreTransaction === undefined
          ? {}
          : { fileStoreTransaction: activeFileStoreTransaction })
      });
    }
  } satisfies RuntimePluginHost);
}

function createRuntimePluginHostState(
  options: CreateRuntimePluginHostOptions
): RuntimePluginHostState {
  if (
    options.pluginInventoryState !== undefined &&
    options.pluginConfigControl !== undefined
  ) {
    throw new TypeError(
      'Runtime plugin inventory-only state and config-control state cannot both be supplied.'
    );
  }

  const sessionIdentity =
    options.storeRoot === undefined
      ? (options.sessionIdentity ?? Object.freeze({}))
      : options.sessionIdentity;
  const configuredPlugins = Object.freeze([...(options.plugins ?? [])]);
  const pluginConfigControl =
    options.pluginConfigControl === undefined
      ? undefined
      : createRuntimePluginConfigControlHostStateSnapshot(
          options.pluginConfigControl
        );
  const pluginInventoryState =
    pluginConfigControl ??
    (options.pluginInventoryState === undefined
      ? undefined
      : createRuntimePluginConfigControlHostStateSnapshot(
          options.pluginInventoryState
        ));
  let allPlugins: readonly RuntimePlugin[] = [];
  let enabledPlugins: readonly RuntimePlugin[] = [];
  let accessByPluginId: RuntimePluginAccessMapByPluginId = Object.freeze({});
  assertNoCallerSuppliedHostScopedFirstPartyPlugins(configuredPlugins);
  const hostScopedPlugins = createHostScopedFirstPartyRuntimePlugins({
    hostStateForTurn: () => ({
      plugins: allPlugins,
      enabledPlugins,
      accessByPluginId,
      confirmationAvailable:
        options.toolConfirmationHandler !== undefined &&
        pluginConfigControl !== undefined,
      ...(pluginInventoryState === undefined
        ? {}
        : { installedPluginManifests: pluginInventoryState.pluginManifests }),
      ...(pluginInventoryState?.activationByPluginId === undefined
        ? {}
        : {
            activationStates: Object.freeze(
              Object.entries(pluginInventoryState.activationByPluginId).map(
                ([pluginId, activation]) =>
                  Object.freeze({
                    pluginId,
                    activationStatus: activation.status
                  })
              )
            )
          })
    }),
    ...(pluginConfigControl === undefined ? {} : { pluginConfigControl }),
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot })
  });
  const plugins = Object.freeze([...hostScopedPlugins, ...configuredPlugins]);
  allPlugins = plugins;
  const enabledIds = enabledPluginIdsForHost({
    plugins,
    enabledPluginIds: options.enabledPluginIds
  });
  enabledPlugins = Object.freeze(
    plugins.filter((plugin) => enabledIds.includes(plugin.manifest.id))
  );
  accessByPluginId = resolveRuntimePluginAccessForPlugins({
    plugins,
    enabledPluginIds: enabledIds
  });
  const registrySnapshot = createRuntimePluginRegistrySnapshot(plugins, {
    accessByPluginId
  });
  const pluginToolDefinitions = createRoleModelPluginToolDefinitions(
    pluginToolDefinitionsForEnabledPlugins({
      plugins: enabledPlugins,
      accessByPluginId,
      confirmationAvailable:
        options.toolConfirmationHandler !== undefined &&
        pluginConfigControl !== undefined
    })
  );

  return Object.freeze({
    sessionIdentity,
    pluginConfigControl,
    enabledIds,
    enabledPlugins,
    accessByPluginId,
    registrySnapshot,
    pluginToolDefinitions
  } satisfies RuntimePluginHostState);
}

export async function runRuntimePluginSessionEndHooks(
  options: RunRuntimePluginSessionEndHooksOptions
): Promise<RuntimePluginHookHostResult> {
  // This standalone helper treats the supplied plugins as already selected and
  // enabled. Callers that need activation filtering should pass only activated
  // plugins, or use the configured host path.
  return await runRuntimePluginSessionEndHooksWithResolvedPermissions({
    plugins: options.plugins,
    context: options.context,
    accessByPluginId: resolveRuntimePluginAccessForPlugins({
      plugins: options.plugins,
      enabledPluginIds: options.plugins.map((plugin) => plugin.manifest.id)
    }),
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    sessionIdentity: options.sessionIdentity,
    ...(options.hookOptions === undefined
      ? {}
      : { hookOptions: options.hookOptions })
  });
}

export async function runRuntimePluginShutdownHooks(
  options: RunRuntimePluginShutdownHooksOptions
): Promise<RuntimePluginHookHostResult> {
  // As with standalone session-end cleanup, callers supply the already-selected
  // plugin set. This path deliberately does not rebuild or revalidate a host.
  return await runRuntimePluginShutdownHooksWithResolvedPermissions({
    plugins: options.plugins,
    context: options.context,
    accessByPluginId: resolveRuntimePluginAccessForPlugins({
      plugins: options.plugins,
      enabledPluginIds: options.plugins.map((plugin) => plugin.manifest.id)
    }),
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    sessionIdentity: options.sessionIdentity
  });
}

async function runRuntimePluginSessionEndHooksWithResolvedPermissions(
  options: RunRuntimePluginSessionEndHooksWithResolvedPermissionsOptions
): Promise<RuntimePluginHookHostResult> {
  return await runHookPhase({
    plugins: options.plugins,
    context: options.context,
    accessByPluginId: options.accessByPluginId,
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    sessionIdentity: options.sessionIdentity,
    ...(options.hookOptions?.allowFileStoreWrites === undefined
      ? {}
      : { allowFileStoreWrites: options.hookOptions.allowFileStoreWrites }),
    hookName: 'onSessionEnd',
    evidenceKind: 'session_end',
    hookForPlugin: (plugin) => plugin.lifecycleHooks.onSessionEnd
  });
}

async function runRuntimePluginShutdownHooksWithResolvedPermissions(
  options: RunRuntimePluginShutdownHooksWithResolvedPermissionsOptions
): Promise<RuntimePluginHookHostResult> {
  return await runHookPhase({
    plugins: options.plugins,
    context: options.context,
    accessByPluginId: options.accessByPluginId,
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    sessionIdentity: options.sessionIdentity,
    allowFileStoreWrites: false,
    hookName: 'onShutdown',
    evidenceKind: 'shutdown',
    hookForPlugin: (plugin) => plugin.lifecycleHooks.onShutdown
  });
}

type BeforeRoleModelCallOptions = {
  readonly plugins: readonly RuntimePlugin[];
  readonly context: RuntimePluginContext;
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionIdentity?: object | undefined;
  readonly fileStoreTransaction?: RuntimePluginFileStoreTransaction;
};

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

async function runBeforeRoleModelCall(
  options: BeforeRoleModelCallOptions
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
        evidence: Object.freeze([...evidence])
      } satisfies RuntimePluginBeforeRoleModelCallHostResult);
    }

    contextItems.push(...outcome.contextItems);
  }

  const boundedContext = boundPluginPromptContext({
    context: options.context,
    contextItems
  });
  evidence.push(...boundedContext.evidence);

  if (boundedContext.status === 'rejected') {
    return Object.freeze({
      status: 'rejected',
      reason: runtimePluginBeforeRoleModelCallRejectionReason,
      pluginId: boundedContext.pluginId,
      message: boundedContext.message,
      evidence: Object.freeze([...evidence])
    } satisfies RuntimePluginBeforeRoleModelCallHostResult);
  }

  return Object.freeze({
    status: 'completed',
    contextItems: boundedContext.contextItems,
    evidence: Object.freeze([...evidence])
  } satisfies RuntimePluginBeforeRoleModelCallHostResult);
}

async function runBeforeRoleModelCallPlugin(
  plugin: RuntimePlugin,
  options: BeforeRoleModelCallOptions
): Promise<BeforeRoleModelCallPluginOutcome> {
  const hook = plugin.lifecycleHooks.beforeRoleModelCall;

  if (hook === undefined) {
    return continuedBeforeRoleModelCall();
  }

  const access = runtimePluginAccessForPlugin({
    plugin,
    accessByPluginId: options.accessByPluginId
  });
  const executionScope = createPluginHookExecutionScope(plugin);
  const hookContext = createPluginHookContext({
    context: options.context,
    plugin,
    access,
    deadlineAt: executionScope.deadlineAt,
    signal: executionScope.abortController.signal,
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    sessionIdentity: options.sessionIdentity,
    ...(options.fileStoreTransaction === undefined
      ? {}
      : { fileStoreTransaction: options.fileStoreTransaction })
  });
  const result = await invokeBeforeRoleModelCallHook({
    plugin,
    context: hookContext.context,
    executionScope,
    revokeFileStoreWrites: hookContext.revokeFileStoreWrites,
    hook
  });

  if (result.status === 'failed') {
    return failedBeforeRoleModelCallPlugin({
      plugin,
      context: options.context,
      message: result.message,
      failureKind: result.failureKind
    });
  }

  if (evidenceRecordsBlockingBeforeRoleModelCall(result.value.evidence)) {
    return failedBeforeRoleModelCallPlugin({
      plugin,
      context: options.context,
      message: `Plugin "${plugin.manifest.id}" accepted beforeRoleModelCall result included blocking before-role-model evidence.`,
      acceptedEvidence: result.value.evidence
    });
  }

  if (!pluginCanWriteModelInput(access) && result.value.contextItems.length > 0) {
    return failedBeforeRoleModelCallPlugin({
      plugin,
      context: options.context,
      message: `Plugin "${plugin.manifest.id}" returned beforeRoleModelCall model input contributions without declaring model_input write access.`,
      acceptedEvidence: result.value.evidence
    });
  }

  return Object.freeze({
    status: 'continued',
    contextItems: Object.freeze(
      result.value.contextItems.map((item) => ({ plugin, item }))
    ),
    evidence: result.value.evidence
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
    policyOutcome
  });
  const evidence = Object.freeze([
    ...(options.acceptedEvidence ?? []),
    failureEvidence
  ]);

  return rejectsTurn
    ? Object.freeze({
        status: 'rejected',
        pluginId: options.plugin.manifest.id,
        message: options.message,
        evidence
      })
    : continuedBeforeRoleModelCall(evidence);
}

function continuedBeforeRoleModelCall(
  evidence: readonly RuntimePluginEvidenceSnapshot[] = []
): BeforeRoleModelCallPluginOutcome {
  return Object.freeze({
    status: 'continued',
    contextItems: Object.freeze([]),
    evidence
  });
}

type HandleToolCallOptions = {
  readonly plugins: readonly RuntimePlugin[];
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionIdentity?: object | undefined;
  readonly fileStoreTransaction?: RuntimePluginFileStoreTransaction;
  readonly toolConfirmationHandler?: RuntimePluginToolConfirmationHandler;
  readonly pluginConfigControl?: RuntimePluginConfigControlHostState;
};

type ResolvedRuntimePluginToolExecution = {
  readonly status: 'resolved';
  readonly plugin: RuntimePlugin;
  readonly providedTool: RuntimePluginProvidedTool;
  readonly hook: NonNullable<
    RuntimePlugin['lifecycleHooks']['handleToolCall']
  >;
  readonly access: ReturnType<typeof runtimePluginAccessForPlugin>;
  readonly failureDegrades: boolean;
  readonly approvalGatedTool: boolean;
};

type RuntimePluginToolExecutionResolution =
  | ResolvedRuntimePluginToolExecution
  | RejectedRuntimePluginToolExecution;

type RejectedRuntimePluginToolExecution = {
  readonly status: 'rejected';
  readonly result: RuntimePluginToolCallExecutionResult;
};

async function runHandleToolCall(
  options: HandleToolCallOptions
): Promise<RuntimePluginToolCallExecutionResult> {
  const resolution = resolveRuntimePluginToolExecution(options);

  if (resolution.status === 'rejected') {
    return resolution.result;
  }

  const {
    plugin,
    providedTool,
    hook,
    access,
    failureDegrades,
    approvalGatedTool
  } = resolution;
  const executionScope = createPluginHookExecutionScope(plugin);
  const hookContext = createPluginHookContext({
    context: options.context,
    plugin,
    access,
    deadlineAt: executionScope.deadlineAt,
    signal: executionScope.abortController.signal,
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    sessionIdentity: options.sessionIdentity,
    ...(options.fileStoreTransaction === undefined
      ? {}
      : { fileStoreTransaction: options.fileStoreTransaction }),
    allowFileStoreWrites: toolAllowsFileStoreWrites(providedTool)
  });

  try {
    const result = await withPluginHookTimeout({
      plugin,
      hookName: 'handleToolCall',
      executionScope,
      revokeFileStoreWrites: hookContext.revokeFileStoreWrites,
      operation: async (deadlineAt) =>
        normalizeToolCallResult({
          plugin,
          providedTool,
          context: hookContext.context,
          value: await hook(options.call, hookContext.context),
          deadlineAt
        })
    });

    if (!approvalGatedTool || result.status === 'rejected') {
      return result;
    }

    if (
      options.toolConfirmationHandler === undefined ||
      options.pluginConfigControl === undefined
    ) {
      throw new TypeError(
        'Approval-gated plugin tool lost its host approval state.'
      );
    }

    return await confirmPreparedRuntimePluginToolResult({
      plugin,
      providedTool,
      call: options.call,
      context: options.context,
      result,
      confirmationHandler: options.toolConfirmationHandler,
      pluginConfigControl: options.pluginConfigControl,
      ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot })
    });
  } catch (error: unknown) {
    if (error instanceof PluginHookTimeoutError) {
      return createRejectedToolCallResult({
        call: options.call,
        context: options.context,
        reason: 'handler_timeout',
        message: error.message,
        evidenceStatus: failureDegrades ? 'degraded' : 'failed',
        policyOutcome: 'timeout'
      });
    }

    return createRejectedToolCallResult({
      call: options.call,
      context: options.context,
      reason: 'handler_failed',
      message: errorMessage(error),
      evidenceStatus: failureDegrades ? 'degraded' : 'rejected',
      policyOutcome: failureDegrades ? 'optional_degraded' : 'handler_rejected'
    });
  }
}

function resolveRuntimePluginToolExecution(
  options: HandleToolCallOptions
): RuntimePluginToolExecutionResolution {
  if (!runtimeIdentityMatchesContext(options.call, options.context)) {
    return rejectedRuntimePluginToolExecution({
      call: options.call,
      context: options.context,
      reason: 'tool_call_identity_mismatch',
      message: 'Tool call identity must match current runtime event identity.'
    });
  }

  const plugin = options.plugins.find(
    (candidate) => candidate.manifest.id === options.call.pluginId
  );

  if (plugin === undefined) {
    return rejectedRuntimePluginToolExecution({
      call: options.call,
      context: options.context,
      reason: 'plugin_not_enabled',
      message: `Plugin "${options.call.pluginId}" is not enabled for this turn.`
    });
  }

  const providedTool = plugin.providedTools.find(
    (tool) => tool.name === options.call.toolName
  );

  if (providedTool === undefined) {
    return rejectedRuntimePluginToolExecution({
      call: options.call,
      context: options.context,
      reason: 'tool_not_declared',
      message: `Plugin "${plugin.manifest.id}" did not declare tool "${options.call.toolName}".`
    });
  }

  const hook = plugin.lifecycleHooks.handleToolCall;
  const failureDegrades = handleToolCallFailureDegrades({
    plugin,
    providedTool
  });
  const access = runtimePluginAccessForPlugin({
    plugin,
    accessByPluginId: options.accessByPluginId
  });
  const policyRejection = rejectedRuntimePluginToolPolicy({
    plugin,
    providedTool,
    hook,
    access,
    failureDegrades,
    call: options.call,
    context: options.context
  });

  if (policyRejection !== undefined) {
    return policyRejection;
  }

  return resolveRuntimePluginToolHandler({
    options,
    plugin,
    providedTool,
    hook,
    access,
    failureDegrades
  });
}

function rejectedRuntimePluginToolPolicy(options: {
  readonly plugin: RuntimePlugin;
  readonly providedTool: RuntimePluginProvidedTool;
  readonly hook: RuntimePlugin['lifecycleHooks']['handleToolCall'];
  readonly access: ReturnType<typeof runtimePluginAccessForPlugin>;
  readonly failureDegrades: boolean;
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
}): RejectedRuntimePluginToolExecution | undefined {
  const modelFacing = isModelFacingPluginTool({
    plugin: options.plugin,
    tool: options.providedTool
  });

  if (modelFacing && !pluginCanWriteModelInput(options.access)) {
    return rejectedRuntimePluginToolExecution({
      call: options.call,
      context: options.context,
      reason: 'model_input_not_granted',
      message: `Plugin "${options.plugin.manifest.id}" did not declare model_input write access for model-facing tool "${options.providedTool.name}".`,
      evidenceStatus: options.failureDegrades ? 'degraded' : 'rejected',
      policyOutcome: options.failureDegrades
        ? 'optional_degraded'
        : 'disallowed_tool_call'
    });
  }

  if (
    modelFacing &&
    !pluginToolHasRequiredGrantedAccess({
      tool: options.providedTool,
      access: options.access
    })
  ) {
    return rejectedRuntimePluginToolExecution({
      call: options.call,
      context: options.context,
      reason: 'file_store_write_not_granted',
      message: `Plugin "${options.plugin.manifest.id}" did not declare file_store write access for local-memory-write tool "${options.providedTool.name}".`,
      evidenceStatus: options.failureDegrades ? 'degraded' : 'rejected',
      policyOutcome: options.failureDegrades
        ? 'optional_degraded'
        : 'disallowed_tool_call'
    });
  }

  if (
    options.hook !== undefined &&
    !routableModelFacingPluginTools({
      plugin: options.plugin,
      access: options.access
    }).some(
      (tool) => tool.name === options.providedTool.name
    )
  ) {
    return rejectedRuntimePluginToolExecution({
      call: options.call,
      context: options.context,
      reason: 'tool_not_routable',
      message: `Plugin "${options.plugin.manifest.id}" tool "${options.providedTool.name}" is not routable for model execution under current plugin policy.`,
      evidenceStatus: 'rejected',
      policyOutcome: 'disallowed_tool_call'
    });
  }

  return undefined;
}

function resolveRuntimePluginToolHandler(options: {
  readonly options: HandleToolCallOptions;
  readonly plugin: RuntimePlugin;
  readonly providedTool: RuntimePluginProvidedTool;
  readonly hook: RuntimePlugin['lifecycleHooks']['handleToolCall'];
  readonly access: ReturnType<typeof runtimePluginAccessForPlugin>;
  readonly failureDegrades: boolean;
}): RuntimePluginToolExecutionResolution {
  const { plugin, providedTool, hook, access, failureDegrades } = options;

  const inputValidation =
    providedTool.validationOwner === 'plugin_host'
      ? validateModelToolInputAgainstContract({
          toolName: options.options.call.toolName,
          input: options.options.call.input,
          inputContract: providedTool.inputContract
        })
      : undefined;

  if (inputValidation?.status === 'rejected') {
    return rejectedRuntimePluginToolExecution({
      call: options.options.call,
      context: options.options.context,
      reason: 'invalid_input',
      message: inputValidation.details,
      evidenceStatus: failureDegrades ? 'degraded' : 'rejected',
      policyOutcome: failureDegrades ? 'optional_degraded' : 'handler_rejected'
    });
  }

  if (hook === undefined) {
    return rejectedRuntimePluginToolExecution({
      call: options.options.call,
      context: options.options.context,
      reason: 'handler_missing',
      message: `Plugin "${plugin.manifest.id}" has no handleToolCall hook.`,
      evidenceStatus: failureDegrades ? 'degraded' : 'rejected',
      policyOutcome: failureDegrades ? 'optional_degraded' : 'handler_rejected'
    });
  }

  const approvalGatedTool = isApprovalGatedRuntimePluginTool(providedTool);

  if (
    approvalGatedTool &&
    (options.options.toolConfirmationHandler === undefined ||
      options.options.pluginConfigControl === undefined)
  ) {
    return rejectedRuntimePluginToolExecution({
      call: options.options.call,
      context: options.options.context,
      reason: 'tool_not_routable',
      message: `Plugin "${plugin.manifest.id}" tool "${providedTool.name}" requires an unavailable confirmation handler.`,
      evidenceStatus: 'rejected',
      policyOutcome: 'disallowed_tool_call'
    });
  }

  return Object.freeze({
    status: 'resolved',
    plugin,
    providedTool,
    hook,
    access,
    failureDegrades,
    approvalGatedTool
  } satisfies ResolvedRuntimePluginToolExecution);
}

function rejectedRuntimePluginToolExecution(
  options: Parameters<typeof createRejectedToolCallResult>[0]
): RejectedRuntimePluginToolExecution {
  return Object.freeze({
    status: 'rejected',
    result: createRejectedToolCallResult(options)
  });
}

async function runHookPhase<TContext extends RuntimePluginContext>(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly context: TContext;
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionIdentity?: object | undefined;
  readonly hookName: 'afterTurnCommitted' | 'onSessionEnd' | 'onShutdown';
  readonly evidenceKind: Extract<RuntimePluginEvidenceKind, 'after_turn_committed' | 'session_end' | 'shutdown'>;
  readonly allowFileStoreWrites?: boolean | undefined;
  readonly hookForPlugin: (
    plugin: RuntimePlugin
  ) => ((context: TContext) => RuntimePluginHookResult | Promise<RuntimePluginHookResult>) | undefined;
}): Promise<RuntimePluginHookHostResult> {
  const evidence: RuntimePluginEvidenceSnapshot[] = [];
  let failed = false;

  for (const plugin of options.plugins) {
    const hook = options.hookForPlugin(plugin);

    if (hook === undefined) {
      continue;
    }

    const executionScope = createPluginHookExecutionScope(plugin);
    const hookContext = createPluginHookContext({
      context: options.context,
      plugin,
      deadlineAt: executionScope.deadlineAt,
      signal: executionScope.abortController.signal,
      access: runtimePluginAccessForPlugin({
        plugin,
        accessByPluginId: options.accessByPluginId
      }),
      storeRoot: options.storeRoot,
      sessionId: options.sessionId,
      sessionIdentity: options.sessionIdentity,
      ...(options.allowFileStoreWrites === undefined
        ? {}
        : { allowFileStoreWrites: options.allowFileStoreWrites })
    });
    const result = await invokeHook({
      plugin,
      context: hookContext.context,
      executionScope,
      revokeFileStoreWrites: hookContext.revokeFileStoreWrites,
      hookName: options.hookName,
      hook
    });

    if (result.status === 'failed') {
      failed = true;
      evidence.push(
        createHookFailureEvidence({
          plugin,
          context: options.context,
          evidenceKind: options.evidenceKind,
          status: 'failed',
          summary: `${options.hookName} plugin hook failed: ${result.message}`,
          ...failurePolicyOutcomeOption(options.evidenceKind, result.failureKind)
        })
      );
      continue;
    }

    evidence.push(...result.value.evidence);

    if (result.value.status === 'failed') {
      failed = true;

      if (
        !hookEvidenceRecordsFailure({
          evidence: result.value.evidence,
          evidenceKind: options.evidenceKind
        })
      ) {
        evidence.push(
          createHookFailureEvidence({
            plugin,
            context: options.context,
            evidenceKind: options.evidenceKind,
            status: 'failed',
            summary: `${options.hookName} plugin hook reported failure.`,
            ...failurePolicyOutcomeOption(options.evidenceKind, 'exception')
          })
        );
      }
    }
  }

  return Object.freeze({
    status: failed ? 'completed_with_failures' : 'completed',
    evidence: Object.freeze([...evidence])
  } satisfies RuntimePluginHookHostResult);
}

function hookEvidenceRecordsFailure(options: {
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
  readonly evidenceKind: Extract<RuntimePluginEvidenceKind, 'after_turn_committed' | 'session_end' | 'shutdown'>;
}): boolean {
  return evidenceRecordsStatus({
    evidence: options.evidence,
    evidenceKind: options.evidenceKind,
    statuses: ['failed']
  });
}

function evidenceRecordsStatus(options: {
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
  readonly evidenceKind: RuntimePluginEvidenceKind;
  readonly statuses: readonly RuntimePluginEvidenceStatus[];
}): boolean {
  return options.evidence.some(
    (item) =>
      item.evidenceKind === options.evidenceKind &&
      options.statuses.includes(item.status)
  );
}

function evidenceRecordsToolInvocationDegrade(
  evidence: readonly RuntimePluginEvidenceSnapshot[]
): boolean {
  return evidence.some(
    (item) =>
      item.evidenceKind === 'tool_invocation' &&
      (item.status === 'degraded' ||
        item.policyOutcome === 'optional_degraded')
  );
}

function evidenceRecordsBlockingBeforeRoleModelCall(
  evidence: readonly RuntimePluginEvidenceSnapshot[]
): boolean {
  return evidence.some(
    (item) =>
      item.evidenceKind === 'before_role_model_call' &&
      (item.status === 'rejected' ||
        item.status === 'failed' ||
        item.policyOutcome === 'required_rejected')
  );
}

function normalizeToolCallResult(options: {
  readonly plugin: RuntimePlugin;
  readonly providedTool: RuntimePluginProvidedTool;
  readonly context: RuntimePluginContext;
  readonly value: unknown;
  readonly deadlineAt: number;
}): RuntimePluginToolCallExecutionResult {
  const value = snapshotPluginHookResult({
    plugin: options.plugin,
    hookName: 'handleToolCall',
    value: options.value,
    deadlineAt: options.deadlineAt
  });

  if (!isRecord(value)) {
    throw new TypeError('Plugin tool result must be an object.');
  }

  const status = value['status'];

  if (status === 'accepted') {
    const evidence = normalizeEvidenceSnapshots({
      plugin: options.plugin,
      context: options.context,
      value: value['evidence']
    });

    assertAcceptedToolEvidenceSourceReferences({
      plugin: options.plugin,
      providedTool: options.providedTool,
      evidence
    });

    if (evidence.some(runtimePluginEvidenceBlocksToolInvocation)) {
      return Object.freeze({
        status: 'rejected',
        reason: 'blocking_tool_invocation_evidence',
        message: `Plugin "${options.plugin.manifest.id}" tool "${options.providedTool.name}" accepted result included blocking tool invocation evidence.`,
        evidence
      } satisfies RuntimePluginToolCallResult);
    }

    const preparedConfigEffect = normalizePreparedRuntimePluginConfigEffect({
      plugin: options.plugin,
      providedTool: options.providedTool,
      context: options.context,
      value: value['preparedConfigEffect']
    });
    const approvalGatedTool = isApprovalGatedRuntimePluginTool(
      options.providedTool
    );

    if (approvalGatedTool && preparedConfigEffect === undefined) {
      throw new TypeError(
        'Approval-gated runtime config tools must prepare one config effect.'
      );
    }

    const result = createRuntimePluginToolCallResultSnapshot({
      status: 'accepted',
      output: normalizeJsonValue(value['output'], {
        plugin: options.plugin,
        deadlineAt: options.deadlineAt
      }),
      evidence
    });

    if (result.status !== 'accepted') {
      throw new TypeError('Accepted plugin tool result normalization failed.');
    }

    if (preparedConfigEffect === undefined) {
      return result;
    }

    return Object.freeze({
      ...result,
      preparedConfigEffect
    } satisfies RuntimePluginToolCallExecutionResult);
  }

  if (status === 'rejected') {
    if (
      value['preparedConfigEffect'] !== undefined
    ) {
      throw new TypeError(
        'Rejected plugin tool results cannot include a prepared config effect.'
      );
    }
    const reason = value['reason'];
    const message = value['message'];

    if (typeof reason !== 'string' || typeof message !== 'string') {
      throw new TypeError('Plugin rejected tool result must include reason and message.');
    }

    if (reason.trim().length === 0 || message.trim().length === 0) {
      throw new TypeError(
        'Plugin rejected tool result reason and message must be non-empty.'
      );
    }

    const redactedMessage = redactRuntimePluginText(message);
    const evidence = normalizeEvidenceSnapshots({
      plugin: options.plugin,
      context: options.context,
      value: value['evidence']
    });
    const failureDegrades = handleToolCallFailureDegrades({
      plugin: options.plugin,
      providedTool: options.providedTool
    });
    const evidenceAlreadyExplainsRejectedResult = evidenceRecordsStatus({
      evidence,
      evidenceKind: 'tool_invocation',
      statuses: ['rejected', 'failed']
    }) || evidenceRecordsToolInvocationDegrade(evidence);
    const evidenceWithFallback = evidenceAlreadyExplainsRejectedResult
      ? evidence
      : Object.freeze([
          ...evidence,
          createHookFailureEvidence({
            plugin: options.plugin,
            context: options.context,
            evidenceKind: 'tool_invocation',
            status: failureDegrades ? 'degraded' : 'rejected',
            summary: redactedMessage,
            policyOutcome: failureDegrades
              ? 'optional_degraded'
              : 'handler_rejected'
          })
        ]);

    return createRuntimePluginToolCallResultSnapshot({
      status: 'rejected',
      reason,
      message: redactedMessage,
      evidence: evidenceWithFallback
    });
  }

  throw new TypeError('Plugin tool result status is not supported.');
}

function normalizePreparedRuntimePluginConfigEffect(options: {
  readonly plugin: RuntimePlugin;
  readonly providedTool: RuntimePluginProvidedTool;
  readonly context: RuntimePluginContext;
  readonly value: unknown;
}): PreparedRuntimePluginConfigEffect | undefined {
  if (options.value === undefined) {
    return undefined;
  }

  if (
    !isApprovalGatedRuntimePluginTool(options.providedTool)
  ) {
    throw new TypeError(
      'Only an approval-gated runtime config tool can prepare a config effect.'
    );
  }

  const effect = createPreparedRuntimePluginConfigEffect(options.value);

  if (!runtimeIdentityMatchesContext(effect, options.context)) {
    throw new TypeError(
      'Prepared plugin config effect identity must match current runtime event identity.'
    );
  }

  return effect;
}

async function confirmPreparedRuntimePluginToolResult(options: {
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

  const preview = createPreparedRuntimePluginConfigEffectConfirmationPreview({
    effect,
    state: options.pluginConfigControl,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot })
  });

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

function createRejectedToolCallResult(options: {
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

function normalizeJsonValue(
  value: unknown,
  options: {
    readonly plugin: RuntimePlugin;
    readonly deadlineAt?: number;
  }
): RuntimePluginJsonValue {
  try {
    return createJsonBoundarySnapshot(value, {
      field: 'Plugin tool output',
      redact: true,
      ...(options.deadlineAt === undefined
        ? {}
        : { deadlineAt: options.deadlineAt })
    });
  } catch (error: unknown) {
    if (
      error instanceof TypeError &&
      error.message.endsWith('JSON normalization timed out.')
    ) {
      throw new PluginHookTimeoutError(
        {
          pluginId: options.plugin.manifest.id,
          hookName: 'handleToolCall',
          timeoutMs: options.plugin.manifest.runtimePolicy.timeoutMs
        },
        { cause: error }
      );
    }

    throw error;
  }
}

function snapshotPluginHookResult(options: {
  readonly plugin: RuntimePlugin;
  readonly hookName:
    | 'afterTurnCommitted'
    | 'beforeRoleModelCall'
    | 'handleToolCall'
    | 'health'
    | 'onSessionEnd'
    | 'onShutdown';
  readonly value: unknown;
  readonly deadlineAt: number;
}): unknown {
  try {
    return createJsonBoundarySnapshot(options.value, {
      field: `Plugin ${options.hookName} result`,
      redact: true,
      deadlineAt: options.deadlineAt
    });
  } catch (error: unknown) {
    if (
      error instanceof TypeError &&
      error.message.endsWith('JSON normalization timed out.')
    ) {
      throw new PluginHookTimeoutError(
        {
          pluginId: options.plugin.manifest.id,
          hookName: options.hookName,
          timeoutMs: options.plugin.manifest.runtimePolicy.timeoutMs
        },
        { cause: error }
      );
    }

    throw error;
  }
}

async function runHealth(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly context: RuntimePluginContext;
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionIdentity?: object | undefined;
  readonly fileStoreTransaction?: RuntimePluginFileStoreTransaction;
}): Promise<RuntimePluginHealthHostResult> {
  const snapshots: RuntimePluginHealthSnapshot[] = [];
  const evidence: RuntimePluginEvidenceSnapshot[] = [];

  for (const plugin of options.plugins) {
    const hook = plugin.lifecycleHooks.health;

    if (hook === undefined) {
      continue;
    }

    const executionScope = createPluginHookExecutionScope(plugin);
    const hookContext = createPluginHookContext({
      context: options.context,
      plugin,
      deadlineAt: executionScope.deadlineAt,
      signal: executionScope.abortController.signal,
      access: runtimePluginAccessForPlugin({
        plugin,
        accessByPluginId: options.accessByPluginId
      }),
      storeRoot: options.storeRoot,
      sessionId: options.sessionId,
      sessionIdentity: options.sessionIdentity,
      ...(options.fileStoreTransaction === undefined
        ? {}
        : { fileStoreTransaction: options.fileStoreTransaction })
    });

    try {
      const snapshot = await withPluginHookTimeout({
        plugin,
        hookName: 'health',
        executionScope,
        revokeFileStoreWrites: hookContext.revokeFileStoreWrites,
        operation: async (deadlineAt) =>
          createRuntimePluginHealthSnapshot(
            snapshotPluginHookResult({
              plugin,
              hookName: 'health',
              value: await hook(hookContext.context),
              deadlineAt
            })
          )
      });

      assertSnapshotPluginId({
        plugin,
        actualPluginId: snapshot.pluginId,
        field: 'health.pluginId'
      });
      snapshots.push(snapshot);
      const healthEvidence = createHealthSnapshotEvidence({
        plugin,
        context: options.context,
        snapshot
      });

      if (healthEvidence !== undefined) {
        evidence.push(healthEvidence);
      }
    } catch (error: unknown) {
      const message = errorMessage(error);
      const policyOutcome =
        error instanceof PluginHookTimeoutError ? 'timeout' : 'health_degraded';

      snapshots.push(
        createRuntimePluginHealthSnapshot({
          pluginId: plugin.manifest.id,
          status: 'unavailable',
          checkedAt: options.context.timestamp,
          summary: message,
          redactionLabels: mergedRedactionLabels({
            plugin,
            context: options.context
          })
        })
      );
      evidence.push(
        createHookFailureEvidence({
          plugin,
          context: options.context,
          evidenceKind: 'health',
          status:
            plugin.manifest.runtimePolicy.failureBehavior.health === 'degrade'
              ? 'degraded'
              : 'failed',
          summary: `Plugin health hook failed: ${message}`,
          policyOutcome
        })
      );
    }
  }

  return Object.freeze({
    snapshots: Object.freeze([...snapshots]),
    evidence: Object.freeze([...evidence])
  } satisfies RuntimePluginHealthHostResult);
}

function createHealthSnapshotEvidence(options: {
  readonly plugin: RuntimePlugin;
  readonly context: RuntimePluginContext;
  readonly snapshot: RuntimePluginHealthSnapshot;
}): RuntimePluginEvidenceSnapshot | undefined {
  if (options.snapshot.status === 'ok') {
    return undefined;
  }

  return createHookFailureEvidence({
    plugin: options.plugin,
    context: options.context,
    evidenceKind: 'health',
    status: healthSnapshotEvidenceStatus(options),
    summary: `Plugin health ${options.snapshot.status}: ${options.snapshot.summary}`,
    policyOutcome: 'health_degraded'
  });
}

function healthSnapshotEvidenceStatus(options: {
  readonly plugin: RuntimePlugin;
  readonly snapshot: RuntimePluginHealthSnapshot;
}): RuntimePluginEvidenceStatus {
  if (
    options.snapshot.status === 'unavailable' &&
    options.plugin.manifest.runtimePolicy.failureBehavior.health === 'reject_turn'
  ) {
    return 'failed';
  }

  return 'degraded';
}

async function invokeBeforeRoleModelCallHook(options: {
  readonly plugin: RuntimePlugin;
  readonly context: RuntimePluginContext;
  readonly executionScope: PluginHookExecutionScope;
  readonly revokeFileStoreWrites: () => void;
  readonly hook: NonNullable<RuntimePlugin['lifecycleHooks']['beforeRoleModelCall']>;
}): Promise<BeforeRoleModelCallInvocationResult> {
  try {
    return Object.freeze({
      status: 'accepted',
      value: await withPluginHookTimeout({
          plugin: options.plugin,
          hookName: 'beforeRoleModelCall',
          executionScope: options.executionScope,
          revokeFileStoreWrites: options.revokeFileStoreWrites,
          operation: async (deadlineAt) =>
            normalizeBeforeRoleModelCallResult({
              plugin: options.plugin,
              context: options.context,
              value: await options.hook(options.context),
              deadlineAt
            })
        })
    } satisfies BeforeRoleModelCallInvocationResult);
  } catch (error: unknown) {
    return Object.freeze({
      status: 'failed',
      message: errorMessage(error),
      failureKind:
        error instanceof PluginHookTimeoutError ? 'timeout' : 'exception'
    } satisfies BeforeRoleModelCallInvocationResult);
  }
}

async function invokeHook<TContext extends RuntimePluginContext>(options: {
  readonly plugin: RuntimePlugin;
  readonly context: TContext;
  readonly executionScope: PluginHookExecutionScope;
  readonly revokeFileStoreWrites: () => void;
  readonly hookName: 'afterTurnCommitted' | 'onSessionEnd' | 'onShutdown';
  readonly hook: (context: TContext) => RuntimePluginHookResult | Promise<RuntimePluginHookResult>;
}): Promise<HookInvocationResult> {
  try {
    return Object.freeze({
      status: 'accepted',
      value: await withPluginHookTimeout({
          plugin: options.plugin,
          hookName: options.hookName,
          executionScope: options.executionScope,
          revokeFileStoreWrites: options.revokeFileStoreWrites,
          operation: async (deadlineAt) =>
            normalizeHookResult({
              plugin: options.plugin,
              context: options.context,
              value: await options.hook(options.context),
              deadlineAt,
              hookName: options.hookName
            })
        })
    } satisfies HookInvocationResult);
  } catch (error: unknown) {
    return Object.freeze({
      status: 'failed',
      message: errorMessage(error),
      failureKind:
        error instanceof PluginHookTimeoutError ? 'timeout' : 'exception'
    } satisfies HookInvocationResult);
  }
}

function normalizeBeforeRoleModelCallResult(options: {
  readonly plugin: RuntimePlugin;
  readonly context: RuntimePluginContext;
  readonly value: unknown;
  readonly deadlineAt: number;
}): RuntimePluginBeforeRoleModelCallResult {
  const value = snapshotPluginHookResult({
    plugin: options.plugin,
    hookName: 'beforeRoleModelCall',
    value: options.value,
    deadlineAt: options.deadlineAt
  });

  if (!isRecord(value)) {
    throw new TypeError('beforeRoleModelCall hook result must be an object.');
  }

  if (Object.hasOwn(value, 'runtimeNotes')) {
    throw new TypeError(
      'beforeRoleModelCall runtimeNotes are not supported; return source-attributed contextItems.'
    );
  }

  const contextItems = normalizeContextItems({
    plugin: options.plugin,
    value: value['contextItems']
  });

  return Object.freeze({
    contextItems,
    evidence: normalizeEvidenceSnapshots({
      plugin: options.plugin,
      context: options.context,
      value: value['evidence']
    })
  } satisfies RuntimePluginBeforeRoleModelCallResult);
}

function normalizeHookResult(options: {
  readonly plugin: RuntimePlugin;
  readonly context: RuntimePluginContext;
  readonly value: unknown;
  readonly deadlineAt: number;
  readonly hookName: 'afterTurnCommitted' | 'onSessionEnd' | 'onShutdown';
}): RuntimePluginHookResult {
  const value = snapshotPluginHookResult({
    plugin: options.plugin,
    hookName: options.hookName,
    value: options.value,
    deadlineAt: options.deadlineAt
  });

  if (!isRecord(value)) {
    throw new TypeError('Plugin hook result must be an object.');
  }

  const status = value['status'];

  if (status !== 'completed' && status !== 'failed') {
    throw new TypeError('Plugin hook result status is not supported.');
  }

  return Object.freeze({
    status,
    evidence: normalizeEvidenceSnapshots({
      plugin: options.plugin,
      context: options.context,
      value: value['evidence']
    })
  } satisfies RuntimePluginHookResult);
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
    items.map((item) => {
      const contextItem = createRuntimePluginContextItem(item);

      assertSnapshotPluginId({
        plugin: options.plugin,
        actualPluginId: contextItem.pluginId,
        field: 'contextItems.pluginId'
      });
      assertContextItemSourceReferences({
        plugin: options.plugin,
        contextItem
      });

      return contextItem;
    })
  );
}

function boundPluginPromptContext(options: {
  readonly context: RuntimePluginContext;
  readonly contextItems: readonly CollectedPluginContextItem[];
}): BoundedPluginPromptContextResult {
  const candidates = collectedPluginPromptContextCandidates({
    contextItems: options.contextItems
  });
  const totalEstimatedTokens = candidates.reduce(
    (total, candidate) => total + candidate.estimatedTokens,
    0
  );

  if (totalEstimatedTokens <= runtimePluginContextEstimatedTokenBudget) {
    return Object.freeze({
      status: 'completed',
      contextItems: Object.freeze(
        options.contextItems.map((contextItem) => contextItem.item)
      ),
      evidence: Object.freeze([])
    });
  }

  const retainedCandidates = new Set<CollectedPluginPromptContext>();
  let retainedEstimatedTokens = 0;

  for (const candidate of [...candidates].sort(
    compareCollectedPromptContextPriority
  )) {
    const nextEstimatedTokens =
      retainedEstimatedTokens + candidate.estimatedTokens;

    if (nextEstimatedTokens > runtimePluginContextEstimatedTokenBudget) {
      continue;
    }

    retainedCandidates.add(candidate);
    retainedEstimatedTokens = nextEstimatedTokens;
  }

  const retainedContextItems = candidates.flatMap((candidate) => {
    if (!retainedCandidates.has(candidate)) {
      return [];
    }

    return [candidate.contextItem.item];
  });
  const droppedCandidates = candidates.filter(
    (candidate) => !retainedCandidates.has(candidate)
  );
  const evidence = contextBudgetEvidence({
    context: options.context,
    droppedCandidates,
    retainedEstimatedTokens,
    totalEstimatedTokens
  });
  const rejectedContextItem =
    firstDroppedPromptContextThatRejectsTurn(droppedCandidates);

  if (rejectedContextItem !== undefined) {
    return Object.freeze({
      status: 'rejected',
      pluginId: rejectedContextItem.plugin.manifest.id,
      message: requiredContextBudgetRejectionMessage(rejectedContextItem),
      evidence
    });
  }

  return Object.freeze({
    status: 'completed',
    contextItems: Object.freeze(retainedContextItems),
    evidence
  });
}

function collectedPluginPromptContextCandidates(options: {
  readonly contextItems: readonly CollectedPluginContextItem[];
}): readonly CollectedPluginPromptContext[] {
  const candidates: CollectedPluginPromptContext[] = [];

  for (const contextItem of options.contextItems) {
    candidates.push({
      plugin: contextItem.plugin,
      promptIndex: candidates.length,
      estimatedTokens: estimateContextItemTokens(contextItem.item),
      priority: contextItem.item.budget.priority,
      contextItem
    });
  }

  return Object.freeze(candidates);
}

function compareCollectedPromptContextPriority(
  left: CollectedPluginPromptContext,
  right: CollectedPluginPromptContext
): number {
  return right.priority - left.priority || left.promptIndex - right.promptIndex;
}

function contextBudgetEvidence(options: {
  readonly context: RuntimePluginContext;
  readonly droppedCandidates: readonly CollectedPluginPromptContext[];
  readonly retainedEstimatedTokens: number;
  readonly totalEstimatedTokens: number;
}): readonly RuntimePluginEvidenceSnapshot[] {
  const droppedByPlugin = new Map<
    string,
    {
      readonly plugin: RuntimePlugin;
      readonly dropped: CollectedPluginPromptContext[];
    }
  >();

  for (const droppedCandidate of options.droppedCandidates) {
    const pluginId = droppedCandidate.plugin.manifest.id;
    const entry = droppedByPlugin.get(pluginId);

    if (entry === undefined) {
      droppedByPlugin.set(pluginId, {
        plugin: droppedCandidate.plugin,
        dropped: [droppedCandidate]
      });
      continue;
    }

    entry.dropped.push(droppedCandidate);
  }

  return Object.freeze(
    [...droppedByPlugin.values()].map((entry) => {
      const rejectsTurn = beforeRoleModelFailureRejectsTurn(entry.plugin);

      return createHookFailureEvidence({
        plugin: entry.plugin,
        context: options.context,
        evidenceKind: 'before_role_model_call',
        status: rejectsTurn ? 'rejected' : 'degraded',
        summary: contextBudgetEvidenceSummary({
          droppedCandidates: entry.dropped,
          retainedEstimatedTokens: options.retainedEstimatedTokens,
          totalEstimatedTokens: options.totalEstimatedTokens
        }),
        policyOutcome: rejectsTurn ? 'required_rejected' : 'optional_degraded'
      });
    })
  );
}

function firstDroppedPromptContextThatRejectsTurn(
  droppedCandidates: readonly CollectedPluginPromptContext[]
): CollectedPluginPromptContext | undefined {
  return droppedCandidates.find((candidate) =>
    beforeRoleModelFailureRejectsTurn(candidate.plugin)
  );
}

function requiredContextBudgetRejectionMessage(
  candidate: CollectedPluginPromptContext
): string {
  return `Required before-role-model plugin context exceeded the ${String(
    runtimePluginContextEstimatedTokenBudget
  )}-token budget; dropped context item "${candidate.contextItem.item.id}".`;
}

function contextBudgetEvidenceSummary(options: {
  readonly droppedCandidates: readonly CollectedPluginPromptContext[];
  readonly retainedEstimatedTokens: number;
  readonly totalEstimatedTokens: number;
}): string {
  const droppedIds = options.droppedCandidates
    .map((candidate) => candidate.contextItem.item.id)
    .join(', ');

  return `Plugin context budget kept ${String(
    options.retainedEstimatedTokens
  )}/${String(runtimePluginContextEstimatedTokenBudget)} estimated tokens and dropped ${
    String(options.droppedCandidates.length)
  } item(s) from ${String(
    options.totalEstimatedTokens
  )} estimated tokens${
    droppedIds.length === 0 ? '' : `; dropped ids ${droppedIds}`
  }`;
}

function estimateContextItemTokens(item: RuntimePluginContextItem): number {
  return Math.max(
    item.budget.estimatedTokens,
    estimateRuntimeTextTokens(item.text)
  );
}

function estimateRuntimeTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function normalizeEvidenceSnapshots(options: {
  readonly plugin: RuntimePlugin;
  readonly context: RuntimePluginContext;
  readonly value: unknown;
}): readonly RuntimePluginEvidenceSnapshot[] {
  const items = requiredArray(options.value, 'evidence');
  if (items.length > 64) {
    throw new TypeError('evidence exceeds the 64-record limit.');
  }

  return Object.freeze(
    items.map((item) => {
      const evidence = createRuntimePluginEvidenceSnapshot(
        item
      );

      assertSnapshotPluginId({
        plugin: options.plugin,
        actualPluginId: evidence.pluginId,
        field: 'evidence.pluginId'
      });
      assertSnapshotRuntimeIdentity({
        context: options.context,
        snapshot: evidence,
        field: 'evidence'
      });

      return evidence;
    })
  );
}

function createHookFailureEvidence(options: {
  readonly plugin: RuntimePlugin;
  readonly context: RuntimePluginContext;
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
      : { policyOutcome: options.policyOutcome }),
    redactionLabels: mergedRedactionLabels({
      plugin: options.plugin,
      context: options.context
    }),
    ...(options.plugin.manifest.config.fingerprint === undefined
      ? {}
      : { configFingerprint: options.plugin.manifest.config.fingerprint })
  });
}

function failurePolicyOutcomeOption(
  evidenceKind: RuntimePluginEvidenceKind,
  failureKind: 'exception' | 'timeout'
): { readonly policyOutcome?: RuntimePluginPolicyOutcome } {
  if (failureKind === 'timeout') {
    return {
      policyOutcome: 'timeout'
    };
  }

  if (evidenceKind === 'after_turn_committed') {
    return {
      policyOutcome: 'after_commit_failed'
    };
  }

  return {};
}

function enabledPluginIdsForHost(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly enabledPluginIds: readonly string[] | undefined;
}): readonly string[] {
  if (options.enabledPluginIds === undefined) {
    return Object.freeze(
      options.plugins
        .filter(
          (plugin) =>
            isHostOwnedFirstPartyRuntimePlugin(plugin) &&
            plugin.manifest.activation.defaultEnabled
        )
        .map((plugin) => plugin.manifest.id)
    );
  }

  const pluginIds = new Set(
    options.plugins.map((plugin) => plugin.manifest.id)
  );
  const seenEnabledIds = new Set<string>();
  const enabledIds: string[] = [];

  for (const enabledId of options.enabledPluginIds) {
    if (!pluginIds.has(enabledId)) {
      throw new TypeError(`Unknown enabled plugin id "${enabledId}".`);
    }

    if (seenEnabledIds.has(enabledId)) {
      throw new TypeError(`Duplicate enabled plugin id "${enabledId}".`);
    }

    seenEnabledIds.add(enabledId);
    enabledIds.push(enabledId);
  }

  return Object.freeze(enabledIds);
}

function assertNoCallerSuppliedHostScopedFirstPartyPlugins(
  plugins: readonly RuntimePlugin[]
): void {
  for (const plugin of plugins) {
    if (isHostScopedFirstPartyRuntimePluginId(plugin.manifest.id)) {
      throw new TypeError(
        `Plugin "${plugin.manifest.id}" is host-owned and cannot be supplied by callers.`
      );
    }
  }
}

function beforeRoleModelFailureRejectsTurn(plugin: RuntimePlugin): boolean {
  return (
    plugin.manifest.runtimePolicy.requiredForTurn ||
    plugin.manifest.runtimePolicy.failureBehavior.beforeRoleModelCall ===
      'reject_turn'
  );
}

function handleToolCallFailureDegrades(options: {
  readonly plugin: RuntimePlugin;
  readonly providedTool: RuntimePluginProvidedTool;
}): boolean {
  return (
    !options.plugin.manifest.runtimePolicy.requiredForTurn &&
    !options.providedTool.requiredForUserTurn &&
    options.plugin.manifest.runtimePolicy.failureBehavior.handleToolCall ===
      'degrade'
  );
}

function assertSnapshotPluginId(options: {
  readonly plugin: RuntimePlugin;
  readonly actualPluginId: string;
  readonly field: string;
}): void {
  if (options.actualPluginId === options.plugin.manifest.id) {
    return;
  }

  throw new TypeError(
    `${options.field} must match plugin "${options.plugin.manifest.id}".`
  );
}

function assertSnapshotRuntimeIdentity(options: {
  readonly context: RuntimePluginContext;
  readonly snapshot: Pick<RuntimePluginEvidenceSnapshot, 'eventId' | 'traceId' | 'createdAt'>;
  readonly field: string;
}): void {
  if (runtimeIdentityMatchesContext(options.snapshot, options.context)) {
    return;
  }

  throw new TypeError(
    `${options.field} identity must match current runtime event identity.`
  );
}

function runtimeIdentityMatchesContext(
  identity: Pick<RuntimeEventIdentity, 'eventId' | 'traceId' | 'createdAt'>,
  context: RuntimePluginContext
): boolean {
  return (
    identity.eventId === context.eventId &&
    identity.traceId === context.traceId &&
    identity.createdAt === context.timestamp
  );
}

function assertContextItemSourceReferences(options: {
  readonly plugin: RuntimePlugin;
  readonly contextItem: RuntimePluginContextItem;
}): void {
  assertRequiredSourceReferences({
    sourceReferencesRequired:
      options.plugin.manifest.runtimePolicy.sourceReferencesRequired,
    sourceReferences: options.contextItem.sourceReferences,
    message: `Plugin "${options.plugin.manifest.id}" context item "${options.contextItem.id}" requires source references.`
  });
}

function assertAcceptedToolEvidenceSourceReferences(options: {
  readonly plugin: RuntimePlugin;
  readonly providedTool: RuntimePluginProvidedTool;
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
}): void {
  assertRequiredSourceReferences({
    sourceReferencesRequired: options.providedTool.sourceReferencesRequired,
    sourceReferences: options.evidence
      .filter(
        (evidence) =>
          evidence.evidenceKind === 'tool_invocation' &&
          evidence.status === 'accepted'
      )
      .flatMap((evidence) => evidence.sourceReferences ?? []),
    message: `Plugin "${options.plugin.manifest.id}" tool "${options.providedTool.name}" accepted result requires source references.`
  });
}

function assertRequiredSourceReferences(options: {
  readonly sourceReferencesRequired: boolean;
  readonly sourceReferences: readonly RuntimePluginSourceReference[] | undefined;
  readonly message: string;
}): void {
  if (!options.sourceReferencesRequired) {
    return;
  }

  if ((options.sourceReferences?.length ?? 0) > 0) {
    return;
  }

  throw new TypeError(options.message);
}

function mergedRedactionLabels(options: {
  readonly plugin: RuntimePlugin;
  readonly context: RuntimePluginContext;
}): readonly string[] {
  return Object.freeze([
    ...new Set([
      ...options.context.privacy.redactionLabels,
      ...options.plugin.manifest.runtimePolicy.redactionLabels
    ])
  ]);
}

function requiredArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array.`);
  }

  return value;
}

class PluginHookTimeoutError extends Error {
  constructor(options: {
    readonly pluginId: string;
    readonly hookName: string;
    readonly timeoutMs: number;
  }, errorOptions?: ErrorOptions) {
    super(
      `Plugin "${options.pluginId}" ${options.hookName} timed out after ${String(
        options.timeoutMs
      )}ms.`,
      errorOptions
    );
    this.name = 'PluginHookTimeoutError';
  }
}

type PluginHookExecutionScope = {
  readonly abortController: AbortController;
  readonly deadlineAt: number;
};

function createPluginHookExecutionScope(
  plugin: RuntimePlugin
): PluginHookExecutionScope {
  return Object.freeze({
    abortController: new AbortController(),
    deadlineAt: Date.now() + plugin.manifest.runtimePolicy.timeoutMs
  });
}

async function withPluginHookTimeout<T>(options: {
  readonly plugin: RuntimePlugin;
  readonly hookName: string;
  readonly executionScope: PluginHookExecutionScope;
  readonly revokeFileStoreWrites: () => void;
  readonly operation: (deadlineAt: number) => T | Promise<T>;
}): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.plugin.manifest.runtimePolicy.timeoutMs;
  const deadlineAt = options.executionScope.deadlineAt;
  const remainingMs = Math.max(0, deadlineAt - Date.now());

  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => options.operation(deadlineAt))
        .then((value) => {
          if (Date.now() >= deadlineAt) {
            const error = new PluginHookTimeoutError({
              pluginId: options.plugin.manifest.id,
              hookName: options.hookName,
              timeoutMs
            });

            options.executionScope.abortController.abort(error);
            throw error;
          }

          return value;
        }),
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          const error = new PluginHookTimeoutError({
            pluginId: options.plugin.manifest.id,
            hookName: options.hookName,
            timeoutMs
          });

          options.executionScope.abortController.abort(error);
          options.revokeFileStoreWrites();
          reject(error);
        }, remainingMs);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    options.revokeFileStoreWrites();
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return 'Plugin hook failed.';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
