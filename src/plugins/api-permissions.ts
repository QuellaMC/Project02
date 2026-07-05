import { isCharacterStatePlugin } from './builtin/character-state/index.ts';
import {
  assertUniqueRuntimePluginIds,
  firstPartyModelToolsPluginId,
  minRuntimePluginApiAccess,
  normalizeRuntimePluginApiPermissions,
  runtimePluginApiAccessFor,
  runtimePluginApiNames
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

export const characterStateDefaultAllowedApis = Object.freeze({
  file_store: 'write'
} satisfies RuntimePluginApiPermissions);

export function resolveRuntimePluginApiPermissionsForPlugins(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly explicitAllowedApisByPluginId: Readonly<
    Record<string, RuntimePluginApiPermissions>
  >;
}): RuntimePluginApiPermissionsByPluginId {
  assertUniqueRuntimePluginIds(options.plugins);

  const explicitAllowedApisByPluginId = normalizeAllowedApisByPluginId(
    options.explicitAllowedApisByPluginId
  );

  return Object.freeze(
    Object.fromEntries(
      options.plugins.map((plugin) => [
        plugin.manifest.id,
        resolveRuntimePluginApiPermissionsForPlugin({
          plugin,
          explicitAllowedApisByPluginId
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
  readonly explicitAllowedApisByPluginId: Readonly<
    Record<string, RuntimePluginApiPermissions>
  >;
}): RuntimePluginApiPermissionSnapshot {
  return resolveRuntimePluginApiPermissionsForManifest({
    manifest: options.plugin.manifest,
    explicitAllowedApisByPluginId: options.explicitAllowedApisByPluginId,
    defaultAllowedApis: defaultAllowedApisForPlugin(options.plugin)
  });
}

export function resolveRuntimePluginApiPermissionsForManifest(options: {
  readonly manifest: RuntimePlugin['manifest'];
  readonly explicitAllowedApisByPluginId: Readonly<
    Record<string, RuntimePluginApiPermissions>
  >;
  readonly defaultAllowedApis?: RuntimePluginApiPermissions;
}): RuntimePluginApiPermissionSnapshot {
  const requestedApis = normalizeRuntimePluginApiPermissions(
    options.manifest.requestedApis,
    `${options.manifest.id}.requestedApis`
  );
  const explicitAllowedApisByPluginId = normalizeAllowedApisByPluginId(
    options.explicitAllowedApisByPluginId
  );
  const explicitAllowedApis = Object.hasOwn(
    explicitAllowedApisByPluginId,
    options.manifest.id
  )
    ? explicitAllowedApisByPluginId[options.manifest.id]
    : undefined;
  const allowedApis = normalizeRuntimePluginApiPermissions(
    explicitAllowedApis ?? options.defaultAllowedApis ?? {},
    `${options.manifest.id}.allowedApis`
  );
  const effectiveApis: Partial<Record<RuntimePluginApiName, RuntimePluginApiAccess>> = {};

  for (const api of runtimePluginApiNames) {
    const requested = runtimePluginApiAccessFor(requestedApis, api);
    const allowed = runtimePluginApiAccessFor(allowedApis, api);
    const effective = minRuntimePluginApiAccess(requested, allowed);

    if (effective !== 'none') {
      effectiveApis[api] = effective;
    }
  }

  return Object.freeze({
    requestedApis,
    allowedApis,
    effectiveApis: normalizeRuntimePluginApiPermissions(
      effectiveApis,
      `${options.manifest.id}.effectiveApis`
    )
  } satisfies RuntimePluginApiPermissionSnapshot);
}

function normalizeAllowedApisByPluginId(
  value: Readonly<Record<string, RuntimePluginApiPermissions>>
): Readonly<Record<string, RuntimePluginApiPermissions>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([pluginId, permissions]) => [
          pluginId,
          normalizeRuntimePluginApiPermissions(
            permissions,
            `allowedApisByPluginId.${pluginId}`
          )
        ])
    )
  );
}

function defaultAllowedApisForPlugin(plugin: RuntimePlugin): RuntimePluginApiPermissions {
  if (isCharacterStatePlugin(plugin)) {
    return characterStateDefaultAllowedApis;
  }

  if (
    plugin.manifest.id === runtimePluginDiscoveryPluginId ||
    plugin.manifest.id === firstPartyModelToolsPluginId
  ) {
    return Object.freeze({});
  }

  return Object.freeze({});
}
