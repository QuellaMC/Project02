import { isCharacterStatePlugin } from './builtin/character-state/index.ts';
import { isFirstPartyModelToolsPlugin } from './types.ts';
import { runtimePluginDiscoveryPluginId } from './access-control.ts';
import type { RuntimePlugin } from './types.ts';

export function isHostDefaultEnabledRuntimePlugin(
  plugin: RuntimePlugin
): boolean {
  return (
    plugin.manifest.id === runtimePluginDiscoveryPluginId ||
    isCharacterStatePlugin(plugin) ||
    isFirstPartyModelToolsPlugin(plugin)
  );
}
