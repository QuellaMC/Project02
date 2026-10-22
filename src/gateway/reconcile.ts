import type {Project02CharacterListing} from '../app/index.ts';
import type {RosterState} from './api/index.ts';

/** What one reconcile pass set in motion; the outcomes arrive as states. */
export type ReconcilePlan = {
  readonly starting: readonly string[];
  readonly stopping: readonly string[];
  readonly reloading: readonly string[];
};

export type ReconcileSeams = {
  /** The installed roster as config says it is now. */
  readonly roster: () => readonly Project02CharacterListing[];
  /** Every character a runtime was ever built for, whatever its state. */
  readonly running: () => readonly string[];
  readonly stateOf: (characterId: string) => RosterState;
  readonly start: (characterId: string) => Promise<unknown>;
  readonly stop: (characterId: string) => Promise<void>;
  /** Whether a ready character would assemble differently now. */
  readonly drifted: (characterId: string) => boolean;
  readonly reload: (characterId: string) => Promise<unknown>;
};

export type Reconciler = {
  /**
   * Makes the running set match the config. A request that lands while a
   * pass runs joins it, and one more pass follows, so the newest roster
   * always has the last word; passes never overlap.
   */
  reconcile(): Promise<ReconcilePlan>;
  /** Settles once no pass is running; a stopping gateway waits on it. */
  settled(): Promise<void>;
};

/**
 * One rule for boot and for every config change: an enabled character that
 * is not running starts; one that is ready but would assemble differently
 * now reloads; a disabled one that is running — or failed, still holding
 * what it could not release — stops, and so does one whose package left
 * the roster. Whatever is mid-flight settles on its own and the next pass
 * sees the result.
 */
export function createReconciler(seams: ReconcileSeams): Reconciler {
  let running: Promise<ReconcilePlan> | undefined;
  let requested = false;

  return Object.freeze({
    reconcile(): Promise<ReconcilePlan> {
      if (running !== undefined) {
        requested = true;

        return running;
      }

      requested = false;
      running = runUntilQuiet().finally(() => {
        running = undefined;
      });

      return running;
    },
    settled(): Promise<void> {
      return (
        running?.then(
          () => undefined,
          () => undefined,
        ) ?? Promise.resolve()
      );
    },
  });

  async function runUntilQuiet(): Promise<ReconcilePlan> {
    let plan = await runPass();

    while (requested) {
      requested = false;
      plan = mergePlans(plan, await runPass());
    }

    return plan;
  }

  async function runPass(): Promise<ReconcilePlan> {
    const starting: string[] = [];
    const stopping: string[] = [];
    const reloading: string[] = [];
    const work: Promise<unknown>[] = [];
    const roster = seams.roster();
    const stop = (characterId: string): void => {
      stopping.push(characterId);
      work.push(seams.stop(characterId));
    };

    for (const character of roster) {
      const state = seams.stateOf(character.id);

      if (character.enabled) {
        if (
          state === 'not_started' ||
          state === 'stopped' ||
          state === 'failed'
        ) {
          starting.push(character.id);
          work.push(seams.start(character.id));
        } else if (state === 'ready' && seams.drifted(character.id)) {
          reloading.push(character.id);
          work.push(seams.reload(character.id));
        }
      } else if (holdsResources(state)) {
        stop(character.id);
      }
    }

    // A package removed while the daemon runs is a character no one can
    // reach any more; its runtime must not keep its leases and its host.
    for (const characterId of seams.running()) {
      if (
        !roster.some(character => character.id === characterId) &&
        holdsResources(seams.stateOf(characterId))
      ) {
        stop(characterId);
      }
    }

    await Promise.all(work);

    return Object.freeze({
      starting: Object.freeze(starting),
      stopping: Object.freeze(stopping),
      reloading: Object.freeze(reloading),
    });
  }
}

function holdsResources(state: RosterState): boolean {
  return (
    state === 'ready' ||
    state === 'starting' ||
    state === 'reloading' ||
    state === 'failed'
  );
}

function mergePlans(
  first: ReconcilePlan,
  second: ReconcilePlan,
): ReconcilePlan {
  return Object.freeze({
    starting: Object.freeze([
      ...new Set([...first.starting, ...second.starting]),
    ]),
    stopping: Object.freeze([
      ...new Set([...first.stopping, ...second.stopping]),
    ]),
    reloading: Object.freeze([
      ...new Set([...first.reloading, ...second.reloading]),
    ]),
  });
}
