import type {Project02CharacterListing} from '../app/index.ts';
import type {CharacterRuntimeState, ReconcilePlan} from './api/contract.ts';

export type ReconcileSeams = {
  /** The installed roster as config says it is now. */
  readonly roster: () => readonly Project02CharacterListing[];
  readonly stateOf: (
    characterId: string,
  ) => CharacterRuntimeState | 'not_started';
  readonly start: (characterId: string) => Promise<unknown>;
  readonly stop: (characterId: string) => Promise<void>;
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
 * is not running starts; a disabled one that is running — or failed, still
 * holding what it could not release — stops. Whatever is mid-flight settles
 * on its own and the next pass sees the result.
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
    const work: Promise<unknown>[] = [];

    for (const character of seams.roster()) {
      const state = seams.stateOf(character.id);

      if (character.enabled) {
        if (
          state === 'not_started' ||
          state === 'stopped' ||
          state === 'failed'
        ) {
          starting.push(character.id);
          work.push(seams.start(character.id));
        }
      } else if (
        state === 'ready' ||
        state === 'starting' ||
        state === 'failed'
      ) {
        stopping.push(character.id);
        work.push(seams.stop(character.id));
      }
    }

    await Promise.all(work);

    return Object.freeze({
      starting: Object.freeze(starting),
      stopping: Object.freeze(stopping),
    });
  }
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
  });
}
