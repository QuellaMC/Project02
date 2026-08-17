/** Terminal dispatch quiesces tracked work, bounded, before reading targets. */
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
  /** Nothing reads the retired list after this; late ones go to disposeLate. */
  readonly close: (
    disposeLate: (target: RuntimePluginLifecycleTarget) => void,
  ) => void;
  /**
   * The live plugins plus each retired instance once: a session's end reaches
   * an instance for the session it served, not for every later one, while
   * shutdown still reaches them all.
   */
  readonly sessionEndTargets: (
    livePlugins: readonly RuntimePlugin[],
  ) => readonly RuntimePluginLifecycleTarget[];
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
  readonly quiesceTimeoutMs?: number;
}): RuntimePluginInstanceOwnership {
  const quiesceTimeoutMs =
    config.quiesceTimeoutMs ?? runtimePluginQuiesceTimeoutMs;
  const retired: RuntimePluginLifecycleTarget[] = [];
  const sessionEnded = new Set<RuntimePlugin>();
  const inFlight = new Set<Promise<unknown>>();
  let disposeLateTarget:
    ((target: RuntimePluginLifecycleTarget) => void) | undefined;
  const remove = (plugin: RuntimePlugin): void => {
    const index = retired.findIndex(target => target.plugin === plugin);

    if (index !== -1) {
      retired.splice(index, 1);
    }

    sessionEnded.delete(plugin);
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

    const target = runtimePluginLifecycleTarget(plugin, catalogManifest);

    if (disposeLateTarget !== undefined) {
      // Filing now would strand the instance with no teardown left to run.
      disposeLateTarget(target);
      return;
    }

    retired.push(target);
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
      const deadlineAt = Date.now() + quiesceTimeoutMs;

      while (inFlight.size > 0) {
        const settled = await settleWithinDeadline(
          Promise.allSettled([...inFlight]),
          deadlineAt,
        );

        if (!settled) {
          // Terminal dispatch must always finish; stop waiting and tear down.
          return;
        }
      }
    },
    close(disposeLate) {
      disposeLateTarget ??= disposeLate;
    },
    sessionEndTargets(livePlugins) {
      const pending = retired.filter(
        target => !sessionEnded.has(target.plugin),
      );

      for (const target of pending) {
        sessionEnded.add(target.plugin);
      }

      return Object.freeze([
        ...pending,
        ...runtimePluginLifecycleTargets(
          livePlugins,
          config.catalogManifestForPluginId,
        ),
      ]);
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

/** Sized above the reload timeout so a long reloader still settles in order. */
export const runtimePluginQuiesceTimeoutMs = 15_000;

/** Unreferenced timer: a pending bound must not keep the process alive. */
async function settleWithinDeadline(
  work: Promise<unknown>,
  deadlineAt: number,
): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<false>(resolve => {
    timeoutId = setTimeout(
      () => {
        resolve(false);
      },
      Math.max(0, deadlineAt - Date.now()),
    );
    timeoutId.unref();
  });

  try {
    return await Promise.race([work.then(() => true), expiry]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
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
