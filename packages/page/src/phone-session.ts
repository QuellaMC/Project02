/**
 * Her phone's window: its one client and one stream, and what the person
 * does in it, which is look around her phone and change nothing of hers.
 * Every read passes through the window's reducers in phone.ts, and the
 * window reads the value, never the client. Browser-only like the chat's
 * session: the browser suite is its cover.
 */
import {
  healthSaid,
  initialPhoneState,
  looked,
  phoneRead,
  phoneReady,
  phoneRefused,
  screenRead,
  type PhoneState,
  type ViewLook,
} from './phone.ts';
import {streamLost, streamResumed} from './store.ts';
import {clientFor, createValue, follow, problem} from './surface.ts';

export type PhoneSession = {
  readonly getState: () => PhoneState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Opens a view of one of her apps for the person. */
  readonly look: (appId: string, viewId: string) => void;
  /** Her home screen, for the person. */
  readonly goHome: () => void;
};

/** A minute's length; the window reads what it shows again at each minute's turn. */
const minute = 60_000;

export function createPhoneSession(
  address: string,
  characterId: string,
): PhoneSession {
  const {getState, subscribe, apply} = createValue(
    initialPhoneState(characterId),
  );
  const client = clientFor(address);

  // An address that can never work: the window says so and does nothing else.
  if (typeof client === 'string') {
    apply(current => phoneRefused(current, client));

    return {
      getState,
      subscribe,
      look: () => undefined,
      goHome: () => undefined,
    };
  }

  /** Only the latest read of her phone applies; an earlier one that settles later is let go. */
  let reads = 0;
  const read = async (): Promise<void> => {
    const mine = (reads += 1);
    const outcome = await client.phone(characterId).catch((error: unknown) => ({
      status: 'failed' as const,
      message: problem(error),
    }));

    if (mine === reads) {
      apply(current => phoneRead(current, outcome));
    }
  };
  /** And only the latest read of a view the person opened; the store lets go of one no longer shown. */
  let looks = 0;
  const readLook = async (look: ViewLook): Promise<void> => {
    const mine = (looks += 1);
    const outcome = await client
      .phoneScreen(characterId, look.appId, look.viewId)
      .catch((error: unknown) => ({
        status: 'failed' as const,
        message: problem(error),
      }));

    if (mine === looks) {
      apply(current => screenRead(current, look, outcome));
    }
  };
  /**
   * What a clock reading an app wrote as text says goes stale: at each
   * minute's turn the view on screen is read again, the person's by
   * itself and hers with her phone, until the address is refused.
   */
  const everyMinute = (): void => {
    const {connection, shows, phone} = getState();

    if (connection.status === 'refused') {
      return;
    }

    if (shows.kind === 'view') {
      void readLook(shows);
    } else if (shows.kind === 'hers' && phone?.front !== undefined) {
      void read();
    }

    setTimeout(everyMinute, minute - (Date.now() % minute));
  };

  follow(client, {
    event: event => {
      if (event.kind === 'health_changed') {
        apply(current => healthSaid(current, event.health));
      }

      if (event.kind === 'phone_changed' && event.characterId === characterId) {
        void read();
      }
    },
    ready: snapshot => {
      apply(current => phoneReady(current, snapshot.health));
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
      apply(current => phoneRefused(current, message));
    },
  });
  setTimeout(everyMinute, minute - (Date.now() % minute));

  return {
    getState,
    subscribe,
    look(appId, viewId) {
      const look: ViewLook = {kind: 'view', appId, viewId};
      const before = getState();

      apply(current => looked(current, look));

      if (getState() !== before) {
        void readLook(look);
      }
    },
    goHome() {
      apply(current => looked(current, {kind: 'home'}));
    },
  };
}
