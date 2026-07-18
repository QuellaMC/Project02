import {
  hostFirstPartyRuntimePluginIds
} from '../../src/plugins/host/catalog.ts';
import { testRuntimePluginFileStoreProvider } from './plugin-host-fixtures.ts';
import {
  characterStatePluginId,
  firstPartyModelToolsPluginId,
  runtimePluginId
} from '../../src/plugins/api/contract.ts';
import {
  createRuntimePluginHost,
  type CreateRuntimePluginHostOptions,
  type RuntimePluginHost
} from '../../src/plugins/host/index.ts';
import {
  bundledRuntimePluginPackageRoot,
  discoverRuntimePluginPackages
} from '../../src/plugins/package-loader/index.ts';

const bundledPackageDiscovery = discoverRuntimePluginPackages({
  sources: [
    {
      root: bundledRuntimePluginPackageRoot,
      provenance: 'bundled'
    }
  ],
  reservedPluginIds: hostFirstPartyRuntimePluginIds
});
const characterStatePackage = bundledPackageDiscovery.packages.find(
  (entry) => entry.manifest.id === characterStatePluginId
);

if (
  bundledPackageDiscovery.diagnostics.length > 0 ||
  characterStatePackage === undefined
) {
  throw new TypeError(
    'Default test plugin host could not discover the bundled Character State package.'
  );
}

const characterStatePlugin = await characterStatePackage.load({
  pluginId: characterStatePackage.manifest.id,
  manifest: characterStatePackage.manifest,
  storeRoot: bundledRuntimePluginPackageRoot,
  resolvedConfig: Object.freeze({}),
  redactedConfig: Object.freeze({})
});

export function createDefaultProject02PluginHost(
  options: Omit<CreateRuntimePluginHostOptions, 'plugins'> = {}
): RuntimePluginHost {
  return createRuntimePluginHost({
    fileStore: testRuntimePluginFileStoreProvider,
    ...options,
    plugins: [characterStatePlugin],
    enabledPluginIds:
      options.enabledPluginIds ?? [
        runtimePluginId,
        firstPartyModelToolsPluginId,
        characterStatePluginId
      ]
  });
}
