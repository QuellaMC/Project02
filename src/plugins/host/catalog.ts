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
  sessionHistoryPluginId,
} from '../api/contract.ts';
import {ownJsonRecordValue} from '../../shared/json-boundary.ts';
import type {RuntimePlugin, RuntimePluginManifest} from '../api/types.ts';
import type {RuntimePluginPackageCatalogEntry} from '../api/factory.ts';

type RuntimePluginHostServiceBootstrapInput = {
  readonly hostStateForTurn: RuntimePluginListHostState;
  readonly pluginConfigControl?: RuntimePluginConfigControlHostState;
};

type RuntimePluginHostServiceCatalogEntry = {
  readonly catalogKind: 'host_service';
  readonly manifest: RuntimePluginManifest;
  readonly bootstrap: (
    input: RuntimePluginHostServiceBootstrapInput,
  ) => RuntimePlugin;
};

export type RuntimePluginCatalogEntry =
  RuntimePluginHostServiceCatalogEntry | RuntimePluginPackageCatalogEntry;

/**
 * Requested ids arrive as untrusted data, so inherited keys must not resolve.
 * A manifest that does not claim its key would edit the wrong plugin.
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
  sessionHistoryPluginId,
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

/** Absent an explicit selection, host-owned defaults decide enablement. */
export function enabledPluginIdsForHost(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly enabledPluginIds: readonly string[] | undefined;
}): readonly string[] {
  if (options.enabledPluginIds === undefined) {
    return Object.freeze(
      options.plugins
        .filter(
          plugin =>
            isHostOwnedFirstPartyRuntimePlugin(plugin) &&
            plugin.manifest.activation.defaultEnabled,
        )
        .map(plugin => plugin.manifest.id),
    );
  }

  const pluginIds = new Set(options.plugins.map(plugin => plugin.manifest.id));
  const seenEnabledIds = new Set<string>();
  const enabledIds: string[] = [];

  for (const enabledId of options.enabledPluginIds) {
    if (!pluginIds.has(enabledId)) {
      throw new TypeError(`Unknown enabled plugin id "${enabledId}".`);
    }

    if (seenEnabledIds.has(enabledId)) {
      throw new TypeError(`Duplicate enabled plugin id "${enabledId}".`);
    }

    seenEnabledIds.add(enabledId);
    enabledIds.push(enabledId);
  }

  return Object.freeze(enabledIds);
}
