import {
  runtimePluginId,
  runtimePluginListToolName,
  type RuntimePluginAccessSnapshot,
} from '../../api/contract.ts';
import {
  runtimePluginAccessForPlugin,
  type RuntimePluginAccessMapByPluginId,
} from '../../policy/access-control.ts';
import {isFirstPartyModelToolsPlugin} from '../model-tools/index.ts';
import {discoverableCurrentTurnPluginTools} from '../../policy/tool-policy.ts';
import {createRuntimePluginEvidenceSnapshot} from '../../api/constructors.ts';
import type {
  RuntimePlugin,
  RuntimePluginContext,
  RuntimePluginJsonObject,
  RuntimePluginJsonValue,
  RuntimePluginManifest,
  RuntimePluginProvidedTool,
  RuntimePluginToolCall,
  RuntimePluginToolCallResult,
} from '../../api/types.ts';

const runtimePluginListMaxPlugins = 16;
const runtimePluginListMaxToolsPerPlugin = 8;
const runtimePluginListMaxTextLength = 160;

export type RuntimePluginListActivationStatus =
  'active' | 'disabled' | 'blocked';

export type RuntimePluginListActivationState = {
  readonly pluginId: string;
  readonly activationStatus: RuntimePluginListActivationStatus;
};

export type RuntimePluginListHostState = () => {
  readonly plugins: readonly RuntimePlugin[];
  readonly enabledPlugins: readonly RuntimePlugin[];
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  readonly installedPluginManifests?: readonly RuntimePluginManifest[];
  readonly activationStates?: readonly RuntimePluginListActivationState[];
  readonly confirmationAvailable: boolean;
  readonly liveReloadAvailable?: boolean;
  /** Host-kept record of confirmed config updates for the identified turn. */
  readonly sessionScopedConfigUpdateConfirmed?: (
    identity: {
      readonly eventId: string;
      readonly traceId: string;
      readonly createdAt: string;
    },
    pluginId: string,
  ) => boolean;
};

export function createRuntimePluginListTool(): RuntimePluginProvidedTool {
  return {
    name: runtimePluginListToolName,
    description:
      'List plugins available to you in the current turn or inspect the installed plugin catalog. Call this when you need canonical plugin inventory.',
    inputContract: {
      type: 'object',
      properties: {
        includeDisabled: {
          type: 'boolean',
          description: 'Include disabled or unavailable plugins when true.',
        },
        scope: {
          type: 'string',
          description:
            'Use "enabled" for current-turn plugins or "all" for every installed plugin.',
          enum: ['enabled', 'all'],
        },
      },
      required: [],
      additionalProperties: false,
    },
    validationOwner: 'plugin_host',
    annotations: {readOnlyHint: true},
    concurrency: 'shared',
    requiresConfirmation: false,
  };
}

export function handleRuntimePluginListToolCall(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly hostStateForTurn: RuntimePluginListHostState;
}): RuntimePluginToolCallResult {
  const hostState = options.hostStateForTurn();
  const output = createRuntimePluginListOutput({
    plugins: hostState.plugins,
    enabledPlugins: hostState.enabledPlugins,
    accessByPluginId: hostState.accessByPluginId,
    ...(hostState.installedPluginManifests === undefined
      ? {}
      : {installedPluginManifests: hostState.installedPluginManifests}),
    ...(hostState.activationStates === undefined
      ? {}
      : {activationStates: hostState.activationStates}),
    confirmationAvailable: hostState.confirmationAvailable,
    includeDisabled: runtimePluginListIncludesDisabled(options.call.input),
  });

  return {
    status: 'accepted',
    output,
    evidence: [
      createRuntimePluginEvidenceSnapshot({
        eventId: options.context.eventId,
        traceId: options.context.traceId,
        createdAt: options.context.timestamp,
        kind: 'runtime_plugin_evidence_snapshot',
        pluginId: runtimePluginId,
        evidenceKind: 'tool_invocation',
        status: 'accepted',
        summary: `Returned ${String(output.plugins.length)} plugin summaries.`,
        redactionLabels: options.context.privacy.redactionLabels,
      }),
    ],
  };
}

export function createRuntimePluginListOutput(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly enabledPlugins: readonly RuntimePlugin[];
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  readonly installedPluginManifests?: readonly RuntimePluginManifest[];
  readonly activationStates?: readonly RuntimePluginListActivationState[];
  readonly confirmationAvailable: boolean;
  readonly includeDisabled?: boolean;
}): RuntimePluginJsonObject & {
  readonly plugins: readonly RuntimePluginJsonValue[];
} {
  const enabledPluginIds = new Set(
    options.enabledPlugins.map(plugin => plugin.manifest.id),
  );
  const activationByPluginId = new Map(
    (options.activationStates ?? []).map(
      activation => [activation.pluginId, activation] as const,
    ),
  );
  const runtimePluginIds = new Set(
    options.plugins.map(plugin => plugin.manifest.id),
  );
  const listedRuntimePlugins =
    options.includeDisabled === true ? options.plugins : options.enabledPlugins;
  const coldInstalledManifests =
    options.includeDisabled === true
      ? (options.installedPluginManifests ?? []).filter(manifest => {
          const activation = activationByPluginId.get(manifest.id);

          return (
            !runtimePluginIds.has(manifest.id) &&
            activation?.activationStatus !== 'active'
          );
        })
      : [];
  const listedPluginCount =
    listedRuntimePlugins.length + coldInstalledManifests.length;
  const boundedRuntimePlugins = listedRuntimePlugins.slice(
    0,
    runtimePluginListMaxPlugins,
  );
  const boundedColdManifests = coldInstalledManifests.slice(
    0,
    Math.max(0, runtimePluginListMaxPlugins - boundedRuntimePlugins.length),
  );

  return Object.freeze({
    plugins: Object.freeze([
      ...boundedRuntimePlugins.map(plugin => {
        const enabled = enabledPluginIds.has(plugin.manifest.id);

        return createRuntimePluginListSummary({
          plugin,
          enabled,
          confirmationAvailable: options.confirmationAvailable,
          activationStatus: effectiveRuntimePluginActivationStatus({
            enabled,
            configuredStatus: activationByPluginId.get(plugin.manifest.id)
              ?.activationStatus,
          }),
          access: runtimePluginAccessForPlugin({
            plugin,
            accessByPluginId: options.accessByPluginId,
          }),
        });
      }),
      ...boundedColdManifests.map(manifest =>
        createColdRuntimePluginListSummary({
          manifest,
          activationStatus:
            activationByPluginId.get(manifest.id)?.activationStatus ??
            'disabled',
        }),
      ),
    ]),
    truncated: listedPluginCount > runtimePluginListMaxPlugins,
  } satisfies RuntimePluginJsonObject & {
    readonly plugins: readonly RuntimePluginJsonValue[];
  });
}

export function createRuntimePluginListSummary(options: {
  readonly plugin: RuntimePlugin;
  readonly enabled: boolean;
  readonly activationStatus?: RuntimePluginListActivationStatus;
  readonly access: RuntimePluginAccessSnapshot;
  readonly confirmationAvailable: boolean;
}): RuntimePluginJsonObject {
  const discoverableTools = discoverableCurrentTurnPluginTools({
    plugin: options.plugin,
    access: options.access,
    confirmationAvailable: options.confirmationAvailable,
    isHostOwnedFirstPartyModelToolsPlugin: isFirstPartyModelToolsPlugin,
  });
  const safeTools = discoverableTools
    .slice(0, runtimePluginListMaxToolsPerPlugin)
    .map(createRuntimePluginListToolSummary);

  return Object.freeze({
    id: boundedRuntimePluginListText(options.plugin.manifest.id),
    displayName: boundedRuntimePluginListText(
      options.plugin.manifest.displayName,
    ),
    version: boundedRuntimePluginListText(options.plugin.manifest.version),
    kind: options.plugin.manifest.kind,
    description: boundedRuntimePluginListText(
      options.plugin.manifest.description,
    ),
    enabled: options.enabled,
    availableForTurn: options.enabled,
    activationStatus:
      options.activationStatus ?? (options.enabled ? 'active' : 'disabled'),
    requestedAccess: options.access.requestedAccess,
    grantedAccess: options.enabled
      ? options.access.grantedAccess
      : Object.freeze({}),
    registeredLifecycleHooks: Object.freeze(
      registeredLifecycleHookNames(options.plugin),
    ),
    providedTools: Object.freeze(safeTools),
    toolsTruncated:
      discoverableTools.length > runtimePluginListMaxToolsPerPlugin,
  } satisfies RuntimePluginJsonObject);
}

function createColdRuntimePluginListSummary(options: {
  readonly manifest: RuntimePluginManifest;
  readonly activationStatus: RuntimePluginListActivationStatus;
}): RuntimePluginJsonObject {
  return Object.freeze({
    id: boundedRuntimePluginListText(options.manifest.id),
    displayName: boundedRuntimePluginListText(options.manifest.displayName),
    version: boundedRuntimePluginListText(options.manifest.version),
    kind: options.manifest.kind,
    description: boundedRuntimePluginListText(options.manifest.description),
    enabled: false,
    availableForTurn: false,
    activationStatus:
      options.activationStatus === 'active'
        ? 'disabled'
        : options.activationStatus,
    requestedAccess: options.manifest.requestedAccess,
    grantedAccess: Object.freeze({}),
    registeredLifecycleHooks: Object.freeze([]),
    providedTools: Object.freeze([]),
    toolsTruncated: false,
  } satisfies RuntimePluginJsonObject);
}

function effectiveRuntimePluginActivationStatus(options: {
  readonly enabled: boolean;
  readonly configuredStatus: RuntimePluginListActivationStatus | undefined;
}): RuntimePluginListActivationStatus {
  if (options.enabled) {
    return 'active';
  }

  return options.configuredStatus === 'blocked' ? 'blocked' : 'disabled';
}

function createRuntimePluginListToolSummary(
  tool: RuntimePluginProvidedTool,
): RuntimePluginJsonObject {
  return Object.freeze({
    name: boundedRuntimePluginListText(tool.name),
    description: boundedRuntimePluginListText(tool.description),
    ...(tool.annotations === undefined ? {} : {annotations: tool.annotations}),
    ...(tool.concurrency === undefined ? {} : {concurrency: tool.concurrency}),
    requiresConfirmation: tool.requiresConfirmation,
    validationOwner: tool.validationOwner,
  } satisfies RuntimePluginJsonObject);
}

function runtimePluginListIncludesDisabled(
  input: Readonly<Record<string, RuntimePluginJsonValue>>,
): boolean {
  return input['includeDisabled'] === true || input['scope'] === 'all';
}

function registeredLifecycleHookNames(
  plugin: RuntimePlugin,
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

  if (plugin.lifecycleHooks.onShutdown !== undefined) {
    hooks.push('onShutdown');
  }

  if (plugin.lifecycleHooks.health !== undefined) {
    hooks.push('health');
  }

  return Object.freeze(hooks);
}

function boundedRuntimePluginListText(value: string): string {
  if (value.length <= runtimePluginListMaxTextLength) {
    return value;
  }

  return `${value.slice(0, runtimePluginListMaxTextLength - 3)}...`;
}
