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
  /** The character an open is waiting for, and how many opens have been asked for. */
  let opening: string | undefined;
  let openGeneration = 0;

  /** A page that cannot be read is a notice, never the stream's failure. */
  const readPage = async (
    conversationId: string,
    page: 'newest' | 'earlier',
    request: HistoryPage,
  ): Promise<void> => {
    try {
      const outcome = await client.history(conversationId, request);

      apply(current => historyPageRead(current, conversationId, page, outcome));
    } catch (error: unknown) {
      apply(current => pageUnread(current, conversationId, problem(error)));
    }
  };
  /**
   * An open can wait on a start or a reload, minutes when a turn is parked
   * on a confirmation; the latest character asked for wins, and an earlier
   * open that settles later is let go. Asking again for the one already
   * waited for changes nothing.
   */
  const open = async (characterId: string): Promise<void> => {
    if (opening === characterId) {
      return;
    }

    opening = characterId;
    openGeneration += 1;

    const mine = openGeneration;
    const current = (): boolean => mine === openGeneration;

    try {
      const outcome = await client.openDirectConversation(characterId);

      if (!current()) {
        return;
      }

      if (outcome.status !== 'opened') {
        apply(state => noticed(state, outcome.message));

        return;
      }

      apply(state => threadOpened(state, outcome));
      await readPage(outcome.conversationId, 'newest', {});
    } catch (error: unknown) {
      if (current()) {
        apply(state => noticed(state, problem(error)));
      }
    } finally {
      if (current()) {
        opening = undefined;
      }
    }
  };
  /** One character opens itself; a roster of several waits for a click. */
  const openTheOnlyCharacter = (): void => {
    const characters = state.health?.characters ?? [];
    const only = characters.length === 1 ? characters[0] : undefined;

    if (only?.state === 'ready' && state.thread === undefined) {
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
            await readPage(thread.conversationId, 'newest', {});
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
            clientMessageId,
            outcome.status === 'completed'
              ? {status: 'completed'}
              : {status: outcome.status, message: outcome.message},
            'answer',
          ),
        );
      } catch (error: unknown) {
        apply(current =>
          lineEnded(
            current,
            clientMessageId,
            {status: 'unsent', message: problem(error)},
            'answer',
          ),
        );
        // No answer came, and the daemon may never have heard the line: the
        // newest page says whether it did, when it can be read.
        await readPage(thread.conversationId, 'newest', {});
      }
    },
    async loadEarlier() {
      const {thread} = state;

      if (thread?.earlier === undefined) {
        return;
      }

      await readPage(thread.conversationId, 'earlier', {
        before: thread.earlier,
      });
    },
    async answer(id, decision) {
      // The card leaves on the settled event; an expiry is said by it too.
      try {
        await client.answerConfirmation(id, decision);
      } catch (error: unknown) {
        apply(current => noticed(current, problem(error)));
      }
    },
    async start(characterId) {
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
