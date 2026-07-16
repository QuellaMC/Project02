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
import type { RuntimePluginPackageCatalogEntry } from './factory.ts';

export type RuntimePluginHostServiceBootstrapInput = {
  readonly hostStateForTurn: RuntimePluginListHostState;
  readonly pluginConfigControl?: RuntimePluginConfigControlHostState;
  readonly storeRoot?: string;
};

export type RuntimePluginHostServiceCatalogEntry = {
  readonly catalogKind: 'host_service';
  readonly manifest: RuntimePluginManifest;
  readonly bootstrap: (
    input: RuntimePluginHostServiceBootstrapInput
  ) => RuntimePlugin;
};

export type RuntimePluginCatalogEntry =
  | RuntimePluginHostServiceCatalogEntry
  | RuntimePluginPackageCatalogEntry;

export function defaultRuntimePluginHostServiceCatalogEntries(): Readonly<
  Record<string, RuntimePluginHostServiceCatalogEntry>
> {
  return Object.freeze({
    [runtimePluginId]: Object.freeze({
      catalogKind: 'host_service',
      manifest: createRuntimePluginManagementPluginManifest(),
      bootstrap: (input) =>
        createRuntimePluginManagementPlugin({
          hostStateForTurn: input.hostStateForTurn,
          ...(input.pluginConfigControl === undefined
            ? {}
            : { pluginConfigControl: input.pluginConfigControl }),
          ...(input.storeRoot === undefined
            ? {}
            : { storeRoot: input.storeRoot })
        })
    } satisfies RuntimePluginHostServiceCatalogEntry),
    [firstPartyModelToolsPluginId]: Object.freeze({
      catalogKind: 'host_service',
      manifest: createFirstPartyModelToolsPluginManifest(),
      bootstrap: () => createFirstPartyModelToolsPlugin()
    } satisfies RuntimePluginHostServiceCatalogEntry)
  });
}

export const hostFirstPartyRuntimePluginIds = Object.freeze(
  [
    ...Object.values(defaultRuntimePluginHostServiceCatalogEntries()).map(
      (definition) => definition.manifest.id
    ),
    characterStatePluginId
  ]
);

export const hostScopedFirstPartyRuntimePluginIds = Object.freeze(
  Object.values(defaultRuntimePluginHostServiceCatalogEntries())
    .map((definition) => definition.manifest.id)
);

const hostFirstPartyRuntimePluginIdSet = new Set<string>(
  hostFirstPartyRuntimePluginIds
);
const hostScopedFirstPartyRuntimePluginIdSet = new Set<string>(
  hostScopedFirstPartyRuntimePluginIds
);

export function createHostScopedFirstPartyRuntimePlugins(options: {
  readonly hostStateForTurn: RuntimePluginListHostState;
  readonly pluginConfigControl?: RuntimePluginConfigControlHostState;
  readonly storeRoot?: string;
}): readonly RuntimePlugin[] {
  return Object.freeze(
    Object.values(defaultRuntimePluginHostServiceCatalogEntries()).map(
      (entry) => entry.bootstrap(options)
    )
  );
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
