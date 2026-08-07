import {
  defaultRuntimePluginHostServiceCatalogEntries,
  isHostOwnedFirstPartyRuntimePluginId,
  isHostScopedFirstPartyRuntimePluginId,
  type RuntimePluginCatalogEntry,
  type RuntimePluginFactoryDefinition as RuntimePluginFactoryDefinitionContract,
  type RuntimePluginFactoryFunction,
  type RuntimePluginPackageCatalogEntry,
} from '../plugins/index.ts';
import type {DiscoveredRuntimePluginPackage} from '../plugins/package-loader/index.ts';
import {acceptRuntimePluginPackageCandidate} from '../plugins/package-loader/index.ts';

export type RuntimePluginFactoryDefinition =
  RuntimePluginFactoryDefinitionContract<RuntimePluginFactoryFunction>;

export const defaultRuntimePluginHostServiceEntries =
  defaultRuntimePluginHostServiceCatalogEntries();

export function composeRuntimePluginCatalog(options: {
  readonly discoveredPackages?: readonly DiscoveredRuntimePluginPackage[];
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
}): {
  readonly catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>;
  readonly defaultEnabledPluginIds: readonly string[];
} {
  const discoveredPackages = options.discoveredPackages ?? [];
  const factoryEntries = Object.fromEntries(
    Object.entries(options.factories ?? {})
      .filter(([pluginId]) => !isHostScopedFirstPartyRuntimePluginId(pluginId))
      .map(([pluginId, definition]) => [
        pluginId,
        Object.freeze({
          catalogKind: 'package',
          manifest: definition.manifest,
          load: async (input, loadOptions) =>
            acceptRuntimePluginPackageCandidate({
              manifest: definition.manifest,
              candidate: await definition.create(input),
              ...(loadOptions?.retainRejectedCandidate === undefined
                ? {}
                : {
                    retainRejectedCandidate:
                      loadOptions.retainRejectedCandidate,
                  }),
            }),
        } satisfies RuntimePluginPackageCatalogEntry),
      ]),
  );
  const catalogEntries = Object.freeze({
    ...defaultRuntimePluginHostServiceEntries,
    ...Object.fromEntries(
      discoveredPackages.map(item => [item.manifest.id, item]),
    ),
    ...factoryEntries,
  });
  const overriddenPluginIds = new Set(Object.keys(options.factories ?? {}));
  const defaultEnabledPluginIds = new Set<string>();

  for (const definition of Object.values(
    defaultRuntimePluginHostServiceEntries,
  )) {
    if (definition.manifest.activation.defaultEnabled) {
      defaultEnabledPluginIds.add(definition.manifest.id);
    }
  }
  for (const item of discoveredPackages) {
    if (
      item.provenance === 'bundled' &&
      item.manifest.activation.defaultEnabled &&
      !overriddenPluginIds.has(item.manifest.id)
    ) {
      defaultEnabledPluginIds.add(item.manifest.id);
    }
  }
  for (const [pluginId, entry] of Object.entries(factoryEntries)) {
    if (
      pluginId === entry.manifest.id &&
      !isHostOwnedFirstPartyRuntimePluginId(pluginId) &&
      entry.manifest.activation.defaultEnabled
    ) {
      defaultEnabledPluginIds.add(pluginId);
    }
  }

  return Object.freeze({
    catalogEntries,
    defaultEnabledPluginIds: Object.freeze([...defaultEnabledPluginIds]),
  });
}
