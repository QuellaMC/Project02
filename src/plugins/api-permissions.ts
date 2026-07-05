import { isCharacterStatePlugin } from './builtin/character-state/index.ts';
import {
  assertUniqueRuntimePluginIds,
  isFirstPartyModelToolsPlugin,
  normalizeRuntimePluginApiPermissions,
  runtimePluginApiAccessAllows,
  runtimePluginApiAccessFor
} from './types.ts';
import type {
  RuntimePlugin,
  RuntimePluginApiAccess,
  RuntimePluginApiName,
  RuntimePluginApiPermissionSnapshot,
  RuntimePluginApiPermissions
} from './types.ts';

export const runtimePluginDiscoveryPluginId =
  'runtime.plugin_discovery';

export type RuntimePluginApiPermissionsByPluginId = Readonly<
  Record<string, RuntimePluginApiPermissionSnapshot>
>;

export function resolveRuntimePluginApiPermissionsForPlugins(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly enabledPluginIds: readonly string[];
}): RuntimePluginApiPermissionsByPluginId {
  assertUniqueRuntimePluginIds(options.plugins);

  const enabledPluginIds = new Set(options.enabledPluginIds);

  return Object.freeze(
    Object.fromEntries(
      options.plugins.map((plugin) => [
        plugin.manifest.id,
        resolveRuntimePluginApiPermissionsForPlugin({
          plugin,
          enabled: enabledPluginIds.has(plugin.manifest.id)
        })
      ])
    )
  );
}

export function runtimePluginApiPermissionsForPlugin(options: {
  readonly plugin: RuntimePlugin;
  readonly apiPermissionsByPluginId: RuntimePluginApiPermissionsByPluginId;
}): RuntimePluginApiPermissionSnapshot {
  const apiPermissions =
    options.apiPermissionsByPluginId[options.plugin.manifest.id];

  if (apiPermissions === undefined) {
    throw new TypeError(
      `Plugin "${options.plugin.manifest.id}" is missing resolved API permissions.`
    );
  }

  return apiPermissions;
}

export function resolveRuntimePluginApiPermissionsForPlugin(options: {
  readonly plugin: RuntimePlugin;
  readonly enabled: boolean;
}): RuntimePluginApiPermissionSnapshot {
  return runtimePluginApiPermissionSnapshot({
    requestedApis: options.plugin.manifest.requestedApis,
    enabled: options.enabled,
    fieldPrefix: options.plugin.manifest.id
  });
}

export function runtimePluginApiPermissionSnapshot(options: {
  readonly requestedApis: RuntimePluginApiPermissions;
  readonly enabled: boolean;
  readonly fieldPrefix?: string;
}): RuntimePluginApiPermissionSnapshot {
  const fieldPrefix = options.fieldPrefix ?? 'plugin';
  const requestedApis = normalizeRuntimePluginApiPermissions(
    options.requestedApis,
    `${fieldPrefix}.requestedApis`
  );

  return Object.freeze({
    requestedApis,
    grantedApis: options.enabled ? requestedApis : Object.freeze({})
  } satisfies RuntimePluginApiPermissionSnapshot);
}

export function runtimePluginGrantsApiAccess(options: {
  readonly apiPermissions: RuntimePluginApiPermissionSnapshot;
  readonly api: RuntimePluginApiName;
  readonly access: RuntimePluginApiAccess;
}): boolean {
  return runtimePluginApiAccessAllows(
    runtimePluginApiAccessFor(options.apiPermissions.grantedApis, options.api),
    options.access
  );
}

export function isHostDefaultEnabledRuntimePlugin(
  plugin: RuntimePlugin
): boolean {
  return (
    plugin.manifest.id === runtimePluginDiscoveryPluginId ||
    isCharacterStatePlugin(plugin) ||
    isFirstPartyModelToolsPlugin(plugin)
  );
}
