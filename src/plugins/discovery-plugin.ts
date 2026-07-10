import { roleModelPluginListToolName } from '../role-model/contracts.ts';
import {
  runtimePluginContractVersion,
  type RuntimePluginAccessSnapshot
} from './contract.ts';
import {
  runtimePluginAccessForPlugin,
  runtimePluginDiscoveryPluginId,
  type RuntimePluginAccessMapByPluginId
} from './access-control.ts';
import { isFirstPartyModelToolsPlugin } from './builtin/model-tools.ts';
import {
  discoverableCurrentTurnPluginTools
} from './tool-policy.ts';
import {
  createRuntimePlugin,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginManifest,
  type RuntimePlugin,
  type RuntimePluginJsonObject,
  type RuntimePluginJsonValue,
  type RuntimePluginManifest,
  type RuntimePluginProvidedTool
} from './validation.ts';

const runtimePluginDiscoveryMaxPlugins = 16;
const runtimePluginDiscoveryMaxToolsPerPlugin = 8;
const runtimePluginDiscoveryMaxTextLength = 160;
const runtimePluginDiscoveryPluginInstances = new WeakSet<RuntimePlugin>();

export function createRuntimePluginDiscoveryPlugin(
  hostStateForTurn: () => {
    readonly plugins: readonly RuntimePlugin[];
    readonly enabledPlugins: readonly RuntimePlugin[];
    readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  }
): RuntimePlugin {
  const plugin = createRuntimePlugin({
    manifest: createRuntimePluginDiscoveryPluginManifest(),
    providedTools: [
      {
        name: roleModelPluginListToolName,
        description:
          'List plugins available to you in the current turn. Call this when you need canonical plugin inventory.',
        requiredForUserTurn: false,
        callLimit: {
          scope: 'user_turn',
          maxCalls: 1
        },
        inputContract: {
          type: 'object',
          fields: [
            {
              name: 'includeDisabled',
              description:
                'Include disabled or unavailable plugins when true.',
              required: false,
              valueType: 'boolean'
            },
            {
              name: 'scope',
              description:
                'Use "enabled" for current-turn plugins or "all" for every registered plugin.',
              required: false,
              allowedValues: ['enabled', 'all']
            }
          ],
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
        const hostState = hostStateForTurn();
        const output = createPluginDiscoveryOutput({
          plugins: hostState.plugins,
          enabledPlugins: hostState.enabledPlugins,
          accessByPluginId: hostState.accessByPluginId,
          includeDisabled: pluginDiscoveryIncludesDisabled(_call.input)
        });

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

  runtimePluginDiscoveryPluginInstances.add(plugin);
  return plugin;
}

export function createRuntimePluginDiscoveryPluginManifest(): RuntimePluginManifest {
  return createRuntimePluginManifest({
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
    },
    requestedAccess: { model_input: 'write' }
  });
}

export function isRuntimePluginDiscoveryPlugin(plugin: RuntimePlugin): boolean {
  return runtimePluginDiscoveryPluginInstances.has(plugin);
}

export function createPluginDiscoveryOutput(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly enabledPlugins: readonly RuntimePlugin[];
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  readonly includeDisabled?: boolean;
}): RuntimePluginJsonObject & {
  readonly plugins: readonly RuntimePluginJsonValue[];
} {
  const enabledPluginIds = new Set(
    options.enabledPlugins.map((plugin) => plugin.manifest.id)
  );
  const listedPlugins =
    options.includeDisabled === true ? options.plugins : options.enabledPlugins;
  const boundedPlugins = listedPlugins.slice(
    0,
    runtimePluginDiscoveryMaxPlugins
  );

  return Object.freeze({
    plugins: Object.freeze(
      boundedPlugins.map((plugin) =>
        createPluginDiscoverySummary({
          plugin,
          enabled: enabledPluginIds.has(plugin.manifest.id),
          access: runtimePluginAccessForPlugin({
            plugin,
            accessByPluginId: options.accessByPluginId
          })
        })
      )
    ),
    truncated:
      listedPlugins.length > runtimePluginDiscoveryMaxPlugins
  } satisfies RuntimePluginJsonObject & {
    readonly plugins: readonly RuntimePluginJsonValue[];
  });
}

export function createPluginDiscoverySummary(options: {
  readonly plugin: RuntimePlugin;
  readonly enabled: boolean;
  readonly access: RuntimePluginAccessSnapshot;
}): RuntimePluginJsonObject {
  const discoverableTools = discoverableCurrentTurnPluginTools({
    plugin: options.plugin,
    access: options.access,
    isHostOwnedFirstPartyModelToolsPlugin: isFirstPartyModelToolsPlugin
  });
  const safeTools = discoverableTools
    .slice(0, runtimePluginDiscoveryMaxToolsPerPlugin)
    .map(createPluginDiscoveryToolSummary);

  return Object.freeze({
    id: boundedPluginDiscoveryText(options.plugin.manifest.id),
    displayName: boundedPluginDiscoveryText(options.plugin.manifest.displayName),
    version: boundedPluginDiscoveryText(options.plugin.manifest.version),
    kind: options.plugin.manifest.kind,
    description: boundedPluginDiscoveryText(
      options.plugin.manifest.description
    ),
    enabled: options.enabled,
    availableForTurn: options.enabled,
    activationStatus: options.enabled ? 'active' : 'disabled',
    requestedAccess: options.access.requestedAccess,
    grantedAccess: options.enabled
      ? options.access.grantedAccess
      : Object.freeze({}),
    registeredLifecycleHooks: Object.freeze(
      registeredLifecycleHookNames(options.plugin)
    ),
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
    description: boundedPluginDiscoveryText(tool.description),
    sideEffectLevel: tool.sideEffectLevel,
    requiredForUserTurn: tool.requiredForUserTurn,
    callLimit: tool.callLimit,
    requiresConfirmation: tool.requiresConfirmation,
    validationOwner: tool.validationOwner,
    sourceReferencesRequired: tool.sourceReferencesRequired
  } satisfies RuntimePluginJsonObject);
}

function pluginDiscoveryIncludesDisabled(
  input: Readonly<Record<string, RuntimePluginJsonValue>>
): boolean {
  return input['includeDisabled'] === true || input['scope'] === 'all';
}

function registeredLifecycleHookNames(
  plugin: RuntimePlugin
): readonly string[] {
  const hooks: string[] = [];

  if (plugin.lifecycleHooks.beforeRoleModelCall !== undefined) {
    hooks.push('beforeRoleModelCall');
  }

  if (plugin.lifecycleHooks.handleToolCall !== undefined) {
    hooks.push('handleToolCall');
  }

  if (plugin.lifecycleHooks.afterTurnCommitted !== undefined) {
    hooks.push('afterTurnCommitted');
  }

  if (plugin.lifecycleHooks.onSessionEnd !== undefined) {
    hooks.push('onSessionEnd');
  }

  if (plugin.lifecycleHooks.health !== undefined) {
    hooks.push('health');
  }

  return Object.freeze(hooks);
}

function boundedPluginDiscoveryText(value: string): string {
  if (value.length <= runtimePluginDiscoveryMaxTextLength) {
    return value;
  }

  return `${value.slice(0, runtimePluginDiscoveryMaxTextLength - 3)}...`;
}
