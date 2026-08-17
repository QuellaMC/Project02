import {
  runtimePluginAccessLevelValues,
  runtimePluginAccessNameValues,
  type RuntimePluginAccessLevel,
  type RuntimePluginAccessMap,
  type RuntimePluginAccessName,
  type RuntimePluginAccessSnapshot,
} from '../api/contract.ts';
import type {RuntimePlugin} from '../api/types.ts';
import {assertUniqueRuntimePluginIds} from '../api/identity.ts';
import {isRecord} from '../api/validation-primitives.ts';
import {ownJsonRecordValue} from '../../shared/json-boundary.ts';
import {isOneOf} from '../../shared/one-of.ts';

export type RuntimePluginAccessMapByPluginId = Readonly<
  Record<string, RuntimePluginAccessSnapshot>
>;

export function resolveRuntimePluginAccessForPlugins(options: {
  readonly plugins: readonly RuntimePlugin[];
  readonly enabledPluginIds: readonly string[];
  readonly trustedContextEligiblePluginIds?: ReadonlySet<string>;
}): RuntimePluginAccessMapByPluginId {
  assertUniqueRuntimePluginIds(options.plugins);

  const enabledPluginIds = new Set(options.enabledPluginIds);

  return Object.freeze(
    Object.fromEntries(
      options.plugins.map(plugin => [
        plugin.manifest.id,
        resolveRuntimePluginAccessForPlugin({
          plugin,
          enabled: enabledPluginIds.has(plugin.manifest.id),
          trustedContextEligible:
            options.trustedContextEligiblePluginIds?.has(plugin.manifest.id) ===
            true,
        }),
      ]),
    ),
  );
}

export function runtimePluginAccessForPlugin(options: {
  readonly plugin: RuntimePlugin;
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
}): RuntimePluginAccessSnapshot {
  return runtimePluginAccessForPluginId({
    pluginId: options.plugin.manifest.id,
    accessByPluginId: options.accessByPluginId,
  });
}

export function runtimePluginAccessForPluginId(options: {
  readonly pluginId: string;
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
}): RuntimePluginAccessSnapshot {
  const access = ownJsonRecordValue(options.accessByPluginId, options.pluginId);

  if (access === undefined) {
    throw new TypeError(
      `Plugin "${options.pluginId}" is missing resolved access.`,
    );
  }

  return access;
}

function resolveRuntimePluginAccessForPlugin(options: {
  readonly plugin: RuntimePlugin;
  readonly enabled: boolean;
  readonly trustedContextEligible: boolean;
}): RuntimePluginAccessSnapshot {
  return runtimePluginAccessSnapshot({
    requestedAccess: options.plugin.manifest.requestedAccess,
    enabled: options.enabled,
    fieldPrefix: options.plugin.manifest.id,
    trustedContextEligible: options.trustedContextEligible,
  });
}

export function runtimePluginAccessSnapshot(options: {
  readonly requestedAccess: RuntimePluginAccessMap;
  readonly enabled: boolean;
  readonly fieldPrefix?: string;
  /**
   * Provenance decision made by the composition root: only bundled
   * first-party packages may hold trusted_context, whatever the manifest
   * requests. Defaults closed.
   */
  readonly trustedContextEligible?: boolean;
}): RuntimePluginAccessSnapshot {
  const fieldPrefix = options.fieldPrefix ?? 'plugin';
  const requestedAccess = normalizeRuntimePluginAccessMap(
    options.requestedAccess,
    `${fieldPrefix}.requestedAccess`,
  );
  const grantedAccess =
    options.trustedContextEligible === true ||
    !Object.hasOwn(requestedAccess, 'trusted_context')
      ? requestedAccess
      : withoutTrustedContextAccess(requestedAccess);

  return Object.freeze({
    requestedAccess,
    grantedAccess: options.enabled ? grantedAccess : Object.freeze({}),
  } satisfies RuntimePluginAccessSnapshot);
}

function withoutTrustedContextAccess(
  accessMap: RuntimePluginAccessMap,
): RuntimePluginAccessMap {
  const {trusted_context: withheld, ...grantable} = accessMap;

  void withheld;
  return Object.freeze(grantable);
}

export function runtimePluginGrantsAccess(options: {
  readonly access: RuntimePluginAccessSnapshot;
  readonly accessName: RuntimePluginAccessName;
  readonly requiredAccess: RuntimePluginAccessLevel;
}): boolean {
  return runtimePluginAccessAllows(
    runtimePluginAccessFor(options.access.grantedAccess, options.accessName),
    options.requiredAccess,
  );
}

function runtimePluginAccessRank(access: RuntimePluginAccessLevel): number {
  switch (access) {
    case 'none':
      return 0;
    case 'read':
      return 1;
    case 'write':
      return 2;
  }
}

function normalizeRuntimePluginAccessLevel(
  value: unknown,
  field = 'access level',
): RuntimePluginAccessLevel {
  if (!isOneOf(value, runtimePluginAccessLevelValues)) {
    throw new TypeError(`${field} must be "none", "read", or "write".`);
  }

  return value;
}

export function runtimePluginAccessFor(
  accessMap: RuntimePluginAccessMap,
  accessName: RuntimePluginAccessName,
): RuntimePluginAccessLevel {
  if (!Object.hasOwn(accessMap, accessName)) {
    return 'none';
  }

  return accessMap[accessName] ?? 'none';
}

export function runtimePluginAccessAllows(
  access: RuntimePluginAccessLevel,
  required: RuntimePluginAccessLevel,
): boolean {
  return runtimePluginAccessRank(access) >= runtimePluginAccessRank(required);
}

export function normalizeRuntimePluginAccessMap(
  value: unknown,
  field = 'access map',
): RuntimePluginAccessMap {
  if (value === undefined) {
    return Object.freeze({});
  }

  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object.`);
  }

  const knownNames = new Set<string>(runtimePluginAccessNameValues);
  const accessMap: Partial<
    Record<RuntimePluginAccessName, RuntimePluginAccessLevel>
  > = {};

  for (const key of Object.keys(value)) {
    if (!knownNames.has(key)) {
      throw new TypeError(`${field} contains unknown access "${key}".`);
    }
  }

  for (const accessName of runtimePluginAccessNameValues) {
    if (!Object.hasOwn(value, accessName)) {
      continue;
    }

    const access = value[accessName];

    if (access === undefined) {
      continue;
    }

    accessMap[accessName] = normalizeRuntimePluginAccessLevel(
      access,
      `${field}.${accessName}`,
    );
  }

  return Object.freeze(accessMap);
}

/** Fails at host construction, not first use; the engine has no default. */
export function assertRuntimePluginFileStoreProviderPresent(options: {
  readonly enabledPlugins: readonly RuntimePlugin[];
  readonly accessByPluginId: RuntimePluginAccessMapByPluginId;
  readonly hasFileStoreProvider: boolean;
}): void {
  if (options.hasFileStoreProvider) {
    return;
  }

  for (const accessName of ['file_store', 'character_file_store'] as const) {
    const grantedPlugin = options.enabledPlugins.find(plugin =>
      runtimePluginGrantsAccess({
        access: runtimePluginAccessForPlugin({
          plugin,
          accessByPluginId: options.accessByPluginId,
        }),
        accessName,
        requiredAccess: 'read',
      }),
    );

    if (grantedPlugin !== undefined) {
      throw new TypeError(
        `Plugin "${grantedPlugin.manifest.id}" is granted ${accessName} ` +
          'access, but the host was created without a file-store provider. ' +
          'Pass createRuntimePluginHost({ fileStore }) or compose the host ' +
          'through the configured plugin activation factory.',
      );
    }
  }
}
