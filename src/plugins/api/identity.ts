import type {RuntimeEventIdentity} from '../../core/index.ts';
import type {RuntimePlugin, RuntimePluginContext} from './types.ts';

export function runtimeIdentityMatchesContext(
  identity: RuntimeEventIdentity,
  context: RuntimePluginContext,
): boolean {
  return (
    identity.eventId === context.eventId &&
    identity.traceId === context.traceId &&
    identity.createdAt === context.timestamp
  );
}

export function assertUniqueRuntimePluginIds(
  plugins: readonly RuntimePlugin[],
): void {
  const seenIds = new Set<string>();

  for (const plugin of plugins) {
    if (seenIds.has(plugin.manifest.id)) {
      throw new TypeError(
        `Duplicate plugin id "${plugin.manifest.id}" is not allowed.`,
      );
    }

    seenIds.add(plugin.manifest.id);
  }
}
