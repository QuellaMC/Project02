import {
  runtimePluginContractVersion,
  createRuntimePlugin,
  createRuntimePluginContextItem,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginHealthSnapshot,
  createRuntimePluginRegistrySnapshot,
  redactRuntimePluginText
} from './types.ts';
import type {
  RuntimePlugin,
  RuntimePluginBeforeRoleModelCallResult,
  RuntimePluginContextItem,
  RuntimePluginEvidenceKind,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginEvidenceStatus,
  RuntimePluginHealthSnapshot,
  RuntimePluginHookResult,
  RuntimePluginJsonObject,
  RuntimePluginJsonValue,
  RuntimePluginProvidedTool,
  RuntimePluginToolCall,
  RuntimePluginToolCallResult,
  RuntimePluginPolicyOutcome,
  RuntimePluginRegistrySnapshot,
  RuntimePluginSourceReference,
  RuntimePluginAfterTurnCommittedContext,
  RuntimePluginContext
} from './types.ts';
import {
  isBuiltInModelToolName,
  validateModelToolInputAgainstContract
} from '../role-model/model-tools.ts';
import {
  createRoleModelPluginToolDefinitions,
  roleModelPluginListToolName,
  type RoleModelPluginToolDefinition
} from '../role-model/contracts.ts';
import { createCharacterStatePlugin } from './builtin/character-state/index.ts';
import { createRuntimePluginFileStore } from './file-store.ts';

export const runtimePluginBeforeRoleModelCallRejectionReason =
  'plugin_before_role_model_call_rejected';
export const runtimePluginDiscoveryPluginId =
  'runtime.plugin_discovery';

const runtimePluginDiscoveryMaxPlugins = 16;
const runtimePluginDiscoveryMaxToolsPerPlugin = 8;
const runtimePluginDiscoveryMaxTextLength = 160;

export type RuntimePluginBeforeRoleModelCallRejectionReason =
  typeof runtimePluginBeforeRoleModelCallRejectionReason;

export type CreateRuntimePluginHostOptions = {
  readonly plugins?: readonly RuntimePlugin[];
  readonly enabledPluginIds?: readonly string[];
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
};

export type RuntimePluginBeforeRoleModelCallCompletedResult = {
  readonly status: 'completed';
  readonly contextItems: readonly RuntimePluginContextItem[];
  readonly runtimeNotes: readonly string[];
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

export type RuntimePluginHealthHostResult = {
  readonly snapshots: readonly RuntimePluginHealthSnapshot[];
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
};

const runtimePluginContextEstimatedTokenBudget = 256;

export type RuntimePluginHost = {
  registrySnapshot(): RuntimePluginRegistrySnapshot;
  enabledPluginIds(): readonly string[];
  pluginToolDefinitions(): readonly RoleModelPluginToolDefinition[];
  resolveToolPluginId(toolName: string): string | undefined;
  beforeRoleModelCall(
    context: RuntimePluginContext
  ): Promise<RuntimePluginBeforeRoleModelCallHostResult>;
  handleToolCall(
    call: RuntimePluginToolCall,
    context: RuntimePluginContext
  ): Promise<RuntimePluginToolCallResult>;
  afterTurnCommitted(
    context: RuntimePluginAfterTurnCommittedContext
  ): Promise<RuntimePluginHookHostResult>;
  onSessionEnd(
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
  readonly originalIndex: number;
};

type BoundedPluginContextItemsResult =
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

export function createRuntimePluginHost(
  options: CreateRuntimePluginHostOptions = {}
): RuntimePluginHost {
  const configuredPlugins = Object.freeze([...(options.plugins ?? [])]);
  let enabledPlugins: readonly RuntimePlugin[] = [];
  const plugins = Object.freeze([
    createRuntimePluginDiscoveryPlugin(() => enabledPlugins),
    ...configuredPlugins
  ]);
  const registrySnapshot = createRuntimePluginRegistrySnapshot(plugins);
  const enabledIds = enabledPluginIdsForHost({
    plugins,
    enabledPluginIds: options.enabledPluginIds
  });
  enabledPlugins = Object.freeze(
    plugins.filter((plugin) => enabledIds.includes(plugin.manifest.id))
  );
  const pluginToolDefinitions = createRoleModelPluginToolDefinitions(
    pluginToolDefinitionsForEnabledPlugins(enabledPlugins)
  );

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
    resolveToolPluginId(toolName) {
      return enabledPlugins.find((plugin) =>
        plugin.providedTools.some((tool) => tool.name === toolName)
      )?.manifest.id;
    },
    async beforeRoleModelCall(context) {
      return await runBeforeRoleModelCall({
        plugins: enabledPlugins,
        context,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId
      });
    },
    async handleToolCall(call, context) {
      return await runHandleToolCall({
        plugins: enabledPlugins,
        call,
        context,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId
      });
    },
    async afterTurnCommitted(context) {
      return await runHookPhase({
        plugins: enabledPlugins,
        context,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        hookName: 'afterTurnCommitted',
        evidenceKind: 'after_turn_committed',
        hookForPlugin: (plugin) =>
          plugin.lifecycleHooks.afterTurnCommitted
      });
    },
    async onSessionEnd(context) {
      return await runHookPhase({
        plugins: enabledPlugins,
        context,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId,
        hookName: 'onSessionEnd',
        evidenceKind: 'session_end',
        hookForPlugin: (plugin) => plugin.lifecycleHooks.onSessionEnd
      });
    },
    async health(context) {
      return await runHealth({
        plugins: enabledPlugins,
        context,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId
      });
    }
  } satisfies RuntimePluginHost);
}

export function createDefaultProject02PluginHost(
  options: Omit<CreateRuntimePluginHostOptions, 'plugins'> = {}
): RuntimePluginHost {
  return createRuntimePluginHost({
    ...options,
    plugins: [createCharacterStatePlugin()]
  });
}

function createPluginHookContext<TContext extends RuntimePluginContext>(options: {
  readonly context: TContext;
  readonly plugin: RuntimePlugin;
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
}): TContext {
  const grantsFileStore = options.plugin.manifest.requestedApis.includes('file_store');
  const sessionId = options.sessionId ?? options.context.sessionId;
  const context = Object.freeze({
    ...options.context,
    pluginId: options.plugin.manifest.id,
    ...(grantsFileStore
      ? {
          fileStore: createRuntimePluginFileStore({
            ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
            sessionId,
            pluginId: options.plugin.manifest.id
          })
        }
      : {})
  });

  return context;
}

function createRuntimePluginDiscoveryPlugin(
  enabledPluginsForTurn: () => readonly RuntimePlugin[]
): RuntimePlugin {
  return createRuntimePlugin({
    manifest: {
      id: runtimePluginDiscoveryPluginId,
      displayName: 'Runtime plugin discovery',
      version: '1.0.0',
      kind: 'first_party',
      description:
        'Host-owned read-only plugin list for safe current-turn discovery.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'project02',
        externalContract: 'runtime_plugin_discovery'
      },
      declaredPlugins: ['tool_provider', 'handle_tool_call'],
      config: {
        fields: []
      },
      localTrustLevel: 'first_party',
      runtimePolicy: {
        requiredForTurn: false,
        sideEffectLevel: 'runtime_read',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'reject_tool_call',
          afterTurnCommitted: 'log_failure',
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: true,
        reasons: ['host_provided_current_turn_discovery']
      }
    },
    providedTools: [
      {
        name: roleModelPluginListToolName,
        description:
          'Return safe summaries for plugins available in the current turn.',
        requiredForUserTurn: false,
        maxCallsPerUserTurn: 1,
        inputContract: {
          type: 'object',
          fields: [],
          additionalFields: false
        },
        validationOwner: 'plugin_host',
        sideEffectLevel: 'runtime_read',
        requiresConfirmation: false,
        sourceReferencesRequired: false
      }
    ],
    lifecycleHooks: {
      handleToolCall(_call, context) {
        const output = createPluginDiscoveryOutput(
          enabledPluginsForTurn()
        );

        return {
          status: 'accepted',
          output,
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: runtimePluginDiscoveryPluginId,
              evidenceKind: 'tool_invocation',
              status: 'accepted',
              summary: `Returned ${String(
                output.plugins.length
              )} current-turn plugin summaries.`,
              redactionLabels: context.privacy.redactionLabels
            })
          ]
        };
      }
    }
  });
}

function createPluginDiscoveryOutput(
  enabledPlugins: readonly RuntimePlugin[]
): RuntimePluginJsonObject & {
  readonly plugins: readonly RuntimePluginJsonValue[];
} {
  const boundedPlugins = enabledPlugins.slice(
    0,
    runtimePluginDiscoveryMaxPlugins
  );

  return Object.freeze({
    plugins: Object.freeze(
      boundedPlugins.map(createPluginDiscoverySummary)
    ),
    truncated:
      enabledPlugins.length > runtimePluginDiscoveryMaxPlugins
  } satisfies RuntimePluginJsonObject & {
    readonly plugins: readonly RuntimePluginJsonValue[];
  });
}

function createPluginDiscoverySummary(
  plugin: RuntimePlugin
): RuntimePluginJsonObject {
  const discoverableTools = discoverableCurrentTurnPluginTools(plugin);
  const safeTools = discoverableTools
    .slice(0, runtimePluginDiscoveryMaxToolsPerPlugin)
    .map(createPluginDiscoveryToolSummary);

  return Object.freeze({
    id: boundedPluginDiscoveryText(plugin.manifest.id),
    displayName: boundedPluginDiscoveryText(plugin.manifest.displayName),
    kind: plugin.manifest.kind,
    availableForTurn: true,
    providedTools: Object.freeze(safeTools),
    toolsTruncated:
      discoverableTools.length > runtimePluginDiscoveryMaxToolsPerPlugin
  } satisfies RuntimePluginJsonObject);
}

function createPluginDiscoveryToolSummary(
  tool: RuntimePluginProvidedTool
): RuntimePluginJsonObject {
  return Object.freeze({
    name: boundedPluginDiscoveryText(tool.name),
    sideEffectLevel: tool.sideEffectLevel,
    requiredForUserTurn: tool.requiredForUserTurn,
    maxCallsPerUserTurn: tool.maxCallsPerUserTurn
  } satisfies RuntimePluginJsonObject);
}

function boundedPluginDiscoveryText(value: string): string {
  if (value.length <= runtimePluginDiscoveryMaxTextLength) {
    return value;
  }

  return `${value.slice(0, runtimePluginDiscoveryMaxTextLength - 3)}...`;
}

async function runBeforeRoleModelCall(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly context: RuntimePluginContext;
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
}): Promise<RuntimePluginBeforeRoleModelCallHostResult> {
  const contextItems: CollectedPluginContextItem[] = [];
  const runtimeNotes: string[] = [];
  const evidence: RuntimePluginEvidenceSnapshot[] = [];

  for (const plugin of options.plugins) {
    const hook = plugin.lifecycleHooks.beforeRoleModelCall;

    if (hook === undefined) {
      continue;
    }

    const result = await invokeBeforeRoleModelCallHook({
      plugin,
      context: createPluginHookContext({
        context: options.context,
        plugin,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId
      }),
      hook
    });

    if (result.status === 'accepted') {
      for (const contextItem of result.value.contextItems) {
        contextItems.push({
          plugin,
          item: contextItem,
          originalIndex: contextItems.length
        });
      }
      runtimeNotes.push(...result.value.runtimeNotes);
      evidence.push(...result.value.evidence);
      continue;
    }

    const rejectsTurn = beforeRoleModelFailureRejectsTurn(plugin);
    const policyOutcome =
      result.failureKind === 'timeout'
        ? 'timeout'
        : rejectsTurn
          ? 'required_rejected'
          : 'optional_degraded';
    const failureEvidence = createHookFailureEvidence({
      plugin,
      context: options.context,
      evidenceKind: 'before_role_model_call',
      status: rejectsTurn ? 'rejected' : 'degraded',
      summary: rejectsTurn
        ? `Required before-role-model plugin hook rejected the turn: ${result.message}`
        : `Optional before-role-model plugin hook degraded: ${result.message}`,
      policyOutcome
    });

    evidence.push(failureEvidence);

    if (rejectsTurn) {
      return Object.freeze({
        status: 'rejected',
        reason: runtimePluginBeforeRoleModelCallRejectionReason,
        pluginId: plugin.manifest.id,
        message: result.message,
        evidence: Object.freeze([...evidence])
      } satisfies RuntimePluginBeforeRoleModelCallHostResult);
    }
  }

  const boundedContext = boundPluginContextItems({
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
    runtimeNotes: Object.freeze([...runtimeNotes]),
    evidence: Object.freeze([...evidence])
  } satisfies RuntimePluginBeforeRoleModelCallHostResult);
}

async function runHandleToolCall(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
}): Promise<RuntimePluginToolCallResult> {
  const plugin = options.plugins.find(
    (candidate) => candidate.manifest.id === options.call.pluginId
  );

  if (plugin === undefined) {
    return createRejectedToolCallResult({
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
    return createRejectedToolCallResult({
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
  const hookContext = createPluginHookContext({
    context: options.context,
    plugin,
    storeRoot: options.storeRoot,
    sessionId: options.sessionId
  });
  const inputValidation =
    providedTool.validationOwner === 'plugin_host'
      ? validateModelToolInputAgainstContract({
          toolName: options.call.toolName,
          input: options.call.input,
          inputContract: providedTool.inputContract
        })
      : undefined;

  if (inputValidation?.status === 'rejected') {
    return createRejectedToolCallResult({
      call: options.call,
      context: hookContext,
      reason: 'invalid_input',
      message: inputValidation.details,
      evidenceStatus: 'rejected',
      policyOutcome: 'handler_rejected'
    });
  }

  if (hook === undefined) {
    return createRejectedToolCallResult({
      call: options.call,
      context: options.context,
      reason: 'handler_missing',
      message: `Plugin "${plugin.manifest.id}" has no handleToolCall hook.`,
      evidenceStatus: failureDegrades ? 'degraded' : 'rejected',
      policyOutcome: failureDegrades ? 'optional_degraded' : 'handler_rejected'
    });
  }

  try {
    return normalizeToolCallResult({
      plugin,
      providedTool,
      context: hookContext,
      value: await withPluginHookTimeout({
        plugin,
        hookName: 'handleToolCall',
        operation: async () => await hook(options.call, hookContext)
      })
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

async function runHookPhase<TContext extends RuntimePluginContext>(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly context: TContext;
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly hookName: 'afterTurnCommitted' | 'onSessionEnd';
  readonly evidenceKind: Extract<RuntimePluginEvidenceKind, 'after_turn_committed' | 'session_end'>;
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

    const result = await invokeHook({
      plugin,
      context: createPluginHookContext({
        context: options.context,
        plugin,
        storeRoot: options.storeRoot,
        sessionId: options.sessionId
      }),
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
  readonly evidenceKind: Extract<RuntimePluginEvidenceKind, 'after_turn_committed' | 'session_end'>;
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

function pluginToolDefinitionsForEnabledPlugins(
  plugins: readonly RuntimePlugin[]
): readonly RoleModelPluginToolDefinition[] {
  return Object.freeze(
    plugins.flatMap((plugin) => {
      return routableModelFacingPluginTools(plugin).map((tool) =>
        Object.freeze({
          pluginId: plugin.manifest.id,
          ...tool
        } satisfies RoleModelPluginToolDefinition)
      );
    })
  );
}

function routableModelFacingPluginTools(
  plugin: RuntimePlugin
): readonly RuntimePluginProvidedTool[] {
  if (plugin.lifecycleHooks.handleToolCall === undefined) {
    return [];
  }

  return Object.freeze(plugin.providedTools.filter(isModelFacingPluginTool));
}

function discoverableCurrentTurnPluginTools(
  plugin: RuntimePlugin
): readonly RuntimePluginProvidedTool[] {
  return Object.freeze(
    plugin.providedTools.filter((tool) =>
      isDiscoverableCurrentTurnTool({ plugin, tool })
    )
  );
}

function isDiscoverableCurrentTurnTool(options: {
  readonly plugin: RuntimePlugin;
  readonly tool: RuntimePluginProvidedTool;
}): boolean {
  if (isModelFacingPluginTool(options.tool)) {
    return options.plugin.lifecycleHooks.handleToolCall !== undefined;
  }

  return isFirstPartyBuiltInModelTool(options);
}

function isFirstPartyBuiltInModelTool(options: {
  readonly plugin: RuntimePlugin;
  readonly tool: RuntimePluginProvidedTool;
}): boolean {
  return (
    options.plugin.manifest.localTrustLevel === 'first_party' &&
    options.tool.validationOwner === 'built_in_model_tools' &&
    isBuiltInModelToolName(options.tool.name) &&
    !options.tool.requiresConfirmation &&
    options.tool.sideEffectLevel === 'none'
  );
}

function isModelFacingPluginTool(tool: RuntimePluginProvidedTool): boolean {
  return (
    !isBuiltInModelToolName(tool.name) &&
    tool.validationOwner === 'plugin_host' &&
    !tool.requiresConfirmation &&
    (tool.sideEffectLevel === 'none' ||
      tool.sideEffectLevel === 'runtime_read' ||
      tool.sideEffectLevel === 'local_memory_write')
  );
}

function normalizeToolCallResult(options: {
  readonly plugin: RuntimePlugin;
  readonly providedTool: RuntimePluginProvidedTool;
  readonly context: RuntimePluginContext;
  readonly value: unknown;
}): RuntimePluginToolCallResult {
  if (!isRecord(options.value)) {
    throw new TypeError('Plugin tool result must be an object.');
  }

  const status = options.value['status'];

  if (status === 'accepted') {
    const evidence = normalizeEvidenceSnapshots({
      plugin: options.plugin,
      context: options.context,
      value: options.value['evidence']
    });

    assertAcceptedToolEvidenceSourceReferences({
      plugin: options.plugin,
      providedTool: options.providedTool,
      evidence
    });

    return Object.freeze({
      status: 'accepted',
      output: normalizeJsonValue(options.value['output']),
      evidence
    } satisfies RuntimePluginToolCallResult);
  }

  if (status === 'rejected') {
    const reason = options.value['reason'];
    const message = options.value['message'];

    if (typeof reason !== 'string' || typeof message !== 'string') {
      throw new TypeError('Plugin rejected tool result must include reason and message.');
    }

    const evidence = normalizeEvidenceSnapshots({
      plugin: options.plugin,
      context: options.context,
      value: options.value['evidence']
    });
    const evidenceWithRejection = evidenceRecordsStatus({
      evidence,
      evidenceKind: 'tool_invocation',
      statuses: ['rejected', 'failed']
    })
      ? evidence
      : Object.freeze([
          ...evidence,
          createHookFailureEvidence({
            plugin: options.plugin,
            context: options.context,
            evidenceKind: 'tool_invocation',
            status: 'rejected',
            summary: message,
            policyOutcome: 'handler_rejected'
          })
        ]);

    return Object.freeze({
      status: 'rejected',
      reason,
      message,
      evidence: evidenceWithRejection
    } satisfies RuntimePluginToolCallResult);
  }

  throw new TypeError('Plugin tool result status is not supported.');
}

function createRejectedToolCallResult(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly reason: string;
  readonly message: string;
  readonly evidenceStatus?: RuntimePluginEvidenceStatus;
  readonly policyOutcome?: RuntimePluginPolicyOutcome;
}): RuntimePluginToolCallResult {
  return Object.freeze({
    status: 'rejected',
    reason: options.reason,
    message: options.message,
    evidence: Object.freeze([
      createRuntimePluginEvidenceSnapshot({
        eventId: options.context.eventId,
        traceId: options.context.traceId,
        createdAt: options.context.timestamp,
        kind: 'runtime_plugin_evidence_snapshot',
        pluginId: options.call.pluginId,
        evidenceKind: 'tool_invocation',
        status: options.evidenceStatus ?? 'rejected',
        summary: options.message,
        policyOutcome: options.policyOutcome ?? 'handler_rejected',
        redactionLabels: options.context.privacy.redactionLabels
      })
    ])
  } satisfies RuntimePluginToolCallResult);
}

function normalizeJsonValue(value: unknown): RuntimePluginJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Plugin tool output must be finite JSON.');
    }

    return value;
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map(normalizeJsonValue));
  }

  if (isRecord(value)) {
    const snapshot: Record<string, RuntimePluginJsonValue> = {};

    for (const [key, item] of Object.entries(value)) {
      snapshot[key] = normalizeJsonValue(item);
    }

    return Object.freeze(snapshot);
  }

  throw new TypeError('Plugin tool output must be JSON serializable.');
}

async function runHealth(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly context: RuntimePluginContext;
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
}): Promise<RuntimePluginHealthHostResult> {
  const snapshots: RuntimePluginHealthSnapshot[] = [];
  const evidence: RuntimePluginEvidenceSnapshot[] = [];

  for (const plugin of options.plugins) {
    const hook = plugin.lifecycleHooks.health;

    if (hook === undefined) {
      continue;
    }

    try {
      const snapshot = createRuntimePluginHealthSnapshot(
        await withPluginHookTimeout({
          plugin,
          hookName: 'health',
          operation: async () =>
            await hook(
              createPluginHookContext({
                context: options.context,
                plugin,
                storeRoot: options.storeRoot,
                sessionId: options.sessionId
              })
            )
        })
      );

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
  readonly hook: NonNullable<RuntimePlugin['lifecycleHooks']['beforeRoleModelCall']>;
}): Promise<BeforeRoleModelCallInvocationResult> {
  try {
    return Object.freeze({
      status: 'accepted',
      value: normalizeBeforeRoleModelCallResult({
        plugin: options.plugin,
        context: options.context,
        value: await withPluginHookTimeout({
          plugin: options.plugin,
          hookName: 'beforeRoleModelCall',
          operation: async () => await options.hook(options.context)
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
  readonly hookName: 'afterTurnCommitted' | 'onSessionEnd';
  readonly hook: (context: TContext) => RuntimePluginHookResult | Promise<RuntimePluginHookResult>;
}): Promise<HookInvocationResult> {
  try {
    return Object.freeze({
      status: 'accepted',
      value: normalizeHookResult({
        plugin: options.plugin,
        context: options.context,
        value: await withPluginHookTimeout({
          plugin: options.plugin,
          hookName: options.hookName,
          operation: async () => await options.hook(options.context)
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
}): RuntimePluginBeforeRoleModelCallResult {
  if (!isRecord(options.value)) {
    throw new TypeError('beforeRoleModelCall hook result must be an object.');
  }

  return Object.freeze({
    contextItems: normalizeContextItems({
      plugin: options.plugin,
      value: options.value['contextItems']
    }),
    runtimeNotes: normalizeRuntimeNotes(options.value['runtimeNotes']),
    evidence: normalizeEvidenceSnapshots({
      plugin: options.plugin,
      context: options.context,
      value: options.value['evidence']
    })
  } satisfies RuntimePluginBeforeRoleModelCallResult);
}

function normalizeHookResult(options: {
  readonly plugin: RuntimePlugin;
  readonly context: RuntimePluginContext;
  readonly value: unknown;
}): RuntimePluginHookResult {
  if (!isRecord(options.value)) {
    throw new TypeError('Plugin hook result must be an object.');
  }

  const status = options.value['status'];

  if (status !== 'completed' && status !== 'failed') {
    throw new TypeError('Plugin hook result status is not supported.');
  }

  return Object.freeze({
    status,
    evidence: normalizeEvidenceSnapshots({
      plugin: options.plugin,
      context: options.context,
      value: options.value['evidence']
    })
  } satisfies RuntimePluginHookResult);
}

function normalizeContextItems(options: {
  readonly plugin: RuntimePlugin;
  readonly value: unknown;
}): readonly RuntimePluginContextItem[] {
  const items = requiredArray(options.value, 'contextItems');

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

function boundPluginContextItems(options: {
  readonly context: RuntimePluginContext;
  readonly contextItems: readonly CollectedPluginContextItem[];
}): BoundedPluginContextItemsResult {
  const totalEstimatedTokens = options.contextItems.reduce(
    (total, contextItem) => total + contextItem.item.budget.estimatedTokens,
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

  const retainedIndexes = new Set<number>();
  let retainedEstimatedTokens = 0;

  for (const candidate of [...options.contextItems].sort(
    compareCollectedContextItemPriority
  )) {
    const nextEstimatedTokens =
      retainedEstimatedTokens + candidate.item.budget.estimatedTokens;

    if (nextEstimatedTokens > runtimePluginContextEstimatedTokenBudget) {
      continue;
    }

    retainedIndexes.add(candidate.originalIndex);
    retainedEstimatedTokens = nextEstimatedTokens;
  }

  const retainedContextItems = options.contextItems
    .filter((contextItem) => retainedIndexes.has(contextItem.originalIndex))
    .map((contextItem) => contextItem.item);
  const droppedContextItems = options.contextItems.filter(
    (contextItem) => !retainedIndexes.has(contextItem.originalIndex)
  );
  const evidence = contextBudgetEvidence({
    context: options.context,
    droppedContextItems,
    retainedEstimatedTokens,
    totalEstimatedTokens
  });
  const rejectedContextItem =
    firstDroppedContextItemThatRejectsTurn(droppedContextItems);

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

function compareCollectedContextItemPriority(
  left: CollectedPluginContextItem,
  right: CollectedPluginContextItem
): number {
  return (
    left.item.budget.priority - right.item.budget.priority ||
    left.originalIndex - right.originalIndex
  );
}

function contextBudgetEvidence(options: {
  readonly context: RuntimePluginContext;
  readonly droppedContextItems: readonly CollectedPluginContextItem[];
  readonly retainedEstimatedTokens: number;
  readonly totalEstimatedTokens: number;
}): readonly RuntimePluginEvidenceSnapshot[] {
  const droppedByPlugin = new Map<
    string,
    {
      readonly plugin: RuntimePlugin;
      readonly dropped: CollectedPluginContextItem[];
    }
  >();

  for (const droppedContextItem of options.droppedContextItems) {
    const pluginId = droppedContextItem.plugin.manifest.id;
    const entry = droppedByPlugin.get(pluginId);

    if (entry === undefined) {
      droppedByPlugin.set(pluginId, {
        plugin: droppedContextItem.plugin,
        dropped: [droppedContextItem]
      });
      continue;
    }

    entry.dropped.push(droppedContextItem);
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
          droppedContextItems: entry.dropped,
          retainedEstimatedTokens: options.retainedEstimatedTokens,
          totalEstimatedTokens: options.totalEstimatedTokens
        }),
        policyOutcome: rejectsTurn ? 'required_rejected' : 'optional_degraded'
      });
    })
  );
}

function firstDroppedContextItemThatRejectsTurn(
  droppedContextItems: readonly CollectedPluginContextItem[]
): CollectedPluginContextItem | undefined {
  return droppedContextItems.find((contextItem) =>
    beforeRoleModelFailureRejectsTurn(contextItem.plugin)
  );
}

function requiredContextBudgetRejectionMessage(
  contextItem: CollectedPluginContextItem
): string {
  return `Required before-role-model plugin context exceeded the ${String(
    runtimePluginContextEstimatedTokenBudget
  )}-token budget; dropped context item "${contextItem.item.id}".`;
}

function contextBudgetEvidenceSummary(options: {
  readonly droppedContextItems: readonly CollectedPluginContextItem[];
  readonly retainedEstimatedTokens: number;
  readonly totalEstimatedTokens: number;
}): string {
  const droppedIds = options.droppedContextItems
    .map((contextItem) => contextItem.item.id)
    .join(', ');

  return `Plugin context budget kept ${String(
    options.retainedEstimatedTokens
  )}/${String(runtimePluginContextEstimatedTokenBudget)} estimated tokens and dropped ${String(
    options.droppedContextItems.length
  )} item(s) from ${String(
    options.totalEstimatedTokens
  )} estimated tokens; dropped ids ${droppedIds}`;
}

function normalizeRuntimeNotes(value: unknown): readonly string[] {
  return Object.freeze(
    requiredArray(value, 'runtimeNotes').map((item) => {
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw new TypeError('runtimeNotes must contain non-empty strings.');
      }

      return redactRuntimePluginText(item);
    })
  );
}

function normalizeEvidenceSnapshots(options: {
  readonly plugin: RuntimePlugin;
  readonly context: RuntimePluginContext;
  readonly value: unknown;
}): readonly RuntimePluginEvidenceSnapshot[] {
  return Object.freeze(
    requiredArray(options.value, 'evidence').map((item) => {
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
        .filter((plugin) => plugin.manifest.activation.defaultEnabled)
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

  if (!seenEnabledIds.has(runtimePluginDiscoveryPluginId)) {
    enabledIds.unshift(runtimePluginDiscoveryPluginId);
  }

  return Object.freeze(enabledIds);
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
  if (
    options.snapshot.eventId === options.context.eventId &&
    options.snapshot.traceId === options.context.traceId &&
    options.snapshot.createdAt === options.context.timestamp
  ) {
    return;
  }

  throw new TypeError(
    `${options.field} identity must match current runtime event identity.`
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
    sourceReferences: options.evidence.flatMap(
      (evidence) => evidence.sourceReferences ?? []
    ),
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
  }) {
    super(
      `Plugin "${options.pluginId}" ${options.hookName} timed out after ${String(
        options.timeoutMs
      )}ms.`
    );
    this.name = 'PluginHookTimeoutError';
  }
}

async function withPluginHookTimeout<T>(options: {
  readonly plugin: RuntimePlugin;
  readonly hookName: string;
  readonly operation: () => T | Promise<T>;
}): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.plugin.manifest.runtimePolicy.timeoutMs;

  try {
    return await Promise.race([
      Promise.resolve().then(options.operation),
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new PluginHookTimeoutError({
              pluginId: options.plugin.manifest.id,
              hookName: options.hookName,
              timeoutMs
            })
          );
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
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
