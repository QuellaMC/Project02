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

export type RuntimePluginCatalogFactoryDefinition = {
  readonly manifest: RuntimePluginManifest;
  readonly create: () => RuntimePlugin;
};

export type RuntimePluginDiscoveryHostState = () => {
  readonly plugins: readonly RuntimePlugin[];
  readonly enabledPlugins: readonly RuntimePlugin[];
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
};

export const hostFirstPartyRuntimePluginIds = Object.freeze([
  runtimePluginDiscoveryPluginId,
  firstPartyModelToolsPluginId,
  characterStatePluginId
] as const);

export const hostScopedFirstPartyRuntimePluginIds = Object.freeze([
  runtimePluginDiscoveryPluginId,
  firstPartyModelToolsPluginId
] as const);

export const defaultEnabledFirstPartyRuntimePluginIds = Object.freeze([
  ...hostFirstPartyRuntimePluginIds
] as const);

const hostFirstPartyRuntimePluginIdSet = new Set<string>(
  hostFirstPartyRuntimePluginIds
);
const hostScopedFirstPartyRuntimePluginIdSet = new Set<string>(
  hostScopedFirstPartyRuntimePluginIds
);
const defaultEnabledFirstPartyRuntimePluginIdSet = new Set<string>(
  defaultEnabledFirstPartyRuntimePluginIds
);

export function defaultRuntimePluginCatalogFactoryDefinitions(): Readonly<
  Record<string, RuntimePluginCatalogFactoryDefinition>
> {
  return Object.freeze({
    [runtimePluginDiscoveryPluginId]: Object.freeze({
      manifest: createRuntimePluginDiscoveryPluginManifest(),
      create: () =>
        createRuntimePluginDiscoveryPlugin(() => ({
          plugins: Object.freeze([]),
          enabledPlugins: Object.freeze([]),
          accessByPluginId: Object.freeze({})
        }))
    } satisfies RuntimePluginCatalogFactoryDefinition),
    [firstPartyModelToolsPluginId]: Object.freeze({
      manifest: createFirstPartyModelToolsPluginManifest(),
      create: () => createFirstPartyModelToolsPlugin()
    } satisfies RuntimePluginCatalogFactoryDefinition),
    [characterStatePluginId]: Object.freeze({
      manifest: createCharacterStatePluginManifest(),
      create: () => createCharacterStatePlugin()
    } satisfies RuntimePluginCatalogFactoryDefinition)
  });
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

export function isDefaultEnabledFirstPartyRuntimePluginId(
  pluginId: string
): boolean {
  return defaultEnabledFirstPartyRuntimePluginIdSet.has(pluginId);
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
