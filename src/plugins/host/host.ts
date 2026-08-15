import {
  createRuntimePluginHealthSnapshot,
  createRuntimePluginRegistrySnapshot,
  createRuntimePluginToolCallResultSnapshot,
} from '../api/constructors.ts';
import {isRecord} from '../api/validation-primitives.ts';
import type {
  RuntimePluginEvidenceKind,
  RuntimePluginEvidenceStatus,
} from '../api/contract.ts';
import type {
  RuntimePlugin,
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
  RuntimePluginAfterTurnCommittedContext,
  RuntimePluginContext,
  RuntimePluginManifest,
} from '../api/types.ts';
import {
  assertRuntimePluginFileStoreProviderPresent,
  resolveRuntimePluginAccessForPlugins,
  runtimePluginAccessForPlugin,
  runtimePluginAccessForPluginId,
  type RuntimePluginAccessMapByPluginId,
} from '../policy/access-control.ts';
import {
  createHostScopedFirstPartyRuntimePlugins,
  enabledPluginIdsForHost,
  isHostScopedFirstPartyRuntimePluginId,
} from './catalog.ts';
import type {
  RuntimePluginDatabaseProvider,
  RuntimePluginSessionHistoryFeed,
} from '../api/index.ts';
import {
  createPluginHookContext,
  type PluginHookCapabilityOptions,
} from './hook-context.ts';
import {
  runBeforeRoleModelCall,
  type RuntimePluginBeforeRoleModelCallHostResult,
} from './before-role-model-call.ts';
import type {RuntimePluginFileStoreProvider} from '../api/file-store-contract.ts';
import {
  isApprovalGatedRuntimePluginTool,
  isModelFacingRuntimePluginTool,
} from '../api/tool-classification.ts';
import {validateModelToolInputAgainstContract} from '../../role-model/index.ts';
import {
  pluginCanWriteModelInput,
  pluginToolDefinitionsForEnabledPlugins,
  routableModelFacingPluginTools,
} from '../policy/tool-policy.ts';
import {
  assertSnapshotPluginId,
  createHookFailureEvidence,
  failurePolicyOutcomeOption,
  normalizeEvidenceSnapshots,
} from './hook-evidence.ts';
import {
  mergedRedactionLabels,
  runtimePluginEvidenceBlocksToolInvocation,
} from '../api/evidence-policy.ts';
import {
  createRoleModelPluginToolDefinitions,
  type RoleModelPluginToolDefinition,
} from '../../role-model/index.ts';
import {createJsonBoundarySnapshot} from '../../shared/json-boundary.ts';
import {
  createRuntimePluginConfigControlHostStateSnapshot,
  createRuntimePluginInventoryHostStateSnapshot,
  normalizePreparedRuntimePluginConfigEffect,
  reconcilePreparedRuntimePluginConfigEffect,
  type RuntimePluginConfigControlHostState,
  type RuntimePluginInventoryHostState,
} from '../builtin/plugin-management/index.ts';
import {
  confirmPreparedRuntimePluginToolResult,
  createRejectedToolCallResult,
  type RuntimePluginToolConfirmationHandler,
} from './tool-confirmation.ts';
import {
  createConfirmedRuntimePluginConfigUpdateLog,
  reloadRuntimePluginForCommittedConfig,
  type ConfirmedRuntimePluginConfigUpdateLog,
  type RuntimePluginConfigReloadHostResult,
  type RuntimePluginReloader,
} from './reload.ts';
import {
  createRuntimePluginInstanceOwnership,
  runtimePluginLifecycleTargets,
  type RuntimePluginInstanceOwnership,
  type RuntimePluginLifecycleTarget,
} from './instance-lifecycle.ts';
import {
  createPluginHookExecutionScope,
  errorMessage,
  PluginHookTimeoutError,
  snapshotPluginHookResult,
  withPluginHookTimeout,
  type PluginHookExecutionScope,
} from './hook-execution.ts';
import {runtimeIdentityMatchesContext} from '../api/identity.ts';

export {runtimePluginId} from '../api/contract.ts';

export type CreateRuntimePluginHostOptions = {
  readonly plugins?: readonly RuntimePlugin[];
  /** Catalog-authoritative ownership records for configured plugin instances. */
  readonly lifecycleTargets?: readonly RuntimePluginLifecycleTarget[];
  readonly enabledPluginIds?: readonly string[];
  /** Bundled-provenance ids the composition root cleared for trusted_context. */
  readonly trustedContextEligiblePluginIds?: readonly string[];
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionIdentity?: object | undefined;
  readonly pluginInventoryState?: RuntimePluginInventoryHostState;
  readonly pluginConfigControl?: RuntimePluginConfigControlHostState;
  readonly sessionHistory?: RuntimePluginSessionHistoryFeed;
  readonly pluginDatabase?: RuntimePluginDatabaseProvider;
  readonly toolConfirmationHandler?:
    RuntimePluginToolConfirmationHandler | undefined;
  readonly fileStore?: RuntimePluginFileStoreProvider;
  readonly pluginReloader?: RuntimePluginReloader;
  readonly constructionConfigFingerprint?: string;
};

export type RuntimePluginHookHostResult = {
  readonly status: 'completed' | 'completed_with_failures';
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
};

export type RuntimePluginSessionEndOptions = {
  readonly allowFileStoreWrites?: boolean;
};

type RunRuntimePluginTerminalHooksWithResolvedPermissionsOptions = {
  readonly context: RuntimePluginContext;
} & PluginHookCapabilityOptions & {
    readonly targets: readonly RuntimePluginLifecycleTarget[];
    readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  };

type RunRuntimePluginSessionEndHooksWithResolvedPermissionsOptions =
  RunRuntimePluginTerminalHooksWithResolvedPermissionsOptions & {
    readonly hookOptions?: RuntimePluginSessionEndOptions | undefined;
  };

type RunRuntimePluginShutdownHooksWithResolvedPermissionsOptions =
  RunRuntimePluginTerminalHooksWithResolvedPermissionsOptions;

export type RuntimePluginHealthHostResult = {
  readonly snapshots: readonly RuntimePluginHealthSnapshot[];
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
};

export type RuntimePluginHost = {
  registrySnapshot(): RuntimePluginRegistrySnapshot;
  enabledPluginIds(): readonly string[];
  pluginToolDefinitions(): readonly RoleModelPluginToolDefinition[];
  beforeRoleModelCall(
    context: RuntimePluginContext,
  ): Promise<RuntimePluginBeforeRoleModelCallHostResult>;
  handleToolCall(
    call: RuntimePluginToolCall,
    context: RuntimePluginContext,
  ): Promise<RuntimePluginToolCallExecutionResult>;
  reconcileConfigEffect(
    effect: PreparedRuntimePluginConfigEffect,
  ): RuntimePluginEvidenceSnapshot;
  /** Recovery skips a rebuild when the live instance reflects this config. */
  pluginConfigCurrentFor(pluginId: string, configFingerprint: string): boolean;
  reloadPluginForCommittedConfig(
    effects: readonly PreparedRuntimePluginConfigEffect[],
    reloadOptions?: {
      /** Authored fingerprint after ALL of the turn's accepted effects. */
      readonly turnResultFingerprint?: string;
    },
  ): Promise<RuntimePluginConfigReloadHostResult>;
  afterTurnCommitted(
    context: RuntimePluginAfterTurnCommittedContext,
  ): Promise<RuntimePluginHookHostResult>;
  onSessionEnd(
    context: RuntimePluginContext,
    options?: RuntimePluginSessionEndOptions,
  ): Promise<RuntimePluginHookHostResult>;
  shutdown(context: RuntimePluginContext): Promise<RuntimePluginHookHostResult>;
  health(context: RuntimePluginContext): Promise<RuntimePluginHealthHostResult>;
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

type RuntimePluginHostState = {
  readonly sessionIdentity: object | undefined;
  readonly pluginConfigControl: RuntimePluginConfigControlHostState | undefined;
  readonly enabledIds: readonly string[];
  readonly enabledPlugins: readonly RuntimePlugin[];
  /** Identical to enabledPlugins until a live config reload swaps one. */
  readonly livePlugins: () => readonly RuntimePlugin[];
  /** Replaces the live instance sharing next's plugin id; pure list swap. */
  readonly swapEnabledPlugin: (
    next: RuntimePlugin,
  ) => RuntimePlugin | undefined;
  readonly recordLiveAppliedFingerprint: (
    pluginId: string,
    configFingerprint: string,
  ) => void;
  readonly liveAppliedFingerprintFor: (pluginId: string) => string | undefined;
  readonly confirmedConfigUpdates:
    ConfirmedRuntimePluginConfigUpdateLog | undefined;
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  readonly registrySnapshot: RuntimePluginRegistrySnapshot;
  readonly pluginToolDefinitions: readonly RoleModelPluginToolDefinition[];
};

export function createRuntimePluginHost(
  options: CreateRuntimePluginHostOptions = {},
): RuntimePluginHost {
  const {
    sessionIdentity,
    pluginConfigControl,
    enabledIds,
    enabledPlugins,
    livePlugins,
    swapEnabledPlugin,
    recordLiveAppliedFingerprint,
    liveAppliedFingerprintFor,
    confirmedConfigUpdates,
    accessByPluginId,
    registrySnapshot,
    pluginToolDefinitions,
  } = createRuntimePluginHostState(options);
  assertRuntimePluginFileStoreProviderPresent({
    enabledPlugins,
    accessByPluginId,
    hasFileStoreProvider: options.fileStore !== undefined,
  });
  let shutdownResult: Promise<RuntimePluginHookHostResult> | undefined;
  let terminalStarted = false;
  const catalogManifestForPluginId = lifecycleCatalogManifestResolver(
    lifecycleCatalogManifestByPluginId({
      enabledPlugins,
      configuredTargets: options.lifecycleTargets ?? [],
    }),
  );
  const instanceOwnership = createRuntimePluginInstanceOwnership({
    isLive: plugin => livePlugins().includes(plugin),
    swapEnabledPlugin,
    catalogManifestForPluginId,
  });

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
        plugins: livePlugins(),
        context,
        accessByPluginId,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        sessionIdentity,
        createFileStore: options.fileStore?.createFileStore,
        sessionHistory: options.sessionHistory,
        openPluginDatabase: options.pluginDatabase?.openPluginDatabase,
      });
    },
    async handleToolCall(call, context) {
      const result = await runHandleToolCall({
        plugins: livePlugins(),
        call,
        context,
        accessByPluginId,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        sessionIdentity,
        toolConfirmationHandler: options.toolConfirmationHandler,
        pluginConfigControl,
        createFileStore: options.fileStore?.createFileStore,
        sessionHistory: options.sessionHistory,
        openPluginDatabase: options.pluginDatabase?.openPluginDatabase,
      });

      // Settled results pass one choke point; turn log and commit agree.
      confirmedConfigUpdates?.note(result);
      return result;
    },
    reconcileConfigEffect(effect) {
      if (pluginConfigControl === undefined) {
        throw new Error(
          'Runtime plugin config reconciliation requires configured host control state.',
        );
      }

      return reconcilePreparedRuntimePluginConfigEffect({
        effect,
        state: pluginConfigControl,
      });
    },
    pluginConfigCurrentFor(pluginId, configFingerprint) {
      return (
        (liveAppliedFingerprintFor(pluginId) ??
          options.constructionConfigFingerprint) === configFingerprint
      );
    },
    async reloadPluginForCommittedConfig(effects, reloadOptions) {
      if (terminalStarted) {
        return Object.freeze({outcome: 'deferred'});
      }

      return await instanceOwnership.track(
        reloadRuntimePluginForCommittedConfig({
          effects,
          reloader: options.pluginReloader,
          pluginConfigControl,
          livePlugins,
          swapEnabledPlugin: instanceOwnership.replaceLive,
          retirePlugin: (plugin, catalogPluginId) => {
            instanceOwnership.retire(
              plugin,
              catalogManifestForPluginId(catalogPluginId),
            );
          },
          trackReloadWork: instanceOwnership.track,
          recordLiveAppliedFingerprint,
          ...(reloadOptions?.turnResultFingerprint === undefined
            ? {}
            : {turnResultFingerprint: reloadOptions.turnResultFingerprint}),
        }),
      );
    },
    async afterTurnCommitted(context) {
      const hookResult = await runHookPhase({
        targets: runtimePluginLifecycleTargets(
          livePlugins(),
          catalogManifestForPluginId,
        ),
        context,
        accessByPluginId,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        sessionIdentity,
        createFileStore: options.fileStore?.createFileStore,
        sessionHistory: options.sessionHistory,
        openPluginDatabase: options.pluginDatabase?.openPluginDatabase,
        hookName: 'afterTurnCommitted',
        evidenceKind: 'after_turn_committed',
        hookForPlugin: plugin => plugin.lifecycleHooks.afterTurnCommitted,
      });

      return Object.freeze({
        status: hookResult.status,
        evidence: hookResult.evidence,
      } satisfies RuntimePluginHookHostResult);
    },
    // A session's end is not the host's: a chat continues into its next
    // session with the same host, so reloads stay live; only shutdown is
    // terminal.
    async onSessionEnd(context, hookOptions) {
      await instanceOwnership.quiesce();

      return await runRuntimePluginSessionEndHooksForTargets({
        targets: instanceOwnership.sessionEndTargets(livePlugins()),
        context,
        accessByPluginId,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        sessionIdentity,
        createFileStore: options.fileStore?.createFileStore,
        sessionHistory: options.sessionHistory,
        openPluginDatabase: options.pluginDatabase?.openPluginDatabase,
        hookOptions,
      });
    },
    shutdown(context) {
      terminalStarted = true;
      shutdownResult ??= runFinalShutdownPhase({
        instanceOwnership,
        livePlugins,
        context,
        accessByPluginId,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        sessionIdentity,
        createFileStore: options.fileStore?.createFileStore,
        sessionHistory: options.sessionHistory,
        openPluginDatabase: options.pluginDatabase?.openPluginDatabase,
      });

      return shutdownResult;
    },
    async health(context) {
      return await runHealth({
        plugins: livePlugins(),
        context,
        accessByPluginId,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        sessionIdentity,
        createFileStore: options.fileStore?.createFileStore,
        sessionHistory: options.sessionHistory,
        openPluginDatabase: options.pluginDatabase?.openPluginDatabase,
      });
    },
  } satisfies RuntimePluginHost);
}

function createRuntimePluginHostState(
  options: CreateRuntimePluginHostOptions,
): RuntimePluginHostState {
  if (
    options.pluginInventoryState !== undefined &&
    options.pluginConfigControl !== undefined
  ) {
    throw new TypeError(
      'Runtime plugin inventory-only state and config-control state cannot both be supplied.',
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
          options.pluginConfigControl,
        );
  const pluginInventoryState =
    pluginConfigControl ??
    (options.pluginInventoryState === undefined
      ? undefined
      : createRuntimePluginInventoryHostStateSnapshot(
          options.pluginInventoryState,
        ));
  const confirmedConfigUpdates =
    pluginConfigControl === undefined
      ? undefined
      : createConfirmedRuntimePluginConfigUpdateLog({
          pluginManifests: pluginConfigControl.pluginManifests,
        });
  let allPlugins: readonly RuntimePlugin[] = [];
  let enabledPlugins: readonly RuntimePlugin[] = [];
  const liveAppliedFingerprintByPluginId = new Map<string, string>();
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
      liveReloadAvailable: options.pluginReloader !== undefined,
      ...(confirmedConfigUpdates === undefined
        ? {}
        : {
            sessionScopedConfigUpdateConfirmed:
              confirmedConfigUpdates.sessionScopedConfirmed,
          }),
      ...(pluginInventoryState === undefined
        ? {}
        : {installedPluginManifests: pluginInventoryState.pluginManifests}),
      ...(pluginInventoryState?.activationByPluginId === undefined
        ? {}
        : {
            activationStates: Object.freeze(
              Object.entries(pluginInventoryState.activationByPluginId).map(
                ([pluginId, activation]) =>
                  Object.freeze({
                    pluginId,
                    activationStatus: activation.status,
                  }),
              ),
            ),
          }),
    }),
    ...(pluginConfigControl === undefined ? {} : {pluginConfigControl}),
  });
  const plugins = Object.freeze([...hostScopedPlugins, ...configuredPlugins]);
  allPlugins = plugins;
  const enabledIds = enabledPluginIdsForHost({
    plugins,
    enabledPluginIds: options.enabledPluginIds,
  });
  enabledPlugins = Object.freeze(
    plugins.filter(plugin => enabledIds.includes(plugin.manifest.id)),
  );
  accessByPluginId = resolveRuntimePluginAccessForPlugins({
    plugins,
    enabledPluginIds: enabledIds,
    trustedContextEligiblePluginIds: new Set(
      options.trustedContextEligiblePluginIds ?? [],
    ),
  });
  const registrySnapshot = createRuntimePluginRegistrySnapshot(plugins, {
    accessByPluginId,
  });
  const pluginToolDefinitions = createRoleModelPluginToolDefinitions(
    pluginToolDefinitionsForEnabledPlugins({
      plugins: enabledPlugins,
      accessByPluginId,
      confirmationAvailable:
        options.toolConfirmationHandler !== undefined &&
        pluginConfigControl !== undefined,
    }),
  );

  return Object.freeze({
    sessionIdentity,
    pluginConfigControl,
    enabledIds,
    enabledPlugins,
    confirmedConfigUpdates,
    livePlugins: () => enabledPlugins,
    swapEnabledPlugin: next => {
      const previous = enabledPlugins.find(
        plugin => plugin.manifest.id === next.manifest.id,
      );

      if (previous === undefined) {
        return undefined;
      }

      enabledPlugins = Object.freeze(
        enabledPlugins.map(plugin => (plugin === previous ? next : plugin)),
      );
      allPlugins = Object.freeze(
        allPlugins.map(plugin => (plugin === previous ? next : plugin)),
      );
      return previous;
    },
    recordLiveAppliedFingerprint: (pluginId, configFingerprint) => {
      liveAppliedFingerprintByPluginId.set(pluginId, configFingerprint);
    },
    liveAppliedFingerprintFor: pluginId =>
      liveAppliedFingerprintByPluginId.get(pluginId),
    accessByPluginId,
    registrySnapshot,
    pluginToolDefinitions,
  } satisfies RuntimePluginHostState);
}

function lifecycleCatalogManifestByPluginId(options: {
  readonly enabledPlugins: readonly RuntimePlugin[];
  readonly configuredTargets: readonly RuntimePluginLifecycleTarget[];
}): ReadonlyMap<string, RuntimePluginManifest> {
  const manifests = new Map(
    options.enabledPlugins.map(
      plugin => [plugin.manifest.id, plugin.manifest] as const,
    ),
  );

  for (const target of options.configuredTargets) {
    if (!options.enabledPlugins.includes(target.plugin)) {
      throw new TypeError(
        `Plugin "${target.catalogManifest.id}" lifecycle target is not enabled in this host.`,
      );
    }

    if (target.catalogManifest.id !== target.plugin.manifest.id) {
      throw new TypeError(
        `Plugin "${target.plugin.manifest.id}" lifecycle target must match catalog "${target.catalogManifest.id}".`,
      );
    }

    manifests.set(target.catalogManifest.id, target.catalogManifest);
  }

  return manifests;
}

function lifecycleCatalogManifestResolver(
  manifests: ReadonlyMap<string, RuntimePluginManifest>,
): (pluginId: string) => RuntimePluginManifest {
  return pluginId => {
    const manifest = manifests.get(pluginId);

    if (manifest === undefined) {
      throw new TypeError(
        `Plugin "${pluginId}" is missing its catalog lifecycle manifest.`,
      );
    }

    return manifest;
  };
}

export async function runRuntimePluginSessionEndHooksForTargets(
  options: RunRuntimePluginSessionEndHooksWithResolvedPermissionsOptions,
): Promise<RuntimePluginHookHostResult> {
  return await runHookPhase({
    targets: options.targets,
    context: options.context,
    accessByPluginId: options.accessByPluginId,
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    sessionIdentity: options.sessionIdentity,
    createFileStore: options.createFileStore,
    sessionHistory: options.sessionHistory,
    openPluginDatabase: options.openPluginDatabase,
    allowFileStoreWrites: options.hookOptions?.allowFileStoreWrites,
    hookName: 'onSessionEnd',
    evidenceKind: 'session_end',
    hookForPlugin: plugin => plugin.lifecycleHooks.onSessionEnd,
  });
}

/** Quiescing is bounded, so late reload candidates are torn down on arrival. */
async function runFinalShutdownPhase(
  options: Omit<
    RunRuntimePluginShutdownHooksWithResolvedPermissionsOptions,
    'targets'
  > & {
    readonly instanceOwnership: RuntimePluginInstanceOwnership;
    readonly livePlugins: () => readonly RuntimePlugin[];
  },
): Promise<RuntimePluginHookHostResult> {
  await options.instanceOwnership.quiesce();

  const dispatch = async (
    targets: readonly RuntimePluginLifecycleTarget[],
  ): Promise<RuntimePluginHookHostResult> =>
    await runRuntimePluginShutdownHooksForTargets({...options, targets});

  options.instanceOwnership.close(target => {
    void dispatch([target]);
  });

  return await dispatch(
    options.instanceOwnership.terminalTargets(options.livePlugins()),
  );
}

export async function runRuntimePluginShutdownHooksForTargets(
  options: RunRuntimePluginShutdownHooksWithResolvedPermissionsOptions,
): Promise<RuntimePluginHookHostResult> {
  return await runHookPhase({
    targets: options.targets,
    context: options.context,
    accessByPluginId: options.accessByPluginId,
    storeRoot: options.storeRoot,
    sessionId: options.sessionId,
    sessionIdentity: options.sessionIdentity,
    createFileStore: options.createFileStore,
    sessionHistory: options.sessionHistory,
    openPluginDatabase: options.openPluginDatabase,
    allowFileStoreWrites: false,
    hookName: 'onShutdown',
    evidenceKind: 'shutdown',
    hookForPlugin: plugin => plugin.lifecycleHooks.onShutdown,
  });
}

type HandleToolCallOptions = {
  readonly plugins: readonly RuntimePlugin[];
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
} & PluginHookCapabilityOptions & {
    readonly toolConfirmationHandler?:
      RuntimePluginToolConfirmationHandler | undefined;
    readonly pluginConfigControl?:
      RuntimePluginConfigControlHostState | undefined;
  };

type ResolvedRuntimePluginToolExecution = {
  readonly status: 'resolved';
  readonly plugin: RuntimePlugin;
  readonly providedTool: RuntimePluginProvidedTool;
  readonly hook: NonNullable<RuntimePlugin['lifecycleHooks']['handleToolCall']>;
  readonly access: ReturnType<typeof runtimePluginAccessForPlugin>;
  readonly failureDegrades: boolean;
  readonly approvalGatedTool: boolean;
  /** Host-validated tools get the exact input snapshot validation accepted. */
  readonly call: RuntimePluginToolCall;
};

type RuntimePluginToolExecutionResolution =
  ResolvedRuntimePluginToolExecution | RejectedRuntimePluginToolExecution;

type RejectedRuntimePluginToolExecution = {
  readonly status: 'rejected';
  readonly result: RuntimePluginToolCallExecutionResult;
};

async function runHandleToolCall(
  options: HandleToolCallOptions,
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
    approvalGatedTool,
    call,
  } = resolution;
  const executionScope = createPluginHookExecutionScope(plugin.manifest);

  try {
    // Inside the guarded region: opening a durable store takes its
    // mutation lease, and a lease this call cannot get must reach the
    // caller as this hook's failure policy, not as a thrown host error.
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
    const result = await withPluginHookTimeout({
      pluginId: plugin.manifest.id,
      policyManifest: plugin.manifest,
      hookName: 'handleToolCall',
      executionScope,
      revokeFileStoreWrites: hookContext.revokeFileStoreWrites,
      operation: async deadlineAt =>
        normalizeToolCallResult({
          plugin,
          providedTool,
          context: hookContext.context,
          value: await hook(call, hookContext.context),
          deadlineAt,
        }),
    });

    if (!approvalGatedTool || result.status === 'rejected') {
      return result;
    }

    if (
      options.toolConfirmationHandler === undefined ||
      options.pluginConfigControl === undefined
    ) {
      throw new TypeError(
        'Approval-gated plugin tool lost its host approval state.',
      );
    }

    return await confirmPreparedRuntimePluginToolResult({
      plugin,
      providedTool,
      call,
      context: options.context,
      result,
      confirmationHandler: options.toolConfirmationHandler,
      pluginConfigControl: options.pluginConfigControl,
      ...(options.storeRoot === undefined
        ? {}
        : {storeRoot: options.storeRoot}),
    });
  } catch (error: unknown) {
    if (error instanceof PluginHookTimeoutError) {
      return createRejectedToolCallResult({
        call,
        context: options.context,
        reason: 'handler_timeout',
        message: error.message,
        evidenceStatus: failureDegrades ? 'degraded' : 'failed',
        policyOutcome: 'timeout',
      });
    }

    return createRejectedToolCallResult({
      call,
      context: options.context,
      reason: 'handler_failed',
      message: errorMessage(error),
      evidenceStatus: failureDegrades ? 'degraded' : 'rejected',
      policyOutcome: failureDegrades ? 'optional_degraded' : 'handler_rejected',
    });
  }
}

function resolveRuntimePluginToolExecution(
  options: HandleToolCallOptions,
): RuntimePluginToolExecutionResolution {
  if (!runtimeIdentityMatchesContext(options.call, options.context)) {
    return rejectedRuntimePluginToolExecution({
      call: options.call,
      context: options.context,
      reason: 'tool_call_identity_mismatch',
      message: 'Tool call identity must match current runtime event identity.',
    });
  }

  const plugin = options.plugins.find(
    candidate => candidate.manifest.id === options.call.pluginId,
  );

  if (plugin === undefined) {
    return rejectedRuntimePluginToolExecution({
      call: options.call,
      context: options.context,
      reason: 'plugin_not_enabled',
      message: `Plugin "${options.call.pluginId}" is not enabled for this turn.`,
    });
  }

  const providedTool = plugin.providedTools.find(
    tool => tool.name === options.call.toolName,
  );

  if (providedTool === undefined) {
    return rejectedRuntimePluginToolExecution({
      call: options.call,
      context: options.context,
      reason: 'tool_not_declared',
      message: `Plugin "${plugin.manifest.id}" did not declare tool "${options.call.toolName}".`,
    });
  }

  const hook = plugin.lifecycleHooks.handleToolCall;
  const failureDegrades = handleToolCallFailureDegrades({
    plugin,
    providedTool,
  });
  const access = runtimePluginAccessForPlugin({
    plugin,
    accessByPluginId: options.accessByPluginId,
  });
  const policyRejection = rejectedRuntimePluginToolPolicy({
    plugin,
    providedTool,
    hook,
    access,
    failureDegrades,
    call: options.call,
    context: options.context,
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
    failureDegrades,
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
  const modelFacing = isModelFacingRuntimePluginTool(options.providedTool);

  if (modelFacing && !pluginCanWriteModelInput(options.access)) {
    return rejectedRuntimePluginToolExecution({
      call: options.call,
      context: options.context,
      reason: 'model_input_not_granted',
      message: `Plugin "${options.plugin.manifest.id}" did not declare model_input write access for model-facing tool "${options.providedTool.name}".`,
      evidenceStatus: options.failureDegrades ? 'degraded' : 'rejected',
      policyOutcome: options.failureDegrades
        ? 'optional_degraded'
        : 'disallowed_tool_call',
    });
  }

  if (
    options.hook !== undefined &&
    !routableModelFacingPluginTools({
      plugin: options.plugin,
      access: options.access,
    }).some(tool => tool.name === options.providedTool.name)
  ) {
    return rejectedRuntimePluginToolExecution({
      call: options.call,
      context: options.context,
      reason: 'tool_not_routable',
      message: `Plugin "${options.plugin.manifest.id}" tool "${options.providedTool.name}" is not routable for model execution under current plugin policy.`,
      evidenceStatus: 'rejected',
      policyOutcome: 'disallowed_tool_call',
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
  const {plugin, providedTool, hook, access, failureDegrades} = options;

  const inputValidation =
    providedTool.validationOwner === 'plugin_host'
      ? validateModelToolInputAgainstContract({
          toolName: options.options.call.toolName,
          input: options.options.call.input,
          inputContract: providedTool.inputContract,
        })
      : undefined;

  if (inputValidation?.status === 'rejected') {
    return rejectedRuntimePluginToolExecution({
      call: options.options.call,
      context: options.options.context,
      reason: 'invalid_input',
      message: inputValidation.details,
      evidenceStatus: failureDegrades ? 'degraded' : 'rejected',
      policyOutcome: failureDegrades ? 'optional_degraded' : 'handler_rejected',
    });
  }

  if (hook === undefined) {
    return rejectedRuntimePluginToolExecution({
      call: options.options.call,
      context: options.options.context,
      reason: 'handler_missing',
      message: `Plugin "${plugin.manifest.id}" has no handleToolCall hook.`,
      evidenceStatus: failureDegrades ? 'degraded' : 'rejected',
      policyOutcome: failureDegrades ? 'optional_degraded' : 'handler_rejected',
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
      policyOutcome: 'disallowed_tool_call',
    });
  }

  return Object.freeze({
    status: 'resolved',
    plugin,
    providedTool,
    hook,
    access,
    failureDegrades,
    approvalGatedTool,
    call:
      inputValidation === undefined
        ? options.options.call
        : Object.freeze({
            ...options.options.call,
            input: inputValidation.input,
          } satisfies RuntimePluginToolCall),
  } satisfies ResolvedRuntimePluginToolExecution);
}

function rejectedRuntimePluginToolExecution(
  options: Parameters<typeof createRejectedToolCallResult>[0],
): RejectedRuntimePluginToolExecution {
  return Object.freeze({
    status: 'rejected',
    result: createRejectedToolCallResult(options),
  });
}

async function runHookPhase<TContext extends RuntimePluginContext>(
  options: {
    readonly targets: readonly RuntimePluginLifecycleTarget[];
    readonly context: TContext;
    readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  } & PluginHookCapabilityOptions & {
      readonly hookName: 'afterTurnCommitted' | 'onSessionEnd' | 'onShutdown';
      readonly evidenceKind: Extract<
        RuntimePluginEvidenceKind,
        'after_turn_committed' | 'session_end' | 'shutdown'
      >;
      readonly allowFileStoreWrites?: boolean | undefined;
      readonly hookForPlugin: (
        plugin: RuntimePlugin,
      ) =>
        | ((
            context: TContext,
          ) => RuntimePluginHookResult | Promise<RuntimePluginHookResult>)
        | undefined;
    },
): Promise<RuntimePluginHookHostResult> {
  const evidence: RuntimePluginEvidenceSnapshot[] = [];
  let failed = false;

  for (const {plugin, catalogManifest} of options.targets) {
    const catalogPluginId = catalogManifest.id;
    const hook = options.hookForPlugin(plugin);

    if (hook === undefined) {
      continue;
    }

    const executionScope = createPluginHookExecutionScope(catalogManifest);
    const result = await invokeHook({
      plugin,
      pluginId: catalogPluginId,
      policyManifest: catalogManifest,
      executionScope,
      createHookContext: () =>
        createPluginHookContext({
          context: options.context,
          plugin,
          pluginId: catalogPluginId,
          deadlineAt: executionScope.deadlineAt,
          signal: executionScope.abortController.signal,
          access: runtimePluginAccessForPluginId({
            pluginId: catalogPluginId,
            accessByPluginId: options.accessByPluginId,
          }),
          storeRoot: options.storeRoot,
          sessionId: options.sessionId,
          sessionIdentity: options.sessionIdentity,
          createFileStore: options.createFileStore,
          sessionHistory: options.sessionHistory,
          openPluginDatabase: options.openPluginDatabase,
          allowFileStoreWrites: options.allowFileStoreWrites,
        }),
      hookName: options.hookName,
      hook,
    });

    if (result.status === 'failed') {
      failed = true;
      evidence.push(
        createHookFailureEvidence({
          plugin,
          policyManifest: catalogManifest,
          pluginId: catalogPluginId,
          context: options.context,
          evidenceKind: options.evidenceKind,
          status: 'failed',
          summary: `${options.hookName} plugin hook failed: ${result.message}`,
          ...failurePolicyOutcomeOption(
            options.evidenceKind,
            result.failureKind,
          ),
        }),
      );
      continue;
    }

    evidence.push(...result.value.evidence);

    if (result.value.status === 'failed') {
      failed = true;

      if (
        !hookEvidenceRecordsFailure({
          evidence: result.value.evidence,
          evidenceKind: options.evidenceKind,
        })
      ) {
        evidence.push(
          createHookFailureEvidence({
            plugin,
            policyManifest: catalogManifest,
            pluginId: catalogPluginId,
            context: options.context,
            evidenceKind: options.evidenceKind,
            status: 'failed',
            summary: `${options.hookName} plugin hook reported failure.`,
            ...failurePolicyOutcomeOption(options.evidenceKind, 'exception'),
          }),
        );
      }
    }
  }

  return Object.freeze({
    status: failed ? 'completed_with_failures' : 'completed',
    evidence: Object.freeze([...evidence]),
  } satisfies RuntimePluginHookHostResult);
}

function hookEvidenceRecordsFailure(options: {
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
  readonly evidenceKind: Extract<
    RuntimePluginEvidenceKind,
    'after_turn_committed' | 'session_end' | 'shutdown'
  >;
}): boolean {
  return evidenceRecordsStatus({
    evidence: options.evidence,
    evidenceKind: options.evidenceKind,
    statuses: ['failed'],
  });
}

function evidenceRecordsStatus(options: {
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
  readonly evidenceKind: RuntimePluginEvidenceKind;
  readonly statuses: readonly RuntimePluginEvidenceStatus[];
}): boolean {
  return options.evidence.some(
    item =>
      item.evidenceKind === options.evidenceKind &&
      options.statuses.includes(item.status),
  );
}

function evidenceRecordsToolInvocationDegrade(
  evidence: readonly RuntimePluginEvidenceSnapshot[],
): boolean {
  return evidence.some(
    item =>
      item.evidenceKind === 'tool_invocation' &&
      (item.status === 'degraded' ||
        item.policyOutcome === 'optional_degraded'),
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
    pluginId: options.plugin.manifest.id,
    policyManifest: options.plugin.manifest,
    hookName: 'handleToolCall',
    value: options.value,
    deadlineAt: options.deadlineAt,
  });

  if (!isRecord(value)) {
    throw new TypeError('Plugin tool result must be an object.');
  }

  const status = value['status'];

  if (status === 'accepted') {
    const evidence = normalizeEvidenceSnapshots({
      plugin: options.plugin,
      context: options.context,
      value: value['evidence'],
    });

    if (evidence.some(runtimePluginEvidenceBlocksToolInvocation)) {
      return Object.freeze({
        status: 'rejected',
        reason: 'blocking_tool_invocation_evidence',
        message: `Plugin "${options.plugin.manifest.id}" tool "${options.providedTool.name}" accepted result included blocking tool invocation evidence.`,
        evidence,
      } satisfies RuntimePluginToolCallResult);
    }

    const approvalGatedTool = isApprovalGatedRuntimePluginTool(
      options.providedTool,
    );
    const preparedConfigEffect = normalizePreparedRuntimePluginConfigEffect({
      providedTool: options.providedTool,
      approvalGatedTool,
      context: options.context,
      value: value['preparedConfigEffect'],
    });

    if (approvalGatedTool && preparedConfigEffect === undefined) {
      // No staged effect means the tool already acted, so asking is too late.
      throw new TypeError(
        `Tool "${options.providedTool.name}" sets requiresConfirmation but prepared no effect to confirm. A confirmable tool stages its effect as preparedConfigEffect and applies nothing until the user approves.`,
      );
    }

    const result = createRuntimePluginToolCallResultSnapshot({
      status: 'accepted',
      output: normalizeJsonValue(value['output'], {
        plugin: options.plugin,
        deadlineAt: options.deadlineAt,
      }),
      evidence,
    });

    if (result.status !== 'accepted') {
      throw new TypeError('Accepted plugin tool result normalization failed.');
    }

    if (preparedConfigEffect === undefined) {
      return result;
    }

    return Object.freeze({
      ...result,
      preparedConfigEffect,
    } satisfies RuntimePluginToolCallExecutionResult);
  }

  if (status === 'rejected') {
    if (value['preparedConfigEffect'] !== undefined) {
      throw new TypeError(
        'Rejected plugin tool results cannot include a prepared config effect.',
      );
    }
    const reason = value['reason'];
    const message = value['message'];

    if (typeof reason !== 'string' || typeof message !== 'string') {
      throw new TypeError(
        'Plugin rejected tool result must include reason and message.',
      );
    }

    if (reason.trim().length === 0 || message.trim().length === 0) {
      throw new TypeError(
        'Plugin rejected tool result reason and message must be non-empty.',
      );
    }

    const redactedMessage = message;
    const evidence = normalizeEvidenceSnapshots({
      plugin: options.plugin,
      context: options.context,
      value: value['evidence'],
    });
    const failureDegrades = handleToolCallFailureDegrades({
      plugin: options.plugin,
      providedTool: options.providedTool,
    });
    const evidenceAlreadyExplainsRejectedResult =
      evidenceRecordsStatus({
        evidence,
        evidenceKind: 'tool_invocation',
        statuses: ['rejected', 'failed'],
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
              : 'handler_rejected',
          }),
        ]);

    return createRuntimePluginToolCallResultSnapshot({
      status: 'rejected',
      reason,
      message: redactedMessage,
      evidence: evidenceWithFallback,
    });
  }

  throw new TypeError('Plugin tool result status is not supported.');
}

function normalizeJsonValue(
  value: unknown,
  options: {
    readonly plugin: RuntimePlugin;
    readonly deadlineAt?: number | undefined;
  },
): RuntimePluginJsonValue {
  try {
    return createJsonBoundarySnapshot(value, {
      field: 'Plugin tool output',
      redact: true,
      deadlineAt: options.deadlineAt,
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
          timeoutMs: options.plugin.manifest.runtimePolicy.timeoutMs,
        },
        {cause: error},
      );
    }

    throw error;
  }
}

async function runHealth(
  options: {
    readonly plugins: readonly RuntimePlugin[];
    readonly context: RuntimePluginContext;
    readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  } & PluginHookCapabilityOptions & {},
): Promise<RuntimePluginHealthHostResult> {
  const snapshots: RuntimePluginHealthSnapshot[] = [];
  const evidence: RuntimePluginEvidenceSnapshot[] = [];

  for (const plugin of options.plugins) {
    const hook = plugin.lifecycleHooks.health;

    if (hook === undefined) {
      continue;
    }

    const executionScope = createPluginHookExecutionScope(plugin.manifest);

    try {
      const hookContext = createPluginHookContext({
        context: options.context,
        plugin,
        deadlineAt: executionScope.deadlineAt,
        signal: executionScope.abortController.signal,
        access: runtimePluginAccessForPlugin({
          plugin,
          accessByPluginId: options.accessByPluginId,
        }),
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        sessionIdentity: options.sessionIdentity,
        createFileStore: options.createFileStore,
        sessionHistory: options.sessionHistory,
        openPluginDatabase: options.openPluginDatabase,
      });
      const snapshot = await withPluginHookTimeout({
        pluginId: plugin.manifest.id,
        policyManifest: plugin.manifest,
        hookName: 'health',
        executionScope,
        revokeFileStoreWrites: hookContext.revokeFileStoreWrites,
        operation: async deadlineAt =>
          createRuntimePluginHealthSnapshot(
            snapshotPluginHookResult({
              pluginId: plugin.manifest.id,
              policyManifest: plugin.manifest,
              hookName: 'health',
              value: await hook(hookContext.context),
              deadlineAt,
            }),
          ),
      });

      assertSnapshotPluginId({
        plugin,
        actualPluginId: snapshot.pluginId,
        field: 'health.pluginId',
      });
      snapshots.push(snapshot);
      const healthEvidence = createHealthSnapshotEvidence({
        plugin,
        context: options.context,
        snapshot,
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
            context: options.context,
          }),
        }),
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
          policyOutcome,
        }),
      );
    }
  }

  return Object.freeze({
    snapshots: Object.freeze([...snapshots]),
    evidence: Object.freeze([...evidence]),
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
    policyOutcome: 'health_degraded',
  });
}

function healthSnapshotEvidenceStatus(options: {
  readonly plugin: RuntimePlugin;
  readonly snapshot: RuntimePluginHealthSnapshot;
}): RuntimePluginEvidenceStatus {
  if (
    options.snapshot.status === 'unavailable' &&
    options.plugin.manifest.runtimePolicy.failureBehavior.health ===
      'reject_turn'
  ) {
    return 'failed';
  }

  return 'degraded';
}

async function invokeHook<TContext extends RuntimePluginContext>(options: {
  readonly plugin: RuntimePlugin;
  readonly pluginId: string;
  readonly policyManifest: RuntimePluginManifest;
  readonly executionScope: PluginHookExecutionScope;
  /**
   * Built here rather than by the caller: opening a durable store takes
   * its mutation lease, and a lease this hook cannot get must travel the
   * hook's failure policy like any other failure.
   */
  readonly createHookContext: () => {
    readonly context: TContext;
    readonly revokeFileStoreWrites: () => void;
  };
  readonly hookName: 'afterTurnCommitted' | 'onSessionEnd' | 'onShutdown';
  readonly hook: (
    context: TContext,
  ) => RuntimePluginHookResult | Promise<RuntimePluginHookResult>;
}): Promise<HookInvocationResult> {
  try {
    const hookContext = options.createHookContext();

    return Object.freeze({
      status: 'accepted',
      value: await withPluginHookTimeout({
        policyManifest: options.policyManifest,
        pluginId: options.pluginId,
        hookName: options.hookName,
        executionScope: options.executionScope,
        revokeFileStoreWrites: hookContext.revokeFileStoreWrites,
        operation: async deadlineAt =>
          normalizeHookResult({
            plugin: options.plugin,
            pluginId: options.pluginId,
            policyManifest: options.policyManifest,
            context: hookContext.context,
            value: await options.hook(hookContext.context),
            deadlineAt,
            hookName: options.hookName,
          }),
      }),
    } satisfies HookInvocationResult);
  } catch (error: unknown) {
    return Object.freeze({
      status: 'failed',
      message: errorMessage(error),
      failureKind:
        error instanceof PluginHookTimeoutError ? 'timeout' : 'exception',
    } satisfies HookInvocationResult);
  }
}

function normalizeHookResult(options: {
  readonly plugin: RuntimePlugin;
  readonly pluginId: string;
  readonly policyManifest: RuntimePluginManifest;
  readonly context: RuntimePluginContext;
  readonly value: unknown;
  readonly deadlineAt: number;
  readonly hookName: 'afterTurnCommitted' | 'onSessionEnd' | 'onShutdown';
}): RuntimePluginHookResult {
  const value = snapshotPluginHookResult({
    pluginId: options.pluginId,
    policyManifest: options.policyManifest,
    hookName: options.hookName,
    value: options.value,
    deadlineAt: options.deadlineAt,
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
      pluginId: options.pluginId,
      context: options.context,
      value: value['evidence'],
    }),
  } satisfies RuntimePluginHookResult);
}

function assertNoCallerSuppliedHostScopedFirstPartyPlugins(
  plugins: readonly RuntimePlugin[],
): void {
  for (const plugin of plugins) {
    if (isHostScopedFirstPartyRuntimePluginId(plugin.manifest.id)) {
      throw new TypeError(
        `Plugin "${plugin.manifest.id}" is host-owned and cannot be supplied by callers.`,
      );
    }
  }
}

function handleToolCallFailureDegrades(options: {
  readonly plugin: RuntimePlugin;
  readonly providedTool: RuntimePluginProvidedTool;
}): boolean {
  return (
    options.plugin.manifest.runtimePolicy.failureBehavior.handleToolCall ===
    'degrade'
  );
}
