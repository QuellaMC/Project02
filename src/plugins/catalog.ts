import {
  characterStatePluginId,
  createCharacterStatePlugin,
  createCharacterStatePluginManifest,
  isCharacterStatePlugin
} from './builtin/character-state/index.ts';
import {
  createFirstPartyModelToolsPlugin,
  createFirstPartyModelToolsPluginManifest,
  isFirstPartyModelToolsPlugin
} from './builtin/model-tools.ts';
import {
  firstPartyModelToolsPluginId
} from './contract.ts';
import {
  runtimePluginDiscoveryPluginId,
  type RuntimePluginAccessMapByPluginId
} from './access-control.ts';
import {
  createRuntimePluginDiscoveryPlugin,
  createRuntimePluginDiscoveryPluginManifest,
  isRuntimePluginDiscoveryPlugin
} from './discovery-plugin.ts';
import type {
  RuntimePlugin,
  RuntimePluginManifest
} from './validation.ts';
import type {
  RuntimePluginFactoryDefinition
} from './factory.ts';

export type RuntimePluginCatalogFactoryDefinition =
  RuntimePluginFactoryDefinition<() => RuntimePlugin> & {
    readonly catalogOwner: 'project02_host';
    readonly construction: 'host_scoped' | 'factory';
  };

export type RuntimePluginDiscoveryHostState = () => {
  readonly plugins: readonly RuntimePlugin[];
  readonly enabledPlugins: readonly RuntimePlugin[];
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
};

export function defaultRuntimePluginCatalogFactoryDefinitions(): Readonly<
  Record<string, RuntimePluginCatalogFactoryDefinition>
> {
  return Object.freeze({
    [runtimePluginDiscoveryPluginId]: Object.freeze({
      catalogOwner: 'project02_host',
      construction: 'host_scoped',
      manifest: createRuntimePluginDiscoveryPluginManifest(),
      create: () =>
        createRuntimePluginDiscoveryPlugin(() => ({
          plugins: Object.freeze([]),
          enabledPlugins: Object.freeze([]),
          accessByPluginId: Object.freeze({})
        }))
    } satisfies RuntimePluginCatalogFactoryDefinition),
    [firstPartyModelToolsPluginId]: Object.freeze({
      catalogOwner: 'project02_host',
      construction: 'host_scoped',
      manifest: createFirstPartyModelToolsPluginManifest(),
      create: () => createFirstPartyModelToolsPlugin()
    } satisfies RuntimePluginCatalogFactoryDefinition),
    [characterStatePluginId]: Object.freeze({
      catalogOwner: 'project02_host',
      construction: 'factory',
      manifest: createCharacterStatePluginManifest(),
      create: () => createCharacterStatePlugin()
    } satisfies RuntimePluginCatalogFactoryDefinition)
  });
}

export const hostFirstPartyRuntimePluginIds = Object.freeze(
  Object.values(defaultRuntimePluginCatalogFactoryDefinitions()).map(
    (definition) => definition.manifest.id
  )
);

export const hostScopedFirstPartyRuntimePluginIds = Object.freeze(
  Object.values(defaultRuntimePluginCatalogFactoryDefinitions())
    .filter((definition) => definition.construction === 'host_scoped')
    .map((definition) => definition.manifest.id)
);

const hostFirstPartyRuntimePluginIdSet = new Set<string>(
  hostFirstPartyRuntimePluginIds
);
const hostScopedFirstPartyRuntimePluginIdSet = new Set<string>(
  hostScopedFirstPartyRuntimePluginIds
);

export function hasRuntimePluginCatalogFactoryMetadata(
  definition: RuntimePluginFactoryDefinition
): definition is RuntimePluginCatalogFactoryDefinition {
  if (!('catalogOwner' in definition) || !('construction' in definition)) {
    return false;
  }

  return (
    definition.catalogOwner === 'project02_host' &&
    (definition.construction === 'host_scoped' ||
      definition.construction === 'factory')
  );
}

export function defaultRuntimePluginCatalogManifests(): readonly RuntimePluginManifest[] {
  return Object.freeze(
    Object.values(defaultRuntimePluginCatalogFactoryDefinitions()).map(
      (definition) => definition.manifest
    )
  );
}

export function createHostScopedFirstPartyRuntimePlugins(options: {
  readonly discoveryHostState: RuntimePluginDiscoveryHostState;
}): readonly RuntimePlugin[] {
  return Object.freeze([
    createRuntimePluginDiscoveryPlugin(options.discoveryHostState),
    createFirstPartyModelToolsPlugin()
  ]);
}

export function isHostOwnedFirstPartyRuntimePluginId(pluginId: string): boolean {
  return hostFirstPartyRuntimePluginIdSet.has(pluginId);
}

export function isHostScopedFirstPartyRuntimePluginId(pluginId: string): boolean {
  return hostScopedFirstPartyRuntimePluginIdSet.has(pluginId);
}

export function isHostOwnedFirstPartyRuntimePlugin(
  plugin: RuntimePlugin
): boolean {
  return (
    isRuntimePluginDiscoveryPlugin(plugin) ||
    isFirstPartyModelToolsPlugin(plugin) ||
    isCharacterStatePlugin(plugin)
  );
}

export function isHostScopedFirstPartyRuntimePlugin(
  plugin: RuntimePlugin
): boolean {
  return (
    isRuntimePluginDiscoveryPlugin(plugin) ||
    isFirstPartyModelToolsPlugin(plugin)
  );
}
