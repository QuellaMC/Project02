import {
  createRuntimePlugin,
  hostScopedFirstPartyRuntimePluginIds,
  memorySearchTool,
  runtimePluginContractVersion,
  runtimePluginListToolName,
  type RuntimePluginAccessMap,
  type RuntimePluginContext,
} from '../../src/plugins/index.ts';

export function requiredSecretPlugin(
  id: string,
  options: {
    readonly defaultEnabled?: boolean;
  } = {},
) {
  return createRuntimePlugin({
    manifest: {
      id,
      displayName: 'Required Secret',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Test plugin with required secret config.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'project02',
      },
      declaredPlugins: ['plugin_discovery'],
      config: {
        fields: [
          {
            name: 'apiKey',
            description: 'API key.',
            required: true,
            secret: true,
            valueType: 'secret',
            redactionLabels: ['secret'],
          },
        ],
      },
      localTrustLevel: 'trusted_adapter',
      runtimePolicy: {
        requiredForTurn: false,
        sideEffectLevel: 'runtime_read',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'degrade',
          afterTurnCommitted: 'log_failure',
          health: 'degrade',
        },
      },
      activation: {
        defaultEnabled: options.defaultEnabled ?? true,
        reasons: ['test_required_secret'],
      },
      requestedAccess: {},
    },
  });
}

export function requiredSecretAndEndpointPlugin(
  id: string,
): ReturnType<typeof requiredSecretPlugin> {
  const plugin = requiredSecretPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      config: {
        fields: [
          ...plugin.manifest.config.fields,
          {
            name: 'endpoint',
            description: 'Endpoint.',
            required: true,
            secret: false,
            valueType: 'string',
            redactionLabels: [],
          },
        ],
      },
    },
  });
}

export function pluginWithAdditionalConfigField(id: string) {
  const plugin = requiredSecretPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      config: {
        ...plugin.manifest.config,
        fields: [
          ...plugin.manifest.config.fields,
          {
            name: 'region',
            description: 'Region.',
            required: false,
            secret: false,
            valueType: 'string',
            redactionLabels: [],
          },
        ],
      },
    },
  });
}

export function firstPartyPlugin(
  id: string,
  options: {
    readonly defaultEnabled?: boolean;
  } = {},
) {
  return createRuntimePlugin({
    manifest: {
      id,
      displayName: 'First Party',
      version: '1.0.0',
      kind: 'first_party',
      description: 'Test first-party plugin.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'project02',
      },
      declaredPlugins: ['plugin_discovery'],
      config: {
        fields: [],
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
          handleToolCall: 'degrade',
          afterTurnCommitted: 'log_failure',
          health: 'degrade',
        },
      },
      activation: {
        defaultEnabled: options.defaultEnabled ?? true,
        reasons: ['test_first_party'],
      },
      requestedAccess: {},
    },
  });
}

export function sessionEndPlugin(
  id: string,
  onSessionEnd: (context: RuntimePluginContext) => void,
  options: {
    readonly defaultEnabled?: boolean;
  } = {},
) {
  const plugin = firstPartyPlugin(id, options);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      declaredPlugins: ['plugin_discovery', 'on_session_end'],
    },
    lifecycleHooks: {
      onSessionEnd(context) {
        onSessionEnd(context);
        return {
          status: 'completed',
          evidence: [],
        };
      },
    },
  });
}

export function fileStoreSessionEndPlugin(
  id: string,
  onSessionEnd: (context: RuntimePluginContext) => void,
) {
  const plugin = firstPartyPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      declaredPlugins: ['plugin_discovery', 'on_session_end'],
      runtimePolicy: {
        ...plugin.manifest.runtimePolicy,
        sideEffectLevel: 'local_memory_write',
      },
      requestedAccess: {file_store: 'write'},
    },
    lifecycleHooks: {
      onSessionEnd(context) {
        onSessionEnd(context);
        return {
          status: 'completed',
          evidence: [],
        };
      },
    },
  });
}

export function modelFacingMemorySearchPlugin(id: string) {
  const plugin = firstPartyPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      declaredPlugins: [
        'plugin_discovery',
        'tool_provider',
        'handle_tool_call',
      ],
      requestedAccess: {model_input: 'write'},
    },
    providedTools: [memorySearchTool('memory.search')],
    lifecycleHooks: {
      handleToolCall() {
        return {
          status: 'accepted',
          output: {},
          evidence: [],
        };
      },
    },
  });
}

export function modelFacingPluginListCollisionPlugin(
  id: string,
  onSessionEnd: (context: RuntimePluginContext) => void,
) {
  const plugin = firstPartyPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      declaredPlugins: [
        'plugin_discovery',
        'tool_provider',
        'handle_tool_call',
        'on_session_end',
      ],
      requestedAccess: {model_input: 'write'},
    },
    providedTools: [memorySearchTool(runtimePluginListToolName)],
    lifecycleHooks: {
      handleToolCall() {
        return {
          status: 'accepted',
          output: {},
          evidence: [],
        };
      },
      onSessionEnd(context) {
        onSessionEnd(context);

        return {
          status: 'completed',
          evidence: [],
        };
      },
    },
  });
}

export function parseActivationOutput(stdout: string): {
  readonly activationDiagnostics: readonly {
    readonly severity: string;
    readonly code: string;
    readonly path?: string;
    readonly pluginId?: string;
  }[];
  readonly plugins: readonly {
    readonly pluginId: string;
    readonly activationStatus: string;
    readonly enabled: boolean;
    readonly requestedAccess: RuntimePluginAccessMap;
    readonly grantedAccess: RuntimePluginAccessMap;
  }[];
} {
  return JSON.parse(stdout) as {
    readonly activationDiagnostics: readonly {
      readonly severity: string;
      readonly code: string;
      readonly path?: string;
      readonly pluginId?: string;
    }[];
    readonly plugins: readonly {
      readonly pluginId: string;
      readonly activationStatus: string;
      readonly enabled: boolean;
      readonly requestedAccess: RuntimePluginAccessMap;
      readonly grantedAccess: RuntimePluginAccessMap;
    }[];
  };
}

export function nonHostScopedActivationPlugins(
  output: ReturnType<typeof parseActivationOutput>,
): ReturnType<typeof parseActivationOutput>['plugins'] {
  const hostScopedPluginIds = new Set(hostScopedFirstPartyRuntimePluginIds);

  return Object.freeze(
    output.plugins.filter(plugin => !hostScopedPluginIds.has(plugin.pluginId)),
  );
}

export function enabledNonHostScopedActivationPlugins(
  output: ReturnType<typeof parseActivationOutput>,
): ReturnType<typeof parseActivationOutput>['plugins'] {
  return Object.freeze(
    nonHostScopedActivationPlugins(output).filter(plugin => plugin.enabled),
  );
}
