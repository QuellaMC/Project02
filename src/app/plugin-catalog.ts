import {
  defaultRuntimePluginHostServiceCatalogEntries,
  isHostOwnedFirstPartyRuntimePluginId,
  isHostScopedFirstPartyRuntimePluginId,
  type RuntimePluginCatalogEntry,
  type RuntimePluginFactoryDefinition as RuntimePluginFactoryDefinitionContract,
  type RuntimePluginFactoryFunction,
  type RuntimePluginPackageCatalogEntry,
} from '../plugins/index.ts';

export type RuntimePluginFactoryDefinition =
  RuntimePluginFactoryDefinitionContract<RuntimePluginFactoryFunction>;

export const defaultRuntimePluginHostServiceEntries =
  defaultRuntimePluginHostServiceCatalogEntries();

export function composeRuntimePluginCatalog(
  factories: Readonly<Record<string, RuntimePluginFactoryDefinition>>,
): {
  readonly catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>;
  readonly defaultEnabledPluginIds: readonly string[];
} {
  const packageEntries = Object.fromEntries(
    Object.entries(factories)
      .filter(([pluginId]) => !isHostScopedFirstPartyRuntimePluginId(pluginId))
      .map(([pluginId, definition]) => [
        pluginId,
        Object.freeze({
          catalogKind: 'package',
          manifest: definition.manifest,
          load: input => definition.create(input),
        } satisfies RuntimePluginPackageCatalogEntry),
      ]),
  );
  const catalogEntries = Object.freeze({
    ...defaultRuntimePluginHostServiceEntries,
    ...packageEntries,
  });
  const defaultEnabledPluginIds = new Set<string>();

  for (const [pluginId, definition] of Object.entries(catalogEntries)) {
    const isHostDefault =
      isHostOwnedFirstPartyRuntimePluginId(pluginId) &&
      definition.catalogKind === 'host_service';
    const isPackageDefault =
      !isHostOwnedFirstPartyRuntimePluginId(pluginId) &&
      definition.catalogKind === 'package';

    if (
      pluginId === definition.manifest.id &&
      (isHostDefault || isPackageDefault) &&
      definition.manifest.activation.defaultEnabled
    ) {
      defaultEnabledPluginIds.add(pluginId);
    }
  }

  return Object.freeze({
    catalogEntries,
    defaultEnabledPluginIds: Object.freeze([...defaultEnabledPluginIds]),
  });
}
