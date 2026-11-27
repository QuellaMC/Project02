/**
 * Her world's window: its one client and one stream; what the person does
 * in it, which is look around her world, leave her something and remove a
 * thing; and what they do with the window itself. Every read and every
 * answer passes through the window's reducers in world.ts, and the window
 * reads the value, never the client. From its start it tells the chat
 * whose world it shows. Browser-only like the chat's session: the browser
 * suite is its cover.
 */
import {framed} from './her-windows.ts';
import {streamLost, streamResumed} from './store.ts';
import {clientFor, createValue, follow, problem} from './surface.ts';
import {frameOf, tellTheChat, type FrameVerbs} from './window-link.ts';
import {
  drafted,
  initialWorldState,
  languageSaid,
  leaveAnswered,
  leaveOpened,
  looked,
  readsAgain,
  removeAnswered,
  removeAsked,
  removeKept,
  sent,
  sheetClosed,
  thingOpened,
  toLeave,
  toRemove,
  worldRead,
  worldReady,
  worldRefused,
  type Draft,
  type Shows,
  type WorldState,
} from './world.ts';

export type WorldSession = FrameVerbs & {
  readonly getState: () => WorldState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Goes to a tab of the window, or a place. */
  readonly look: (shows: Shows) => void;
  /** Opens a thing's card. */
  readonly openThing: (thingId: string) => void;
  /** Opens the sheet for leaving her something. */
  readonly openLeave: () => void;
  readonly closeSheet: () => void;
  /** What the person types or chooses in the sheet for leaving something. */
  readonly draft: (change: Partial<Draft>) => void;
  /** Leaves her what the sheet holds. */
  readonly leave: () => void;
  /** The card's button: the first press asks again, the second removes its thing. */
  readonly remove: () => void;
  /** Keeps the thing after all. */
  readonly keep: () => void;
};

export function createWorldSession(
  address: string,
  characterId: string,
): WorldSession {
  const {getState, subscribe, apply} = createValue(
    initialWorldState(characterId),
  );
  const frame = frameOf(pinned => {
    apply(current => framed(current, pinned));
  });
  const client = clientFor(address);
  const looking = {
    getState,
    subscribe,
    look(shows: Shows) {
      apply(current => looked(current, shows));
    },
    openThing(thingId: string) {
      apply(current => thingOpened(current, thingId));
    },
    openLeave() {
      apply(leaveOpened);
    },
    closeSheet() {
      apply(sheetClosed);
    },
    draft(change: Partial<Draft>) {
      apply(current => drafted(current, change));
    },
    keep() {
      apply(removeKept);
    },
    ...frame,
  };

  tellTheChat('world', characterId, frame.close);

  // An address that can never work: the window says so and does nothing else.
  if (typeof client === 'string') {
    apply(current => worldRefused(current, client));

    return {...looking, leave: () => undefined, remove: () => undefined};
  }

  /** Only the latest read applies; an earlier one that settles later is let go. */
  let reads = 0;
  const read = async (): Promise<void> => {
    const mine = (reads += 1);
    const outcome = await client.world(characterId).catch((error: unknown) => ({
      status: 'failed' as const,
      message: problem(error),
    }));

    if (mine === reads) {
      apply(current => worldRead(current, outcome));
    }
  };

  follow(client, {
    event: event => {
      if (event.kind === 'health_changed') {
        apply(current => languageSaid(current, event.health));
      }

      if (readsAgain(getState(), event)) {
        void read();
      }
    },
    ready: snapshot => {
      apply(current => worldReady(current, snapshot));
      void read();
    },
    lost: () => {
      apply(streamLost);
    },
    resumed: () => {
      apply(streamResumed);
      void read();
    },
    refused: message => {
      apply(current => worldRefused(current, message));
    },
  });

  return {
    ...looking,
    // Each is the person's own act, which asks nobody; what it changed is
    // read again after it.
    leave() {
      const thing = toLeave(getState().sheet);

      if (thing === undefined) {
        return;
      }

      apply(sent);
      void client
        .leaveThing(characterId, thing)
        .catch((error: unknown) => ({
          status: 'failed' as const,
          message: problem(error),
        }))
        .then(outcome => {
          apply(current => leaveAnswered(current, outcome));
          void read();
        });
    },
    remove() {
      const thingId = toRemove(getState().sheet);

      if (thingId === undefined) {
        apply(removeAsked);

        return;
      }

      apply(sent);
      void client
        .removeThing(characterId, thingId)
        .catch((error: unknown) => ({
          status: 'failed' as const,
          message: problem(error),
        }))
        .then(outcome => {
          apply(current => removeAnswered(current, thingId, outcome));
          void read();
        });
    },
  };
}
