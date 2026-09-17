/**
 * The tab's one client and one stream, and the verbs a page calls. Every
 * event and every outcome passes through the store's reducers, and the
 * page reads the store, never the client. The address is the page's own,
 * so this runs only in a browser: the browser suite is its cover.
 */
import {
  turnCommittedTheLine,
  type GatewayConfirmationDecision,
  type HistoryPage,
} from '../../gateway/api/index.ts';
import {
  createGatewayClient,
  GatewayClientError,
  type GatewayClient,
} from '../../gateway/client/index.ts';
import {
  applyEvent,
  composerChanged,
  confirmationGone,
  connectionRefused,
  historyPageRead,
  initialState,
  installSnapshot,
  lineEnded,
  lineSent,
  noticeSpent,
  noticed,
  pageUnread,
  threadOpened,
  type PendingLine,
  type WebState,
} from './store.ts';

export type Session = {
  readonly getState: () => WebState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly compose: (text: string) => void;
  readonly open: (characterId: string) => Promise<void>;
  /** Sends the composer's line. */
  readonly send: () => Promise<void>;
  readonly loadEarlier: () => Promise<void>;
  readonly answer: (
    id: string,
    decision: GatewayConfirmationDecision,
  ) => Promise<void>;
  readonly start: (characterId: string) => Promise<void>;
};

/** The stamp every tab puts on its lines; a tab tells its own apart by id, not by it. */
export const webSource = 'web';

function problem(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSession(address: string): Session {
  let client: GatewayClient;

  try {
    client = createGatewayClient({url: address});
  } catch (error: unknown) {
    return refusedSession(problem(error));
  }

  let state = {...initialState, ...writtenAndUnsent()};
  const listeners = new Set<() => void>();
  const apply = (reduce: (state: WebState) => WebState): void => {
    const next = reduce(state);

    if (next === state) {
      return;
    }

    const written =
      next.composers !== state.composers || next.pending !== state.pending;

    state = next;

    if (written) {
      keepWrittenAndUnsent(state);
    }

    for (const listener of listeners) {
      listener();
    }
  };
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
  /** A page that cannot be read is said on its thread, never as the stream's failure. */
  const readPage = async (
    conversationId: string,
    request: HistoryPage,
  ): Promise<void> => {
    const mine = (reads.get(conversationId) ?? 0) + 1;

    reads.set(conversationId, mine);

    try {
      const outcome = await client.history(conversationId, request);

      if (reads.get(conversationId) === mine) {
        apply(current =>
          historyPageRead(current, conversationId, request, outcome),
        );
      }
    } catch (error: unknown) {
      if (reads.get(conversationId) === mine) {
        apply(current => pageUnread(current, conversationId, problem(error)));
      }
    }
  };
  /**
   * An open can wait on a start or a reload, minutes when a turn is
   * parked on a confirmation; the latest character asked for wins, and an
   * earlier open that settles later is let go. Asking for the character
   * already on screen is a refresh: its thread stays until the page comes.
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

      apply(state => threadOpened(state, outcome));
      await readPage(outcome.conversationId, {});
    } catch (error: unknown) {
      if (mine === opens) {
        apply(state => noticed(state, problem(error)));
      }
    }
  };
  /**
   * The daemon has ended a turn whose line this tab has never seen
   * committed, so only the log says whether it was — and only a page read
   * after the end can carry it, since a page begun before one would not
   * hold the line yet. This reads that page: it settles the line if the
   * daemon took it, and leaves it waiting if the page does not say.
   */
  const askTheLog = async (
    conversationId: string,
    clientMessageId: string,
  ): Promise<void> => {
    if (state.pending.has(clientMessageId)) {
      await readPage(conversationId, {});
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
    const characters = state.health?.characters ?? [];
    const only = characters.length === 1 ? characters[0] : undefined;

    if (!openedItself && only?.state === 'ready') {
      openedItself = true;
      void open(only.id);
    }
  };

  // The stream lives as long as the page: a tab that goes away takes its
  // socket with it, and the daemon notices.
  void client
    .events(
      event => {
        apply(current => applyEvent(current, event));
        openTheOnlyCharacter();

        if (event.kind === 'turn_completed') {
          void askTheLog(event.conversationId, event.clientMessageId);
        }
      },
      {
        signal: new AbortController().signal,
        onReady: async ({snapshot}) => {
          apply(current => installSnapshot(current, snapshot));

          const {thread} = state;

          if (thread !== undefined) {
            await readPage(thread.conversationId, {});
          }

          // A connection is the first chance to account for a line this
          // tab is still holding — one whose send never reached a daemon
          // that was going away, or one a reload restored. Under its own
          // id, so the ledger joins what did arrive rather than saying
          // it twice.
          for (const [clientMessageId, line] of state.pending) {
            void deliverOnce(sending(), line, clientMessageId);
          }

          openTheOnlyCharacter();
        },
      },
    )
    .catch((error: unknown) => {
      apply(current => connectionRefused(current, problem(error)));
    });

  const sending = (): Sending => ({client, apply, askTheLog});

  return {
    getState: () => state,
    subscribe: listener => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    compose: text => {
      apply(current => composerChanged(current, text));
    },
    open,
    async send() {
      const {thread} = state;

      // A refused address will never take a line, and nothing could
      // settle one: what is typed stays in the composer.
      if (thread === undefined || state.connection.status === 'refused') {
        return;
      }

      const clientMessageId = crypto.randomUUID();

      apply(current => lineSent(current, clientMessageId));

      const line = state.pending.get(clientMessageId);

      if (line === undefined) {
        return;
      }

      // Silence says nothing of the turn, so the log is asked; a line it
      // does not carry was never taken, or was taken and is running. The
      // same line goes again under the same id, which the daemon's
      // ledger joins if the first one did arrive: the person's words are
      // either in the thread or on their way, never left in a bubble
      // nothing will ever settle.
      if (!(await deliverOnce(sending(), line, clientMessageId))) {
        return;
      }

      // Nothing answered, so the log is asked; a line it does not carry
      // goes again under the same id, which the daemon's ledger joins if
      // the first one did arrive. One that nothing answers either waits
      // for the next connection, which sends it again.
      await readPage(line.conversationId, {});

      if (state.pending.has(clientMessageId)) {
        await deliverOnce(sending(), line, clientMessageId);
      }
    },
    async loadEarlier() {
      const {thread} = state;

      if (thread?.earlier === undefined) {
        return;
      }

      await readPage(thread.conversationId, {before: thread.earlier});
    },
    async answer(id, decision) {
      apply(noticeSpent);

      try {
        const outcome = await client.answerConfirmation(id, decision);

        // An answer the daemon took is followed by the settled frame that
        // removes the card. Anything else says the request is not waiting
        // any more, and no frame is coming to say so — an expiry the
        // broker cancelled, or one it no longer knows, which another
        // surface may have answered either way.
        if (outcome.status !== 'answered') {
          apply(current => confirmationGone(current, id, outcome.status));
        }
      } catch (error: unknown) {
        apply(current => noticed(current, problem(error)));
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
  };
}

/** What one delivery needs of the tab it belongs to. */
type Sending = {
  readonly client: GatewayClient;
  readonly apply: (reduce: (state: WebState) => WebState) => void;
  readonly askTheLog: (
    conversationId: string,
    clientMessageId: string,
  ) => Promise<void>;
};

/**
 * One attempt at a line, and what the daemon answered: `true` when
 * nothing answered at all, which is the only thing the tab can act on
 * further. A refusal and a verdict are the daemon's word, and the log
 * settles what it committed.
 */
async function deliverOnce(
  sending: Sending,
  line: PendingLine,
  clientMessageId: string,
): Promise<boolean> {
  try {
    const outcome = await sending.client.deliver({
      conversationId: line.conversationId,
      senderId: line.senderId,
      text: line.text,
      source: webSource,
      clientMessageId,
    });

    sending.apply(current =>
      lineEnded(
        current,
        line.characterId,
        clientMessageId,
        outcome.status === 'completed'
          ? {status: 'completed', committed: true}
          : {
              status: outcome.status,
              committed: turnCommittedTheLine(outcome),
              message: outcome.message,
            },
      ),
    );
    await sending.askTheLog(line.conversationId, clientMessageId);

    return false;
  } catch (error: unknown) {
    // A turn can only have run if the request reached the route, so every
    // answer the daemon gives here is it refusing the request itself —
    // its token, its route, its shape, its size, or a daemon on its way
    // down — but its own internal failure, which may have been a turn, as
    // may an answer cut short under its 200.
    if (
      error instanceof GatewayClientError &&
      error.status >= 400 &&
      error.status !== 500
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

function writtenAndUnsent(): Written {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem(writtenKey) ?? '');

    if (typeof kept !== 'object' || kept === null) {
      return {composers: new Map(), pending: new Map()};
    }

    const {composers, pending} = kept as Record<string, unknown>;

    return {
      composers: new Map(
        entriesOf(composers, value => typeof value === 'string'),
      ) as ReadonlyMap<string, string>,
      pending: new Map(entriesOf(pending, isPendingLine)) as ReadonlyMap<
        string,
        PendingLine
      >,
    };
  } catch {
    return {composers: new Map(), pending: new Map()};
  }
}

/** What a browser gave back is data, not this page's shapes: it is read as such. */
function entriesOf(
  kept: unknown,
  holds: (value: unknown) => boolean,
): readonly [string, unknown][] {
  return (Array.isArray(kept) ? kept : []).filter(
    (entry): entry is [string, unknown] =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === 'string' &&
      holds(entry[1]),
  );
}

function isPendingLine(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    ['conversationId', 'characterId', 'senderId', 'text'].every(
      field => typeof (value as Record<string, unknown>)[field] === 'string',
    )
  );
}

function keepWrittenAndUnsent(state: Written): void {
  try {
    sessionStorage.setItem(
      writtenKey,
      JSON.stringify({
        composers: [...state.composers],
        pending: [...state.pending],
      }),
    );
  } catch {
    // A browser that will not keep it still shows what is written.
  }
}

/** An address that can never work: the page says so and does nothing else. */
function refusedSession(message: string): Session {
  const state = connectionRefused(initialState, message);
  const nothing = (): Promise<void> => Promise.resolve();

  return {
    getState: () => state,
    subscribe: () => () => undefined,
    compose: () => undefined,
    open: nothing,
    send: nothing,
    loadEarlier: nothing,
    answer: nothing,
    start: nothing,
  };
}
