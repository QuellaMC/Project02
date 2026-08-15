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
import {createCharacterStatePlugin} from '../../src/plugins/packages/character-state/plugin.ts';
import {createSessionHistoryPlugin} from '../../src/plugins/packages/session-history/plugin.ts';

/**
 * Every host gets fresh bundled-plugin instances: session-history caches
 * its engine and character per instance, so a shared instance would leak
 * one host's index and shutdown into the next. Manifests come from the
 * package descriptors, the same source the discovery pipeline reads;
 * discovery itself is covered by the package-loader suite. Both are
 * bundled packages, so the host clears them for the trusted frames the way
 * the composition root does from provenance.
 */
export function createDefaultProject02PluginHost(
  options: Omit<CreateRuntimePluginHostOptions, 'plugins'> = {},
): RuntimePluginHost {
  return createRuntimePluginHost({
    fileStore: testRuntimePluginFileStoreProvider,
    trustedContextEligiblePluginIds: [
      characterStatePluginId,
      sessionHistoryPluginId,
    ],
    ...options,
    plugins: [createCharacterStatePlugin(), createSessionHistoryPlugin()],
    enabledPluginIds: options.enabledPluginIds ?? [
      runtimePluginId,
      firstPartyModelToolsPluginId,
      characterStatePluginId,
    ],
  });
}
