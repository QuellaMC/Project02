/**
 * The tab's one client and one stream, and the verbs a page calls. Every
 * event and every outcome passes through the store's reducers, and the
 * page reads the store, never the client. In the desktop app's main
 * window, each event also passes through the rule of when the app shows a
 * notification. Whatever the page shows changing, and the window coming
 * to the front, pass through the rule of when the person read a message
 * of hers. The address is the page's own, so this runs only in a browser:
 * the browser suite is its cover.
 */
import type {
  Answer,
  GatewayEvent,
  PendingConfirmation,
  PhoneOutcome,
  WorldOutcome,
} from '@project02/wire/contract';
import {
  GatewayClientError,
  type GatewayClient,
  type HistoryPage,
} from '@project02/wire/client';
import {settingAskOf} from './ask-words.ts';
import {dockStepped, dockWaited, herSettingsRead} from './dock.ts';
import {
  herWindows,
  windowAnswered,
  windowGone,
  windowShows,
  type HerWindow,
} from './her-windows.ts';
import {notificationFor} from './notifications.ts';
import {readOf} from './reads.ts';
import {
  createSettingsVerbs,
  noSettingsVerbs,
  rememberedAdvanced,
  type SettingsVerbs,
} from './settings-session.ts';
import {characterTarget} from './settings.ts';
import {
  applyEvent,
  composerChanged,
  confirmationGone,
  connectionRefused,
  forgetWritten,
  historyPageRead,
  initialState,
  installSnapshot,
  keptLine,
  lineAnswered,
  lineEnded,
  lineSent,
  lineTakenBack,
  linesOnTheirWay,
  linesTaken,
  noticeSpent,
  noticed,
  pageUnread,
  pairingGone,
  streamLost,
  streamResumed,
  threadOpened,
  webSource,
  type PendingLine,
  type WebState,
} from './store.ts';
import {clientFor, createValue, follow, problem} from './surface.ts';
import {notifierOf} from './window-calls.ts';
import {followHerWindows, openHerWindow} from './window-link.ts';

export type Session = SettingsVerbs & {
  readonly getState: () => WebState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly compose: (text: string) => void;
  readonly open: (characterId: string) => Promise<void>;
  /** Sends the composer's line. */
  readonly send: () => Promise<void>;
  /** Takes back the line sent under this id that did not reach her: its words go back into its message box. */
  readonly takeBack: (clientMessageId: string) => void;
  /** Hears whether the chat's end, where her newest message stands, is in view. */
  readonly endInView: (inView: boolean) => void;
  readonly loadEarlier: () => Promise<void>;
  /** Answers a confirmation: whether the daemon took the answer, which the stream then settles. */
  readonly answer: (id: string, decision: Answer) => Promise<boolean>;
  /** Answers a pairing request: whether the daemon took the answer, which the stream then settles. */
  readonly settlePairing: (code: string, decision: Answer) => Promise<boolean>;
  readonly start: (characterId: string) => Promise<void>;
  /** Opens her phone or her world in its window, or closes that window while it shows hers. */
  readonly toggleWindow: (herWindow: HerWindow, characterId: string) => void;
  /** Half a second after the ask with this key ended in front of the dock. */
  readonly dockStepped: (key: string) => void;
  /** The wait of the answered card with this key is over. */
  readonly dockWaited: (key: string) => void;
};

export function createSession(address: string): Session {
  const client = clientFor(address);

  if (typeof client === 'string') {
    return refusedSession(client);
  }

  const {getState, subscribe, apply, writtenFor} = createTabValue();
  const settings = createSettingsVerbs({client, getState, apply});
  const windows = linkHerWindows(address, {client, apply}, getState);
  const askedOf = readsHerSettings({client, apply});
  /** Only the latest open applies; an earlier one that settles later is let go. */
  let opens = 0;
  /**
   * And only the latest read of each thread, counted per conversation
   * because a read is about one thread: a recovery read for a thread the
   * person has left must not discard the read of the thread they are
   * looking at. A page for a thread no longer on screen is no news about
   * it either way — the store says so.
   */
  const reads = new Map<string, number>();
  /** Numbered from one count, so a read let go never shares its number with the one that replaces it. */
  let tickets = 0;
  /** The thread's own refresh and its paging back are counted apart: neither supersedes the other. */
  const readKey = (conversationId: string, request: HistoryPage): string =>
    `${conversationId}${request.before === undefined ? ' newest' : ' earlier'}`;
  /** A page that cannot be read is said on its thread, never as the stream's failure. */
  const readPage = async (
    conversationId: string,
    request: HistoryPage,
  ): Promise<void> => {
    const key = readKey(conversationId, request);
    const mine = (tickets += 1);

    reads.set(key, mine);

    try {
      const outcome = await client.history(conversationId, request);

      // What a page says of this tab's lines is the daemon's word and
      // does not go stale: a line the log carried is committed whether
      // or not this page is the one the thread ends up showing, and
      // whichever thread that is.
      apply(current => linesTaken(current, outcome));

      if (reads.get(key) === mine) {
        apply(current =>
          historyPageRead(current, conversationId, request, outcome),
        );
      }
    } catch (error: unknown) {
      if (reads.get(key) === mine) {
        apply(current => pageUnread(current, conversationId, problem(error)));
      }
    }
  };
  /**
   * An open can wait on her start; the latest character asked for wins,
   * and an earlier open that settles later is let go. Asking for the
   * character already on screen is a refresh: its thread stays until the
   * page comes.
   */
  const open = async (characterId: string): Promise<void> => {
    const mine = (opens += 1);

    // The person asking spends what the page had to say, not the answer
    // that comes back: a turn that fails while the open is in flight is
    // news of its own, and the open must not take it away.
    apply(noticeSpent);

    try {
      const outcome = await client.openDirectConversation(characterId);

      if (mine !== opens) {
        return;
      }

      if (outcome.status !== 'opened') {
        apply(state => noticed(state, outcome.message));

        return;
      }

      reads.clear();
      apply(state => threadOpened(state, outcome));
      windows.read();
      await readPage(outcome.conversationId, {});
    } catch (error: unknown) {
      if (mine === opens) {
        apply(state => noticed(state, problem(error)));
      }
    }
  };
  /**
   * One character opens itself, once — it may not be ready when the page
   * connects, so every event is a chance — and a roster of several waits
   * for a click. Once is enough: a thread outlives a reconnect, and an
   * open the daemon refuses says why rather than being asked again.
   */
  let openedItself = false;
  const openTheOnlyCharacter = (): void => {
    const characters = getState().health?.characters ?? [];
    const only = characters.length === 1 ? characters[0] : undefined;

    if (!openedItself && only?.state === 'ready') {
      openedItself = true;
      void open(only.id);
    }
  };

  follow(client, {
    event: notifying(event => {
      apply(current => applyEvent(current, event));
      openTheOnlyCharacter();

      if (event.kind === 'confirmation_requested') {
        askedOf(event);
      }

      // A character that was away when its lines were last accounted
      // for is a fresh chance at them, and the only one that comes.
      if (event.kind === 'state_changed' && event.state === 'ready') {
        void accountForPending(accounting());
      }

      // Config moved, here or on another surface, or a connector's
      // process came or went: the settings open show what is there now,
      // and whether she has a phone and a world is asked again.
      if (event.kind === 'health_changed') {
        void settings.changed();
        windows.read();
      }

      // Her apps on a settings page of hers are what her phone holds now.
      if (event.kind === 'phone_changed') {
        void settings.phoneChanged(event.characterId);
      }
    }),
    ready: async snapshot => {
      // The thread is set aside for the page read next, so no read
      // already in flight for it says what it shows any more.
      reads.clear();
      apply(current => installSnapshot(current, snapshot));
      snapshot.confirmations.forEach(askedOf);

      const {thread} = getState();

      if (thread !== undefined) {
        windows.read();
        await readPage(thread.conversationId, {});
      }

      const wroteFor = writtenFor();

      // Only what a previous tab kept can belong to another home; a
      // tab that has written nothing yet has nothing to let go of,
      // including what is being typed while this frame arrives.
      if (wroteFor !== undefined && wroteFor !== snapshot.health.homeRoot) {
        apply(forgetWritten);
      }

      writtenFor(snapshot.health.homeRoot);
      // Not awaited: a line's open can wait on her start, and the
      // stream goes on meanwhile.
      void accountForPending(accounting());
      openTheOnlyCharacter();
      await settings.ready();
    },
    lost: () => {
      apply(streamLost);
    },
    resumed: () => {
      // Nothing was missed, so nothing is installed; a connection is
      // still the moment to account for the lines this tab holds.
      apply(streamResumed);
      void accountForPending(accounting());
    },
    refused: message => {
      apply(current => connectionRefused(current, message));
    },
  });

  const endInView = tellReads(client, getState, subscribe);

  const sending = (): Sending => ({client, apply});
  const accounting = (): Accounting => ({...sending(), readPage, getState});

  return {
    ...settings.verbs,
    getState,
    subscribe,
    compose: text => {
      apply(current => composerChanged(current, text));
    },
    open,
    async send() {
      const {thread} = getState();

      // A refused address will never take a line, and nothing could
      // settle one: what is typed stays in the composer.
      if (thread === undefined || getState().connection.status === 'refused') {
        return;
      }

      const clientMessageId = crypto.randomUUID();

      apply(current => lineSent(current, clientMessageId));

      const line = getState().pending.get(clientMessageId);

      if (line === undefined) {
        return;
      }

      // Silence says nothing of the line, so the log is asked; a line it
      // does not carry was never queued, or is queued and waits or runs.
      // The same line goes again under the same id, which the daemon
      // answers as queued already if the first one did arrive: the
      // person's words are either in the thread or on their way, never
      // left in a bubble nothing will ever settle.
      if (!(await deliverOnce(sending(), line, clientMessageId))) {
        return;
      }

      // Nothing answered this one, which is reason to account for every
      // line still on its way: a passing failure that left one behind
      // clears without the stream ever dropping.
      await accountForPending(accounting());

      // Nothing answered, so the log is asked; a line it does not carry
      // goes again under the same id, which the daemon answers as queued
      // already if the first one did arrive. One that nothing answers
      // either waits for the next connection, which sends it again.
      await readPage(line.conversationId, {});

      if (linesOnTheirWay(getState()).has(clientMessageId)) {
        await deliverOnce(sending(), line, clientMessageId);
      }
    },
    takeBack: clientMessageId => {
      apply(current => lineTakenBack(current, clientMessageId));
    },
    endInView,
    async loadEarlier() {
      const {thread} = getState();

      if (thread?.earlier === undefined) {
        return;
      }

      apply(noticeSpent);
      await readPage(thread.conversationId, {before: thread.earlier});
    },
    async answer(id, decision) {
      apply(noticeSpent);

      try {
        const outcome = await client.answerConfirmation(id, decision);

        // An answer the daemon took is followed by the settled frame that
        // ends the card. Anything else says the request is not waiting
        // any more, and no frame is coming to say so — an expiry the
        // broker cancelled, or one it no longer knows, which another
        // surface may have answered either way.
        if (outcome.status !== 'answered') {
          apply(current => confirmationGone(current, id, outcome.status));
        }

        return outcome.status === 'answered';
      } catch (error: unknown) {
        apply(current => noticed(current, problem(error)));

        return false;
      }
    },
    async settlePairing(code, decision) {
      apply(noticeSpent);

      try {
        const outcome = await client.settlePairing(code, decision);

        apply(current => pairingGone(current, code, outcome));

        return outcome.status === 'settled';
      } catch (error: unknown) {
        apply(current => noticed(current, problem(error)));

        return false;
      }
    },
    async start(characterId) {
      apply(noticeSpent);

      try {
        const outcome = await client.startCharacter(characterId);

        if (outcome.status === 'refused') {
          apply(current => noticed(current, outcome.message));
        }
      } catch (error: unknown) {
        apply(current => noticed(current, problem(error)));
      }
    },
    toggleWindow: windows.toggle,
    dockStepped(key) {
      apply(current => dockStepped(current, key));
    },
    dockWaited(key) {
      apply(current => dockWaited(current, key));
    },
  };
}

/**
 * Her settings, read for each ask of hers to change one of them, so its
 * card says the change in the words her settings page uses; only the
 * newest read of hers lands. A read that does not come back leaves the
 * card in the preview's own words.
 */
function readsHerSettings({
  client,
  apply,
}: Sending): (pending: PendingConfirmation) => void {
  const reads = new Map<string, number>();
  let tickets = 0;

  return pending => {
    if (settingAskOf(pending.request.preview) === undefined) {
      return;
    }

    const {characterId} = pending;
    const mine = (tickets += 1);

    reads.set(characterId, mine);
    void client
      .configView(characterTarget(characterId))
      .then(view => {
        if (reads.get(characterId) === mine) {
          apply(current => herSettingsRead(current, characterId, view));
        }
      })
      .catch(() => undefined);
  };
}

/**
 * `handle`, and after it, in the desktop app, the notification the event
 * asks for by the rule in `notifications.ts`, shown by the app; in a
 * browser tab, which has no such call, `handle` alone. Her phone's window,
 * the same page in another mode, has a session of its own, which never
 * notifies.
 */
function notifying(
  handle: (event: GatewayEvent) => void,
): (event: GatewayEvent) => void {
  const notify = notifierOf(window);

  if (notify === undefined) {
    return handle;
  }

  let notified: ReadonlySet<string> = new Set();

  return event => {
    handle(event);

    const asked = notificationFor(notified, event, document.hasFocus());

    if (asked !== undefined) {
      notified = asked.notified;
      // One the app does not show says nothing.
      void notify(asked.notification).catch(() => undefined);
    }
  };
}

/**
 * Tells the daemon of each message of hers the person read, by the rule in
 * `reads.ts`, with the window's focus as it is then and whether the chat's
 * end is in view, which the answer of this hears: whenever what the tab
 * shows changes, the window comes to the front, or the chat's end comes
 * into view. One read is on its way at a time, and counts as told once the
 * daemon answered it, taken or refused for good; one it could not keep, or
 * that met no answer, is told again at the next of those moments. What the
 * daemon answers is not said: nothing the person did went wrong.
 */
function tellReads(
  client: GatewayClient,
  getState: () => WebState,
  subscribe: (listener: () => void) => () => void,
): (inView: boolean) => void {
  let told: ReadonlyMap<string, string> = new Map();
  let endInView = true;
  let telling = false;
  const tell = (): void => {
    if (telling) {
      return;
    }

    const next = readOf(told, getState(), {
      focused: document.hasFocus(),
      endInView,
    });

    if (next === undefined) {
      return;
    }

    telling = true;
    void client
      .readHers(next.read.conversationId, next.read.messageId)
      .then(
        outcome => outcome.status !== 'failed',
        () => false,
      )
      .then(answered => {
        telling = false;

        if (answered) {
          told = next.told;
          // A message of hers that came meanwhile is the next to tell.
          tell();
        }
      });
  };

  subscribe(tell);
  window.addEventListener('focus', tell);

  return inView => {
    endInView = inView;
    tell();
  };
}

/** What the chat says when the browser would not open a window of hers. */
const blocked: Readonly<Record<HerWindow, string>> = {
  phone:
    "This browser blocked her phone's window. Allow pop-ups for this page, then click Her Phone again.",
  world:
    "This browser blocked her world's window. Allow pop-ups for this page, then click Her World again.",
};

/**
 * The chat's side of the windows of hers: whose phone and whose world each
 * shows, as it says of itself; whether the character whose chat is on
 * screen has a phone and a world, as the daemon says; and the buttons that
 * open her phone and her world, or ask the window showing hers to close. A
 * click on one is the person's act, and spends what the page had to say.
 */
function linkHerWindows(
  address: string,
  {client, apply}: Sending,
  getState: () => WebState,
): {
  readonly read: () => void;
  readonly toggle: (herWindow: HerWindow, characterId: string) => void;
} {
  const shown = followHerWindows({
    shows: (herWindow, characterId) => {
      apply(current => windowShows(current, herWindow, characterId));
    },
    gone: (herWindow, characterId) => {
      apply(current => windowGone(current, herWindow, characterId));
    },
  });
  const readOfHers: Readonly<
    Record<
      HerWindow,
      (characterId: string) => Promise<PhoneOutcome | WorldOutcome>
    >
  > = {
    phone: characterId => client.phone(characterId),
    world: characterId => client.world(characterId),
  };
  /** Only the latest read of each applies; an earlier one that settles later is let go. */
  const reads = new Map<HerWindow, number>();
  let tickets = 0;

  return {
    read() {
      const characterId = getState().thread?.characterId;

      if (characterId === undefined) {
        return;
      }

      for (const herWindow of herWindows) {
        const mine = (tickets += 1);

        reads.set(herWindow, mine);
        // A read that did not reach the daemon says nothing of what she has.
        void readOfHers[herWindow](characterId).then(
          outcome => {
            if (reads.get(herWindow) === mine) {
              apply(current =>
                windowAnswered(current, herWindow, characterId, outcome),
              );
            }
          },
          () => undefined,
        );
      }
    },
    toggle(herWindow, characterId) {
      apply(noticeSpent);

      if (getState().windowShows.get(herWindow) === characterId) {
        shown.close(herWindow, characterId);
      } else if (!openHerWindow(herWindow, address, characterId)) {
        apply(current => noticed(current, blocked[herWindow]));
      }
    },
  };
}

/** What accounting for the lines a tab still holds needs of it. */
type Accounting = Sending & {
  readonly readPage: (
    conversationId: string,
    request: HistoryPage,
  ) => Promise<void>;
  readonly getState: () => WebState;
};

/**
 * Every line this tab holds that is still on its way, accounted for: the
 * log first, which settles one it carries whoever wrote it. What remains
 * goes again under its own id, whether this tab or a gone one wrote it:
 * the daemon answers one still in her inbox as queued already, and
 * refuses one she took anywhere in the conversation, in this run or an
 * earlier one — so a line goes twice only if the person sends it twice.
 * Each line's conversation is opened first: a daemon that has restarted
 * holds no route to it, and would refuse the line as one it does not
 * know. A line that did not reach her waits for the person.
 */
async function accountForPending(accounting: Accounting): Promise<void> {
  const onTheirWay = (): ReadonlyMap<string, PendingLine> =>
    linesOnTheirWay(accounting.getState());

  for (const [clientMessageId, line] of onTheirWay()) {
    const opened = await accounting.client
      .openDirectConversation(line.characterId)
      .catch(() => undefined);

    if (opened?.status !== 'opened') {
      continue;
    }

    await accounting.readPage(opened.conversationId, {});

    if (onTheirWay().has(clientMessageId)) {
      await deliverOnce(accounting, line, clientMessageId);
    }
  }
}

/**
 * The tab's one value, everyone watching it, and what it keeps of a
 * person's words. Nothing outside reads the value except through
 * `getState`, so there is one place it changes and one place it is kept:
 * a reload finds what was written and what was sent but not yet
 * accounted for, and a browser that will not keep them says so once.
 */
function createTabValue(): {
  readonly getState: () => WebState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly apply: (reduce: (state: WebState) => WebState) => void;
  /** The home the kept words belong to; called with one, the home they belong to now. */
  readonly writtenFor: (homeRoot?: string) => string | undefined;
} {
  const kept = writtenAndUnsent();
  const value = createValue<WebState>({
    ...initialState,
    composers: kept.composers,
    pending: kept.pending,
    advanced: rememberedAdvanced(),
  });
  let home = kept.homeRoot;
  let refusalSaid = false;

  return {
    getState: value.getState,
    subscribe: value.subscribe,
    apply: reduce => {
      value.apply(state => {
        const next = reduce(state);
        const written =
          next.composers !== state.composers || next.pending !== state.pending;

        if (!written || keepWrittenAndUnsent(next, home) || refusalSaid) {
          return next;
        }

        refusalSaid = true;

        return noticed(
          next,
          'This browser is not keeping what you write, so a reload will lose it.',
        );
      });
    },
    writtenFor: homeRoot => {
      if (homeRoot !== undefined) {
        home = homeRoot;
      }

      return home;
    },
  };
}

/** What one delivery needs of the tab it belongs to. */
type Sending = {
  readonly client: GatewayClient;
  readonly apply: (reduce: (state: WebState) => WebState) => void;
};

/**
 * One attempt at a line, and what the daemon answered: `true` when
 * nothing answered at all, which is the only thing the tab can act on
 * further. A line in her inbox is delivered, and waits for the stream to
 * say how its turn ended; a refusal is the daemon's word on the line.
 */
async function deliverOnce(
  sending: Sending,
  line: PendingLine,
  clientMessageId: string,
): Promise<boolean> {
  try {
    const outcome = await sending.client.deliver({
      conversationId: line.conversationId,
      text: line.text,
      source: webSource,
      clientMessageId,
    });

    sending.apply(current =>
      lineAnswered(current, line.characterId, clientMessageId, outcome),
    );

    return false;
  } catch (error: unknown) {
    // A refusal of the request as written — its shape, its size — says
    // the line was never taken, on this attempt or on an earlier one that
    // sent the same words. Every other answer is about this attempt
    // alone: a dead token, a daemon on its way down, one that could not
    // be reached or failed inside, an answer cut short. An earlier attempt
    // may have committed the line, so the log stays its only judge.
    if (
      error instanceof GatewayClientError &&
      (error.status === 400 || error.status === 413)
    ) {
      sending.apply(current =>
        lineEnded(current, line.characterId, clientMessageId, {
          status: 'refused',
          committed: false,
          message: problem(error),
        }),
      );

      return false;
    }

    return true;
  }
}

/**
 * What a person has written and not sent, kept for the tab that holds it:
 * a reload or a crash is an ordinary interruption, and their words are
 * theirs. The tab's own store, so nothing outlives the tab and no other
 * tab reads it; a browser that refuses it changes nothing else.
 */
const writtenKey = 'project02.written';

type Written = Pick<WebState, 'composers' | 'pending'>;

/** What a gone tab left, and the home it wrote it for. */
type Kept = Written & {readonly homeRoot?: string};

const nothingKept: Kept = {composers: new Map(), pending: new Map()};

function writtenAndUnsent(): Kept {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem(writtenKey) ?? '');

    if (typeof kept !== 'object' || kept === null) {
      return nothingKept;
    }

    const {composers, pending, homeRoot} = kept as Record<string, unknown>;

    return {
      composers: new Map(
        entriesOf(composers, value =>
          typeof value === 'string' ? value : undefined,
        ),
      ),
      pending: new Map(entriesOf(pending, keptLine)),
      ...(typeof homeRoot === 'string' ? {homeRoot} : {}),
    };
  } catch {
    return nothingKept;
  }
}

/**
 * What a browser gave back is data, not this page's shapes: each entry is
 * read as such, by `readOf`, and one it cannot read is left out.
 */
function entriesOf<T>(
  kept: unknown,
  readOf: (value: unknown) => T | undefined,
): (readonly [string, T])[] {
  return (Array.isArray(kept) ? kept : []).flatMap((entry: unknown) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string'
    ) {
      return [];
    }

    const key = entry[0];
    const read = readOf(entry[1]);

    return read === undefined ? [] : [[key, read] as const];
  });
}

/** Whether the browser kept it; one that will not is said once, and shows what is written all the same. */
function keepWrittenAndUnsent(state: Written, homeRoot?: string): boolean {
  try {
    sessionStorage.setItem(
      writtenKey,
      JSON.stringify({
        composers: [...state.composers],
        pending: [...state.pending],
        ...(homeRoot === undefined ? {} : {homeRoot}),
      }),
    );

    return true;
  } catch {
    return false;
  }
}

/** An address that can never work: the page says so and does nothing else. */
function refusedSession(message: string): Session {
  const state = connectionRefused(initialState, message);
  const nothing = (): Promise<void> => Promise.resolve();

  return {
    ...noSettingsVerbs,
    getState: () => state,
    subscribe: () => () => undefined,
    compose: () => undefined,
    open: nothing,
    send: nothing,
    takeBack: () => undefined,
    endInView: () => undefined,
    loadEarlier: nothing,
    answer: () => Promise.resolve(false),
    settlePairing: () => Promise.resolve(false),
    start: nothing,
    toggleWindow: () => undefined,
    dockStepped: () => undefined,
    dockWaited: () => undefined,
  };
}
