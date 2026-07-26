/**
 * Ownership registry for plugin instances that no longer serve.
 *
 * Construction adopts a candidate before any post-factory check. A
 * successful swap removes the new live instance from this registry and
 * retires the replaced one. The same owner tracks raw construction and final
 * reconciliation; terminal dispatch quiesces that work, under a bound, before
 * consuming the resulting ordered target list.
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
  /**
   * Ends ownership before the final phase reads its targets.
   *
   * After this, nothing else will consume the retired list, so a candidate that
   * still arrives is handed to `disposeLate` instead of being filed there.
   */
  readonly close: (
    disposeLate: (target: RuntimePluginLifecycleTarget) => void,
  ) => void;
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
  /** Overrides how long terminal dispatch waits on tracked work. */
  readonly quiesceTimeoutMs?: number;
}): RuntimePluginInstanceOwnership {
  const quiesceTimeoutMs =
    config.quiesceTimeoutMs ?? runtimePluginQuiesceTimeoutMs;
  const retired: RuntimePluginLifecycleTarget[] = [];
  const inFlight = new Set<Promise<unknown>>();
  let disposeLateTarget:
    ((target: RuntimePluginLifecycleTarget) => void) | undefined;
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

    const target = runtimePluginLifecycleTarget(plugin, catalogManifest);

    if (disposeLateTarget !== undefined) {
      // Ownership is closed: the final phase has already read its targets, so
      // filing this would leave the instance holding whatever its factory
      // opened -- timers, connections -- with no teardown left to run.
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
          // Tracked work is plugin-controlled and the reload race abandons a
          // late factory without cancelling it, so a reloader that never
          // settles keeps its entry here forever. Terminal dispatch is the one
          // phase that must always finish: give up waiting and run teardown on
          // the instances already owned rather than stranding the session with
          // no shutdown at all.
          return;
        }
      }
    },
    close(disposeLate) {
      disposeLateTarget ??= disposeLate;
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

/**
 * Bounds how long terminal dispatch waits on tracked work.
 *
 * Sized above the reload timeout so a reloader that merely runs long still
 * settles normally and gets its candidate torn down in order; only work that
 * outlives its own deadline is abandoned here.
 */
export const runtimePluginQuiesceTimeoutMs = 15_000;

/**
 * Resolves true when `work` settles before `deadlineAt`, false on expiry.
 *
 * The loser of the race is abandoned, not cancelled, so the timer is unreferenced:
 * a pending bound must never be the reason the process stays alive.
 */
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
