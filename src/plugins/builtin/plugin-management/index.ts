import {
  runtimePluginConfigReadToolName,
  runtimePluginConfigUpdateToolName,
  runtimePluginContractVersion,
  runtimePluginId,
  runtimePluginListToolName,
} from '../../api/contract.ts';
import {createRuntimePlugin} from '../../api/constructors.ts';
import {createRuntimePluginManifest} from '../../api/manifest-validation.ts';
import type {
  RuntimePlugin,
  RuntimePluginProvidedTool,
  RuntimePluginToolCallResult,
} from '../../api/types.ts';
import {
  createRuntimePluginConfigReadTool,
  handleRuntimePluginConfigReadToolCall,
} from './config.ts';
import {
  createRuntimePluginConfigUpdateTool,
  createPreparedRuntimePluginConfigEffectConfirmationPreview,
  normalizePreparedRuntimePluginConfigEffect,
  preparedRuntimePluginConfigEffectIsStillCurrent,
  handleRuntimePluginConfigUpdateToolCall,
  reconcilePreparedRuntimePluginConfigEffect,
  runtimePluginConfigUpdateExecutionTimeoutMs,
} from './config-update.ts';
import {
  createRuntimePluginListTool,
  handleRuntimePluginListToolCall,
  type RuntimePluginListHostState,
} from './list.ts';
import {
  createRuntimePluginConfigControlHostStateSnapshot,
  type RuntimePluginConfigControlHostState,
} from './state.ts';

type CreateRuntimePluginManagementPluginOptions = {
  readonly hostStateForTurn: RuntimePluginListHostState;
  readonly pluginConfigControl?: RuntimePluginConfigControlHostState;
};

const runtimePluginManagementPluginInstances = new WeakSet<RuntimePlugin>();

export function createRuntimePluginManagementPlugin(
  options: CreateRuntimePluginManagementPluginOptions,
): RuntimePlugin {
  const pluginConfigControl =
    options.pluginConfigControl === undefined
      ? undefined
      : createRuntimePluginConfigControlHostStateSnapshot(
          options.pluginConfigControl,
        );
  const providedTools: RuntimePluginProvidedTool[] = [
    createRuntimePluginListTool(),
  ];

  if (pluginConfigControl !== undefined) {
    providedTools.push(createRuntimePluginConfigReadTool());
    providedTools.push(createRuntimePluginConfigUpdateTool());
  }

  const plugin = createRuntimePlugin({
    manifest: createRuntimePluginManagementPluginManifest(),
    providedTools,
    lifecycleHooks: {
      handleToolCall(call, context) {
        if (call.toolName === runtimePluginListToolName) {
          return handleRuntimePluginListToolCall({
            call,
            context,
            hostStateForTurn: options.hostStateForTurn,
          });
        }

        if (
          call.toolName === runtimePluginConfigReadToolName &&
          pluginConfigControl !== undefined
        ) {
          return handleRuntimePluginConfigReadToolCall({
            call,
            context,
            state: pluginConfigControl,
          });
        }

        if (
          call.toolName === runtimePluginConfigUpdateToolName &&
          pluginConfigControl !== undefined
        ) {
          return handleRuntimePluginConfigUpdateToolCall({
            call,
            context,
            state: pluginConfigControl,
            canLiveReload: pluginId => {
              const hostState = options.hostStateForTurn();

              return (
                hostState.liveReloadAvailable === true &&
                hostState.enabledPlugins.some(
                  plugin => plugin.manifest.id === pluginId,
                )
              );
            },
            sessionScopedUpdateConfirmedThisTurn: pluginId =>
              options.hostStateForTurn().sessionScopedConfigUpdateConfirmed?.(
                {
                  eventId: call.eventId,
                  traceId: call.traceId,
                  createdAt: call.createdAt,
                },
                pluginId,
              ) === true,
          });
        }

        return unavailableRuntimePluginManagementTool(call.toolName);
      },
    },
  });

  runtimePluginManagementPluginInstances.add(plugin);
  return plugin;
}

export function createRuntimePluginManagementPluginManifest() {
  return createRuntimePluginManifest({
    id: runtimePluginId,
    displayName: 'Runtime Plugin Management',
    version: '1.0.0',
    kind: 'first_party',
    description:
      'Host-owned plugin inventory, redacted config inspection, and approval-gated config updates.',
    contractVersion: runtimePluginContractVersion,
    compatibility: {
      hostContractVersions: [runtimePluginContractVersion],
      sourceSystem: 'project02',
      externalContract: 'runtime_plugin_management',
    },
    declaredPlugins: ['tool_provider', 'handle_tool_call'],
    config: {
      scope: 'global_with_character_overrides',
      fields: [],
    },
    firstParty: true,
    runtimePolicy: {
      timeoutMs: runtimePluginConfigUpdateExecutionTimeoutMs,
      redactionLabels: [],
      failureBehavior: {
        beforeRoleModelCall: 'degrade',
        handleToolCall: 'reject_tool_call',
        health: 'degrade',
      },
    },
    activation: {
      defaultEnabled: true,
      reasons: ['host_provided_plugin_management'],
    },
    requestedAccess: {model_input: 'write'},
  });
}

export function isRuntimePluginManagementPlugin(
  plugin: RuntimePlugin,
): boolean {
  return runtimePluginManagementPluginInstances.has(plugin);
}

function unavailableRuntimePluginManagementTool(
  toolName: string,
): RuntimePluginToolCallResult {
  return {
    status: 'rejected',
    reason: 'runtime_plugin_management_tool_unavailable',
    message: `Tool "${toolName}" is not available in this host.`,
    evidence: Object.freeze([]),
  };
}

export {
  createRuntimePluginListOutput,
  createRuntimePluginListSummary,
  type RuntimePluginListActivationState,
  type RuntimePluginListActivationStatus,
  type RuntimePluginListHostState,
} from './list.ts';
export {
  createRuntimePluginConfigControlBinding,
  createRuntimePluginConfigControlHostStateSnapshot,
  createRuntimePluginInventoryHostStateSnapshot,
  isRuntimeConfigConflictError,
  requiredRuntimePluginConfigControl,
  runtimeConfigConflictErrorCode,
  type RuntimePluginConfigControlBinding,
  type RuntimePluginConfigControlHostState,
  type RuntimePluginInventoryHostState,
} from './state.ts';
export {
  createPreparedRuntimePluginConfigEffectConfirmationPreview,
  normalizePreparedRuntimePluginConfigEffect,
  preparedRuntimePluginConfigEffectIsStillCurrent,
  reconcilePreparedRuntimePluginConfigEffect,
};
