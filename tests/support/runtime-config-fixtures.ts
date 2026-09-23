import type {createConfiguredProject02PluginHostFromPlan} from '../../src/app/index.ts';
import {
  createMemoryProviderRuntimePlugin,
  createRuntimePlugin,
} from '../../src/plugins/index.ts';
import {requiredSecretPlugin} from './runtime-config-activation-fixtures.ts';
import {ensureInitializedProject02Store} from '../../src/runtime/config/index.ts';
import {ensureCharacterDataDir} from '../../src/runtime/storage/index.ts';
import {createTestTempRoot} from './temp-root.ts';

// Host construction asserts the initializer ran and never creates durable
// character state itself.
export async function initializeCharacterDataForHost(
  storeRoot: string,
  characterId = 'mira',
): Promise<void> {
  await ensureCharacterDataDir({homeRoot: storeRoot, characterId});
}

// Use this where the store's existence is setup; a test about the store-consent
// gate itself wants a bare `createTestTempRoot`.
export async function initializeTestStore(homeRoot: string): Promise<string> {
  await ensureInitializedProject02Store({homeRoot});
  return homeRoot;
}

export async function createInitializedTestStoreRoot(
  prefix = 'project02-test-',
): Promise<string> {
  return initializeTestStore(createTestTempRoot(prefix));
}

export function requiredDottedConfigPlugin(
  id = 'memory',
  fieldName = 'api.config.key',
) {
  const plugin = requiredSecretPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      description: 'Test plugin with required dotted config.',
      config: {
        scope: 'global_with_character_overrides',
        fields: [
          {
            name: fieldName,
            description: 'Nested compatibility API key.',
            required: true,
            secret: false,
            valueType: 'string',
            redactionLabels: [],
          },
        ],
      },
      activation: {
        defaultEnabled: true,
        reasons: ['test_required_dotted_config'],
      },
    },
  });
}

export function structuredConfigPlugin(id: string) {
  const plugin = requiredSecretPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      description: 'Test plugin with structured non-secret config.',
      config: {
        scope: 'global_with_character_overrides',
        fields: [
          {
            name: 'settings',
            description: 'Structured settings.',
            required: true,
            secret: false,
            valueType: 'object',
            redactionLabels: [],
          },
          {
            name: 'endpoints',
            description: 'Endpoint list.',
            required: true,
            secret: false,
            valueType: 'array',
            redactionLabels: [],
          },
        ],
      },
      activation: {
        defaultEnabled: true,
        reasons: ['test_structured_config'],
      },
    },
  });
}

export function characterOnlyConfigPlugin(id: string) {
  const plugin = requiredSecretPlugin(id);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      description: 'Test character-only plugin with shared secret support.',
      config: {
        scope: 'character_only',
        fields: [
          {
            name: 'setting',
            description: 'Character-owned setting.',
            required: false,
            secret: false,
            valueType: 'string',
            redactionLabels: [],
            agentMutable: true,
          },
          {
            name: 'apiKey',
            description: 'Shared API key.',
            required: false,
            secret: true,
            valueType: 'secret',
            redactionLabels: ['secret'],
          },
        ],
      },
      activation: {
        defaultEnabled: false,
        reasons: ['test_character_only'],
      },
    },
  });
}

export function memoryProviderPlugin(id: string) {
  return createMemoryProviderRuntimePlugin({
    id,
    displayName: id,
    recall() {
      return Promise.resolve({items: []});
    },
  });
}

export type ActivationPluginSnapshot = Awaited<
  ReturnType<typeof createConfiguredProject02PluginHostFromPlan>
>['activation']['plugins'][number];

export function activationPluginById(
  plugins: readonly ActivationPluginSnapshot[],
  pluginId: string,
): ActivationPluginSnapshot | undefined {
  return plugins.find(plugin => plugin.pluginId === pluginId);
}
