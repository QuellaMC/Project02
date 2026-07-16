import {
  createFirstPartyModelToolsPlugin,
  createFirstPartyModelToolsPluginManifest,
  isFirstPartyModelToolsPlugin
} from './builtin/model-tools.ts';
import {
  createRuntimePluginManagementPlugin,
  createRuntimePluginManagementPluginManifest,
  isRuntimePluginManagementPlugin,
  type RuntimePluginListHostState,
  type RuntimePluginConfigControlHostState
} from './builtin/runtime-plugin/index.ts';
import {
  characterStatePluginId,
  firstPartyModelToolsPluginId,
  runtimePluginId
} from './contract.ts';
import type {
  RuntimePlugin,
  RuntimePluginManifest
} from './plugin-types.ts';
import type {
  RuntimePluginFactoryDefinition
} from './factory.ts';
import type {
  RuntimePluginToolConfirmationHandler
} from './tool-confirmation.ts';

export type RuntimePluginCatalogFactoryDefinition =
  RuntimePluginFactoryDefinition<() => RuntimePlugin> & {
    readonly catalogOwner: 'project02_host';
    readonly construction: 'host_scoped' | 'factory';
  };

export function defaultRuntimePluginCatalogFactoryDefinitions(): Readonly<
  Record<string, RuntimePluginCatalogFactoryDefinition>
> {
  return Object.freeze({
    [runtimePluginId]: Object.freeze({
      catalogOwner: 'project02_host',
      construction: 'host_scoped',
      manifest: createRuntimePluginManagementPluginManifest(),
      create: () =>
        createRuntimePluginManagementPlugin({
          hostStateForTurn: () => ({
            plugins: Object.freeze([]),
            enabledPlugins: Object.freeze([]),
            accessByPluginId: Object.freeze({})
          }),
          pluginConfigControl: {
            pluginManifests: defaultRuntimePluginCatalogManifests()
          }
        })
    } satisfies RuntimePluginCatalogFactoryDefinition),
    [firstPartyModelToolsPluginId]: Object.freeze({
      catalogOwner: 'project02_host',
      construction: 'host_scoped',
      manifest: createFirstPartyModelToolsPluginManifest(),
      create: () => createFirstPartyModelToolsPlugin()
    } satisfies RuntimePluginCatalogFactoryDefinition)
  });
}

export const hostFirstPartyRuntimePluginIds = Object.freeze(
  [
    ...Object.values(defaultRuntimePluginCatalogFactoryDefinitions()).map(
      (definition) => definition.manifest.id
    ),
    characterStatePluginId
  ]
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
  readonly hostStateForTurn: RuntimePluginListHostState;
  readonly pluginConfigControl?: RuntimePluginConfigControlHostState;
  readonly storeRoot?: string;
  readonly toolConfirmationHandler?: RuntimePluginToolConfirmationHandler;
}): readonly RuntimePlugin[] {
  return Object.freeze([
    createRuntimePluginManagementPlugin({
      hostStateForTurn: options.hostStateForTurn,
      ...(options.pluginConfigControl === undefined
        ? {}
        : { pluginConfigControl: options.pluginConfigControl }),
      ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
      ...(options.toolConfirmationHandler === undefined
        ? {}
        : { confirmationHandler: options.toolConfirmationHandler })
    }),
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
    isRuntimePluginManagementPlugin(plugin) ||
    isFirstPartyModelToolsPlugin(plugin)
  );
}

export function isHostScopedFirstPartyRuntimePlugin(
  plugin: RuntimePlugin
): boolean {
  return (
    isRuntimePluginManagementPlugin(plugin) ||
    isFirstPartyModelToolsPlugin(plugin)
  );
}
