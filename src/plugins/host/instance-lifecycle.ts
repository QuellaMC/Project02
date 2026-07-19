/**
 * Explicit lifecycle registry for plugin instances that stopped (or never
 * started) serving: swap-superseded predecessors, guard-declined rebuilds,
 * and reload factories that settle late. Each retired instance records which
 * terminal phases (session end, shutdown) it has already received, so
 * dispatch composition and late arrivals derive from one model instead of
 * per-call-site conventions:
 *
 * - An instance is retired at most once and never while it is live; an
 *   instance that returns to live duty gives up its retired slot.
 * - A terminal phase dispatches each retired instance exactly once, retired
 *   before live so the live instance's writes land last.
 * - An instance retired AFTER a phase already ran receives that phase
 *   immediately (best effort) and stays registered for the phases that
 *   have not run yet.
 */
import type {RuntimePlugin} from '../api/index.ts';

export type RetiredRuntimePluginLifecycle<SessionEndPhase, ShutdownPhase> = {
  /** Retire an instance; applies the at-most-once / not-live invariants. */
  readonly retire: (plugin: RuntimePlugin) => void;
  /** A swap made this instance live again; it gives up any retired slot. */
  readonly unretire: (plugin: RuntimePlugin) => void;
  /** Marks the phase as run and returns the retired instances it must include. */
  readonly beginSessionEnd: (
    phase: SessionEndPhase,
  ) => readonly RuntimePlugin[];
  /** Marks the phase as run and returns the retired instances it must include. */
  readonly beginShutdown: (phase: ShutdownPhase) => readonly RuntimePlugin[];
};

type RetiredEntry = {
  readonly plugin: RuntimePlugin;
  receivedSessionEnd: boolean;
  receivedShutdown: boolean;
};

export function createRetiredRuntimePluginLifecycle<
  SessionEndPhase,
  ShutdownPhase,
>(config: {
  readonly isLive: (plugin: RuntimePlugin) => boolean;
  readonly dispatchSessionEnd: (
    plugin: RuntimePlugin,
    phase: SessionEndPhase,
  ) => Promise<unknown>;
  readonly dispatchShutdown: (
    plugin: RuntimePlugin,
    phase: ShutdownPhase,
  ) => Promise<unknown>;
}): RetiredRuntimePluginLifecycle<SessionEndPhase, ShutdownPhase> {
  const entries: RetiredEntry[] = [];
  let sessionEndPhase: {readonly phase: SessionEndPhase} | undefined;
  let shutdownPhase: {readonly phase: ShutdownPhase} | undefined;

  const dispatchMissedPhases = async (entry: RetiredEntry): Promise<void> => {
    try {
      if (sessionEndPhase !== undefined && !entry.receivedSessionEnd) {
        entry.receivedSessionEnd = true;
        await config.dispatchSessionEnd(entry.plugin, sessionEndPhase.phase);
      }

      if (shutdownPhase !== undefined && !entry.receivedShutdown) {
        entry.receivedShutdown = true;
        await config.dispatchShutdown(entry.plugin, shutdownPhase.phase);
      }
    } catch {
      // Terminal cleanup for late arrivals is best-effort by contract.
    }
  };

  return {
    retire: plugin => {
      if (
        config.isLive(plugin) ||
        entries.some(entry => entry.plugin === plugin)
      ) {
        return;
      }

      const entry: RetiredEntry = {
        plugin,
        receivedSessionEnd: false,
        receivedShutdown: false,
      };

      entries.push(entry);

      // Phases that already ran will never dispatch this entry, so it gets
      // them immediately; it stays registered for the phases still pending.
      if (sessionEndPhase !== undefined || shutdownPhase !== undefined) {
        void dispatchMissedPhases(entry);
      }
    },
    unretire: plugin => {
      const index = entries.findIndex(entry => entry.plugin === plugin);

      if (index !== -1) {
        entries.splice(index, 1);
      }
    },
    beginSessionEnd: phase => {
      sessionEndPhase ??= {phase};

      const pending = entries.filter(entry => !entry.receivedSessionEnd);

      for (const entry of pending) {
        entry.receivedSessionEnd = true;
      }

      return pending.map(entry => entry.plugin);
    },
    beginShutdown: phase => {
      shutdownPhase ??= {phase};

      const pending = entries.filter(entry => !entry.receivedShutdown);

      for (const entry of pending) {
        entry.receivedShutdown = true;
      }

      return pending.map(entry => entry.plugin);
    },
  };
}
