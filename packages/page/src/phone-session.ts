/**
 * Her phone's window: its one client and one stream; what the person does
 * in it, which is look around her phone and change nothing of hers; and
 * what they do with the window itself. Every read passes through the
 * window's reducers in phone.ts, and the window reads the value, never the
 * client. From its start it tells the chat whose phone it shows.
 * Browser-only like the chat's session: the browser suite is its cover.
 */
import {tellTheChat} from './phone-link.ts';
import {
  framed,
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
import {
  clientFor,
  createValue,
  follow,
  problem,
  type Value,
} from './surface.ts';
import {findWindowCalls, type WindowCalls} from './window-calls.ts';

export type PhoneSession = {
  readonly getState: () => PhoneState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Opens a view of one of her apps for the person. */
  readonly look: (appId: string, viewId: string) => void;
  /** Her home screen, for the person. */
  readonly goHome: () => void;
  /** Starts moving the window with the pointer, where the page draws its frame. */
  readonly startDragging: () => void;
  /** Keeps the window on top of other windows, or no longer. */
  readonly pin: (pinned: boolean) => void;
  /** Closes the window. */
  readonly close: () => void;
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
  const frame = frameOf(apply);
  const client = clientFor(address);

  tellTheChat(characterId, frame.close);

  // An address that can never work: the window says so and does nothing else.
  if (typeof client === 'string') {
    apply(current => phoneRefused(current, client));

    return {
      getState,
      subscribe,
      look: () => undefined,
      goHome: () => undefined,
      ...frame,
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
      // Her settings say whether she has a phone, and health moves with
      // them: her phone is read again.
      if (event.kind === 'health_changed') {
        apply(current => healthSaid(current, event.health));
        void read();
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
    ...frame,
  };
}

/**
 * What the person does with the window her phone is in. Where the window
 * answers the desktop app's calls it has no frame of its own, and the page
 * draws one: its bar moves the window, its pin keeps it on top of others,
 * and closing it is the app's. Elsewhere a page closes the window a script
 * opened.
 */
function frameOf(
  apply: Value<PhoneState>['apply'],
): Pick<PhoneSession, 'startDragging' | 'pin' | 'close'> {
  const found = findWindowCalls(window);
  let calls: WindowCalls | undefined;

  void found.then(answered => {
    calls = answered;

    if (answered !== undefined) {
      apply(current => framed(current, answered.pinned));
    }
  });

  return {
    // A call the window refuses changes nothing of it.
    startDragging() {
      void calls?.startDragging().catch(() => undefined);
    },
    pin(pinned) {
      void calls?.pin(pinned).then(
        () => {
          apply(current => framed(current, pinned));
        },
        () => undefined,
      );
    },
    // Once the window has said what it answers: a page closing a window
    // of the app itself would leave the window there without it.
    close() {
      void found
        .then(async answered => {
          if (answered === undefined) {
            window.close();
          } else {
            await answered.close();
          }
        })
        .catch(() => undefined);
    },
  };
}
