import type { RuntimePlugin } from './plugin-types.ts';

export function assertUniqueRuntimePluginIds(
  plugins: readonly RuntimePlugin[]
): void {
  const seenIds = new Set<string>();

  for (const plugin of plugins) {
    if (seenIds.has(plugin.manifest.id)) {
      throw new TypeError(
        `Duplicate plugin id "${plugin.manifest.id}" is not allowed.`
      );
    }

    seenIds.add(plugin.manifest.id);
  }
}
