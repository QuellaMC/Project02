import {
  createFirstPartyModelToolsPlugin,
  createFirstPartyModelToolsPluginManifest,
  isFirstPartyModelToolsPlugin,
} from '../builtin/model-tools/index.ts';
import {
  createRuntimePluginManagementPlugin,
  createRuntimePluginManagementPluginManifest,
  isRuntimePluginManagementPlugin,
  type RuntimePluginListHostState,
  type RuntimePluginConfigControlHostState,
} from '../builtin/plugin-management/index.ts';
import {
  characterStatePluginId,
  firstPartyModelToolsPluginId,
  runtimePluginId,
} from '../api/contract.ts';
import {ownJsonRecordValue} from '../../shared/json-boundary.ts';
import type {RuntimePlugin, RuntimePluginManifest} from '../api/types.ts';
import type {RuntimePluginPackageCatalogEntry} from '../api/factory.ts';

export type RuntimePluginHostServiceBootstrapInput = {
  readonly hostStateForTurn: RuntimePluginListHostState;
  readonly pluginConfigControl?: RuntimePluginConfigControlHostState;
};

export type RuntimePluginHostServiceCatalogEntry = {
  readonly catalogKind: 'host_service';
  readonly manifest: RuntimePluginManifest;
  readonly bootstrap: (
    input: RuntimePluginHostServiceBootstrapInput,
  ) => RuntimePlugin;
};

export type RuntimePluginCatalogEntry =
  RuntimePluginHostServiceCatalogEntry | RuntimePluginPackageCatalogEntry;

/**
 * The one answer to "does this requested id name an installed plugin".
 *
 * Requested ids arrive from operator arguments and model tool input, so
 * the catalog map is read as data: `constructor`, `toString`, and every
 * other `Object.prototype` key resolve to an inherited function on a
 * plain index, which then fails on `.manifest` instead of reporting the
 * plugin as uninstalled. The manifest must also claim the key it was
 * filed under, because a catalog entry keyed by one id and manifesting
 * another would otherwise apply an edit to a different plugin than the
 * caller named.
 */
export function installedRuntimePluginCatalogEntry(
  catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>,
  pluginId: string,
): RuntimePluginCatalogEntry | undefined {
  const entry = ownJsonRecordValue(catalogEntries, pluginId);

  return entry === undefined || entry.manifest.id !== pluginId
    ? undefined
    : entry;
}

export function defaultRuntimePluginHostServiceCatalogEntries(): Readonly<
  Record<string, RuntimePluginHostServiceCatalogEntry>
> {
  return Object.freeze({
    [runtimePluginId]: Object.freeze({
      catalogKind: 'host_service',
      manifest: createRuntimePluginManagementPluginManifest(),
      bootstrap: input =>
        createRuntimePluginManagementPlugin({
          hostStateForTurn: input.hostStateForTurn,
          ...(input.pluginConfigControl === undefined
            ? {}
            : {pluginConfigControl: input.pluginConfigControl}),
        }),
    } satisfies RuntimePluginHostServiceCatalogEntry),
    [firstPartyModelToolsPluginId]: Object.freeze({
      catalogKind: 'host_service',
      manifest: createFirstPartyModelToolsPluginManifest(),
      bootstrap: () => createFirstPartyModelToolsPlugin(),
    } satisfies RuntimePluginHostServiceCatalogEntry),
  });
}

export const hostFirstPartyRuntimePluginIds = Object.freeze([
  ...Object.values(defaultRuntimePluginHostServiceCatalogEntries()).map(
    definition => definition.manifest.id,
  ),
  characterStatePluginId,
]);

export const hostScopedFirstPartyRuntimePluginIds = Object.freeze(
  Object.values(defaultRuntimePluginHostServiceCatalogEntries()).map(
    definition => definition.manifest.id,
  ),
);

const hostFirstPartyRuntimePluginIdSet = new Set<string>(
  hostFirstPartyRuntimePluginIds,
);
const hostScopedFirstPartyRuntimePluginIdSet = new Set<string>(
  hostScopedFirstPartyRuntimePluginIds,
);

export function createHostScopedFirstPartyRuntimePlugins(options: {
  readonly hostStateForTurn: RuntimePluginListHostState;
  readonly pluginConfigControl?: RuntimePluginConfigControlHostState;
}): readonly RuntimePlugin[] {
  return Object.freeze(
    Object.values(defaultRuntimePluginHostServiceCatalogEntries()).map(entry =>
      entry.bootstrap(options),
    ),
  );
}

export function isHostOwnedFirstPartyRuntimePluginId(
  pluginId: string,
): boolean {
  return hostFirstPartyRuntimePluginIdSet.has(pluginId);
}

export function isHostScopedFirstPartyRuntimePluginId(
  pluginId: string,
): boolean {
  return hostScopedFirstPartyRuntimePluginIdSet.has(pluginId);
}

export function isHostOwnedFirstPartyRuntimePlugin(
  plugin: RuntimePlugin,
): boolean {
  return (
    isRuntimePluginManagementPlugin(plugin) ||
    isFirstPartyModelToolsPlugin(plugin)
  );
}
