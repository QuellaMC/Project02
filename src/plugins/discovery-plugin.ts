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
  type RuntimePlugin,
  type RuntimePluginJsonObject,
  type RuntimePluginJsonValue,
  type RuntimePluginProvidedTool
} from './validation.ts';

const runtimePluginDiscoveryMaxPlugins = 16;
const runtimePluginDiscoveryMaxToolsPerPlugin = 8;
const runtimePluginDiscoveryMaxTextLength = 160;

export function createRuntimePluginDiscoveryPlugin(
  hostStateForTurn: () => {
    readonly enabledPlugins: readonly RuntimePlugin[];
    readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  }
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
      },
      requestedAccess: { model_input: 'write' }
    },
    providedTools: [
      {
        name: roleModelPluginListToolName,
        description:
          'List plugins available to you in the current turn. Call this when you need canonical plugin inventory.',
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
        const hostState = hostStateForTurn();
        const output = createPluginDiscoveryOutput({
          enabledPlugins: hostState.enabledPlugins,
          accessByPluginId: hostState.accessByPluginId
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
}

export function createPluginDiscoveryOutput(options: {
  readonly enabledPlugins: readonly RuntimePlugin[];
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
}): RuntimePluginJsonObject & {
  readonly plugins: readonly RuntimePluginJsonValue[];
} {
  const boundedPlugins = options.enabledPlugins.slice(
    0,
    runtimePluginDiscoveryMaxPlugins
  );

  return Object.freeze({
    plugins: Object.freeze(
      boundedPlugins.map((plugin) =>
        createPluginDiscoverySummary({
          plugin,
          access: runtimePluginAccessForPlugin({
            plugin,
            accessByPluginId: options.accessByPluginId
          })
        })
      )
    ),
    truncated:
      options.enabledPlugins.length > runtimePluginDiscoveryMaxPlugins
  } satisfies RuntimePluginJsonObject & {
    readonly plugins: readonly RuntimePluginJsonValue[];
  });
}

export function createPluginDiscoverySummary(options: {
  readonly plugin: RuntimePlugin;
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
    kind: options.plugin.manifest.kind,
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
