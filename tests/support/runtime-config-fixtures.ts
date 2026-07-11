import type { createConfiguredProject02PluginHost } from '../../src/runtime/config/index.ts';
import {
  createMemoryProviderRuntimePlugin,
  createRuntimePlugin,
  firstPartyModelToolsPluginId,
  runtimePluginDiscoveryPluginId,
  runtimePluginContractVersion
} from '../../src/plugins/index.ts';

export function requiredSecretPlugin(id = 'memory.required') {
  return createRuntimePlugin({
    manifest: {
      id,
      displayName: 'Required Memory',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Test plugin with required secret config.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'project02'
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
            redactionLabels: ['secret']
          }
        ]
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
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: true,
        reasons: ['test_required_secret']
      },
      requestedAccess: {}
    }
  });
}

export function requiredSecretPluginWithManifestEnvVar(id: string, envVar: string) {
  const plugin = requiredSecretPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      config: {
        fields: plugin.manifest.config.fields.map((field) =>
          field.name === 'apiKey' ? { ...field, envVar } : field
        )
      }
    }
  });
}

export function requiredDottedConfigPlugin(id = 'memory', fieldName = 'api.config.key') {
  const plugin = requiredSecretPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      description: 'Test plugin with required dotted config.',
      config: {
        fields: [
          {
            name: fieldName,
            description: 'Nested compatibility API key.',
            required: true,
            secret: false,
            valueType: 'string',
            redactionLabels: []
          }
        ]
      },
      activation: {
        defaultEnabled: true,
        reasons: ['test_required_dotted_config']
      }
    }
  });
}

export function structuredConfigPlugin(id: string) {
  const plugin = requiredSecretPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      description: 'Test plugin with structured non-secret config.',
      config: {
        fields: [
          {
            name: 'settings',
            description: 'Structured settings.',
            required: true,
            secret: false,
            valueType: 'object',
            redactionLabels: []
          },
          {
            name: 'endpoints',
            description: 'Endpoint list.',
            required: true,
            secret: false,
            valueType: 'array',
            redactionLabels: []
          }
        ]
      },
      activation: {
        defaultEnabled: true,
        reasons: ['test_structured_config']
      }
    }
  });
}

export function memoryProviderPlugin(id: string) {
  return createMemoryProviderRuntimePlugin({
    id,
    displayName: id,
    recall() {
      return Promise.resolve({ items: [] });
    }
  });
}

export function restoreProcessEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }

  process.env[name] = value;
}

export type ActivationPluginSnapshot = Awaited<
  ReturnType<typeof createConfiguredProject02PluginHost>
>['activation']['plugins'][number];

export function activationPluginById(
  plugins: readonly ActivationPluginSnapshot[],
  pluginId: string
): ActivationPluginSnapshot | undefined {
  return plugins.find((plugin) => plugin.pluginId === pluginId);
}

export function nonHostScopedActivationPlugins(
  plugins: readonly ActivationPluginSnapshot[]
): readonly ActivationPluginSnapshot[] {
  const hostScopedPluginIds = new Set([
    runtimePluginDiscoveryPluginId,
    firstPartyModelToolsPluginId
  ]);

  return Object.freeze(
    plugins.filter((plugin) => !hostScopedPluginIds.has(plugin.pluginId))
  );
}
