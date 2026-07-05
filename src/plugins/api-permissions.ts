import { characterStatePluginId } from './builtin/character-state/index.ts';
import {
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

export function resolveRuntimePluginApiPermissionsForPlugins(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly explicitAllowedApisByPluginId: Readonly<
    Record<string, RuntimePluginApiPermissions>
  >;
}): RuntimePluginApiPermissionsByPluginId {
  const explicitAllowedApisByPluginId = normalizeAllowedApisByPluginId(
    options.explicitAllowedApisByPluginId
  );

  return Object.freeze(
    Object.fromEntries(
      options.plugins.map((plugin) => [
        plugin.manifest.id,
        resolveRuntimePluginApiPermissionsForManifest({
          manifest: plugin.manifest,
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

export function resolveRuntimePluginApiPermissionsForManifest(options: {
  readonly manifest: RuntimePlugin['manifest'];
  readonly explicitAllowedApisByPluginId: Readonly<
    Record<string, RuntimePluginApiPermissions>
  >;
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
    explicitAllowedApis ?? defaultAllowedApisForPluginId(options.manifest.id),
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

function defaultAllowedApisForPluginId(
  pluginId: string
): RuntimePluginApiPermissions {
  if (pluginId === characterStatePluginId) {
    return Object.freeze({ file_store: 'write' });
  }

  if (
    pluginId === runtimePluginDiscoveryPluginId ||
    pluginId === firstPartyModelToolsPluginId
  ) {
    return Object.freeze({});
  }

  return Object.freeze({});
}
