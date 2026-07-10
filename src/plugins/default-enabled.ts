import {
  isHostOwnedFirstPartyRuntimePlugin
} from './catalog.ts';
import type { RuntimePlugin } from './types.ts';

export function isHostDefaultEnabledRuntimePlugin(
  plugin: RuntimePlugin
): boolean {
  return isHostOwnedFirstPartyRuntimePlugin(plugin);
}
