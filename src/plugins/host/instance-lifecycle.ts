/**
 * Registry for plugin instances that stopped (or never started) serving:
 * swap-superseded predecessors, guard-declined rebuilds, and reload
 * factories that settled after losing their timeout race.
 *
 * The model is deliberately plain — a list plus two invariants:
 *
 * - An instance is retired at most once and never while it is live; an
 *   instance that returns to live duty gives up its retired slot.
 * - Retired instances are dispatched ONLY inside the host's ordered
 *   terminal phases (retired before live, so the live instance's writes
 *   land last). There is no out-of-band dispatch: an instance retired
 *   between phases joins the next phase, and one retired after the last
 *   phase is deliberately dropped — this is a single-process runtime that
 *   is about to exit, and salvage dispatch outside the ordered phases is
 *   exactly what would let a stale instance overwrite final state.
 */
import type {RuntimePlugin} from '../api/index.ts';

export type RetiredRuntimePluginLifecycle = {
  /** Retire an instance; applies the at-most-once / not-live invariants. */
  readonly retire: (plugin: RuntimePlugin) => void;
  /** A swap made this instance live again; it gives up any retired slot. */
  readonly unretire: (plugin: RuntimePlugin) => void;
  /** Retired instances in retirement order, for terminal dispatch. */
  readonly retiredPlugins: () => readonly RuntimePlugin[];
};

export function createRetiredRuntimePluginLifecycle(config: {
  readonly isLive: (plugin: RuntimePlugin) => boolean;
}): RetiredRuntimePluginLifecycle {
  const retired: RuntimePlugin[] = [];

  return {
    retire: plugin => {
      if (config.isLive(plugin) || retired.includes(plugin)) {
        return;
      }

      retired.push(plugin);
    },
    unretire: plugin => {
      const index = retired.indexOf(plugin);

      if (index !== -1) {
        retired.splice(index, 1);
      }
    },
    retiredPlugins: () => Object.freeze([...retired]),
  };
}
