/**
 * The tab's one client and one stream, and the verbs a page calls. Every
 * event and every outcome passes through the store's reducers, and the
 * page reads the store, never the client. The address is the page's own,
 * so this runs only in a browser: the browser suite is its cover.
 */
import type {
  GatewayConfirmationDecision,
  HistoryPage,
} from '../../gateway/api/index.ts';
import {
  createGatewayClient,
  GatewayClientError,
  type GatewayClient,
} from '../../gateway/client/index.ts';
import {
  applyEvent,
  composerChanged,
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

  let state = initialState;
  const listeners = new Set<() => void>();
  const apply = (reduce: (state: WebState) => WebState): void => {
    const next = reduce(state);

    if (next === state) {
      return;
    }

    state = next;

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
      },
      {
        signal: new AbortController().signal,
        onReady: async ({snapshot}) => {
          apply(current => installSnapshot(current, snapshot));

          const {thread} = state;

          if (thread !== undefined) {
            await readPage(thread.conversationId, {});
          }

          openTheOnlyCharacter();
        },
      },
    )
    .catch((error: unknown) => {
      apply(current => connectionRefused(current, problem(error)));
    });

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

      try {
        const outcome = await client.deliver({
          conversationId: thread.conversationId,
          senderId: thread.userParticipantId,
          text: line.text,
          source: webSource,
          clientMessageId,
        });

        apply(current =>
          lineEnded(
            current,
            thread.characterId,
            clientMessageId,
            outcome.status === 'completed'
              ? {status: 'completed'}
              : {status: outcome.status, message: outcome.message},
            'answer',
          ),
        );
      } catch (error: unknown) {
        // A 4xx is the daemon refusing the request itself — its token, its
        // route, its shape, its size — so no turn ran and the line comes
        // back with what the daemon said. Every other answer, including
        // one whose body was cut short, may have been a turn.
        if (
          error instanceof GatewayClientError &&
          error.status >= 400 &&
          error.status < 500
        ) {
          apply(current =>
            lineEnded(
              current,
              thread.characterId,
              clientMessageId,
              {status: 'refused', message: problem(error)},
              'answer',
            ),
          );

          return;
        }

        // Silence says nothing of the turn: the newest page settles the
        // line if the daemon took it and says the daemon cannot be
        // reached if that is why no answer came. A line the daemon may
        // still be holding stays pending for the stream.
        await readPage(thread.conversationId, {});
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

      // The card leaves on the settled event; an expiry is said by it too.
      try {
        await client.answerConfirmation(id, decision);
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
