import {hostFirstPartyRuntimePluginIds} from '../../src/plugins/host/catalog.ts';
import {testRuntimePluginFileStoreProvider} from './plugin-host-fixtures.ts';
import {
  characterStatePluginId,
  firstPartyModelToolsPluginId,
  runtimePluginId,
  sessionHistoryPluginId,
} from '../../src/plugins/api/contract.ts';
import {
  createRuntimePluginHost,
  type CreateRuntimePluginHostOptions,
  type RuntimePluginHost,
} from '../../src/plugins/host/index.ts';
import {
  bundledRuntimePluginPackageRoot,
  discoverRuntimePluginPackages,
} from '../../src/plugins/package-loader/index.ts';

const bundledPackageDiscovery = discoverRuntimePluginPackages({
  sources: [
    {
      root: bundledRuntimePluginPackageRoot,
    },
  ],
  reservedPluginIds: hostFirstPartyRuntimePluginIds,
});
async function loadBundledPlugin(pluginId: string) {
  const bundledPackage = bundledPackageDiscovery.packages.find(
    entry => entry.manifest.id === pluginId,
  );

  if (
    bundledPackageDiscovery.diagnostics.length > 0 ||
    bundledPackage === undefined
  ) {
    throw new TypeError(
      `Default test plugin host could not discover the bundled "${pluginId}" package.`,
    );
  }

  return await bundledPackage.load({
    pluginId: bundledPackage.manifest.id,
    manifest: bundledPackage.manifest,
    storeRoot: bundledRuntimePluginPackageRoot,
    resolvedConfig: Object.freeze({}),
    redactedConfig: Object.freeze({}),
  });
}

const characterStatePlugin = await loadBundledPlugin(characterStatePluginId);
const sessionHistoryPlugin = await loadBundledPlugin(sessionHistoryPluginId);

export function createDefaultProject02PluginHost(
  options: Omit<CreateRuntimePluginHostOptions, 'plugins'> = {},
): RuntimePluginHost {
  return createRuntimePluginHost({
    fileStore: testRuntimePluginFileStoreProvider,
    ...options,
    plugins: [characterStatePlugin, sessionHistoryPlugin],
    enabledPluginIds: options.enabledPluginIds ?? [
      runtimePluginId,
      firstPartyModelToolsPluginId,
      characterStatePluginId,
    ],
  });
}
