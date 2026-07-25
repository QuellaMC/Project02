/**
 * Ownership registry for plugin instances that no longer serve.
 *
 * Construction adopts a candidate before any post-factory check. A
 * successful swap removes the new live instance from this registry and
 * retires the replaced one. The same owner tracks raw construction and final
 * reconciliation; terminal dispatch quiesces that work before consuming the
 * resulting ordered target list.
 */
import type {RuntimePlugin, RuntimePluginManifest} from '../api/index.ts';

export type RuntimePluginLifecycleTarget = {
  readonly plugin: RuntimePlugin;
  readonly catalogManifest: RuntimePluginManifest;
};

export function runtimePluginLifecycleTarget(
  plugin: RuntimePlugin,
  catalogManifest: RuntimePluginManifest,
): RuntimePluginLifecycleTarget {
  return Object.freeze({plugin, catalogManifest});
}

export type RuntimePluginInstanceOwnership = {
  readonly retire: (
    plugin: RuntimePlugin,
    catalogManifest: RuntimePluginManifest,
  ) => void;
  readonly replaceLive: (plugin: RuntimePlugin) => RuntimePlugin | undefined;
  readonly track: <T>(work: Promise<T>) => Promise<T>;
  readonly quiesce: () => Promise<void>;
  readonly terminalTargets: (
    livePlugins: readonly RuntimePlugin[],
  ) => readonly RuntimePluginLifecycleTarget[];
};

export function createRuntimePluginInstanceOwnership(config: {
  readonly isLive: (plugin: RuntimePlugin) => boolean;
  readonly swapEnabledPlugin: (
    next: RuntimePlugin,
  ) => RuntimePlugin | undefined;
  readonly catalogManifestForPluginId: (
    pluginId: string,
  ) => RuntimePluginManifest;
}): RuntimePluginInstanceOwnership {
  const retired: RuntimePluginLifecycleTarget[] = [];
  const inFlight = new Set<Promise<unknown>>();
  const remove = (plugin: RuntimePlugin): void => {
    const index = retired.findIndex(target => target.plugin === plugin);

    if (index !== -1) {
      retired.splice(index, 1);
    }
  };
  const retire = (
    plugin: RuntimePlugin,
    catalogManifest: RuntimePluginManifest,
  ): void => {
    if (
      config.isLive(plugin) ||
      retired.some(target => target.plugin === plugin)
    ) {
      return;
    }

    retired.push(runtimePluginLifecycleTarget(plugin, catalogManifest));
  };
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    void work.then(
      () => {
        inFlight.delete(work);
      },
      () => {
        inFlight.delete(work);
      },
    );
    return work;
  };

  return Object.freeze({
    retire,
    replaceLive(plugin) {
      const previous = config.swapEnabledPlugin(plugin);

      if (previous === undefined) {
        return undefined;
      }

      remove(plugin);
      retire(previous, config.catalogManifestForPluginId(previous.manifest.id));
      return previous;
    },
    track,
    async quiesce() {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
    terminalTargets: livePlugins =>
      Object.freeze([
        ...retired,
        ...runtimePluginLifecycleTargets(
          livePlugins,
          config.catalogManifestForPluginId,
        ),
      ]),
  });
}

export function runtimePluginLifecycleTargets(
  plugins: readonly RuntimePlugin[],
  catalogManifestForPluginId?: (pluginId: string) => RuntimePluginManifest,
): readonly RuntimePluginLifecycleTarget[] {
  return Object.freeze(
    plugins.map(plugin =>
      runtimePluginLifecycleTarget(
        plugin,
        catalogManifestForPluginId?.(plugin.manifest.id) ?? plugin.manifest,
      ),
    ),
  );
}
