import {
  runtimePluginConfigReadToolName,
  runtimePluginConfigUpdateToolName,
  runtimePluginContractVersion,
  runtimePluginId,
  runtimePluginListToolName
} from '../../contract.ts';
import { createRuntimePlugin } from '../../constructors.ts';
import { createRuntimePluginManifest } from '../../manifest-validation.ts';
import type {
  RuntimePlugin,
  RuntimePluginProvidedTool,
  RuntimePluginToolCallResult
} from '../../plugin-types.ts';
import {
  createRuntimePluginConfigReadTool,
  handleRuntimePluginConfigReadToolCall
} from './config.ts';
import {
  createRuntimePluginConfigUpdateTool,
  createPreparedRuntimePluginConfigEffectConfirmationPreview,
  preparedRuntimePluginConfigEffectIsStillCurrent,
  handleRuntimePluginConfigUpdateToolCall,
  reconcilePreparedRuntimePluginConfigEffect,
  runtimePluginConfigUpdateExecutionTimeoutMs
} from './config-update.ts';
import {
  createRuntimePluginListTool,
  handleRuntimePluginListToolCall,
  type RuntimePluginListHostState
} from './list.ts';
import {
  createRuntimePluginConfigControlHostStateSnapshot,
  type RuntimePluginConfigControlHostState
} from './state.ts';

export type CreateRuntimePluginManagementPluginOptions = {
  readonly hostStateForTurn: RuntimePluginListHostState;
  readonly pluginConfigControl?: RuntimePluginConfigControlHostState;
  readonly storeRoot?: string;
};

const runtimePluginManagementPluginInstances = new WeakSet<RuntimePlugin>();

export function createRuntimePluginManagementPlugin(
  options: CreateRuntimePluginManagementPluginOptions
): RuntimePlugin {
  const pluginConfigControl =
    options.pluginConfigControl === undefined
      ? undefined
      : createRuntimePluginConfigControlHostStateSnapshot(
          options.pluginConfigControl
        );
  const providedTools: RuntimePluginProvidedTool[] = [
    createRuntimePluginListTool()
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
            hostStateForTurn: options.hostStateForTurn
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
            ...(options.storeRoot === undefined
              ? {}
              : { storeRoot: options.storeRoot })
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
            ...(options.storeRoot === undefined
              ? {}
              : { storeRoot: options.storeRoot })
          });
        }

        return unavailableRuntimePluginManagementTool(call.toolName);
      }
    }
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
      externalContract: 'runtime_plugin_management'
    },
    declaredPlugins: ['tool_provider', 'handle_tool_call'],
    config: {
      fields: []
    },
    localTrustLevel: 'first_party',
    runtimePolicy: {
      requiredForTurn: false,
      sideEffectLevel: 'runtime_config_write',
      confirmation: 'not_required',
      timeoutMs: runtimePluginConfigUpdateExecutionTimeoutMs,
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
      reasons: ['host_provided_plugin_management']
    },
    requestedAccess: { model_input: 'write' }
  });
}

export function isRuntimePluginManagementPlugin(
  plugin: RuntimePlugin
): boolean {
  return runtimePluginManagementPluginInstances.has(plugin);
}

function unavailableRuntimePluginManagementTool(
  toolName: string
): RuntimePluginToolCallResult {
  return {
    status: 'rejected',
    reason: 'runtime_plugin_management_tool_unavailable',
    message: `Tool "${toolName}" is not available in this host.`,
    evidence: Object.freeze([])
  };
}

export {
  createRuntimePluginListOutput,
  createRuntimePluginListSummary,
  type RuntimePluginListActivationState,
  type RuntimePluginListActivationStatus,
  type RuntimePluginListHostState
} from './list.ts';
export {
  createRuntimePluginConfigControlHostStateSnapshot,
  type RuntimePluginConfigControlHostState
} from './state.ts';
export {
  createPreparedRuntimePluginConfigEffectConfirmationPreview,
  preparedRuntimePluginConfigEffectIsStillCurrent,
  reconcilePreparedRuntimePluginConfigEffect
};
