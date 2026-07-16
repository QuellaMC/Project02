import { createCharacterStatePlugin } from './packages/character-state/plugin.ts';
import {
  characterStatePluginId,
  firstPartyModelToolsPluginId,
  runtimePluginId
} from './contract.ts';
import {
  createRuntimePluginHost,
  type CreateRuntimePluginHostOptions,
  type RuntimePluginHost
} from './host.ts';

/**
 * Convenience host for focused tests and explicit embedders.
 * Production entrypoints construct their host from package discovery instead.
 */
export function createDefaultProject02PluginHost(
  options: Omit<CreateRuntimePluginHostOptions, 'plugins'> = {}
): RuntimePluginHost {
  return createRuntimePluginHost({
    ...options,
    plugins: [createCharacterStatePlugin()],
    enabledPluginIds:
      options.enabledPluginIds ?? [
        runtimePluginId,
        firstPartyModelToolsPluginId,
        characterStatePluginId
      ]
  });
}
