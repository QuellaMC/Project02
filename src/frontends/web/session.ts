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
  /** The character an open is waiting for, so a roster of one asks once. */
  let opening: string | undefined;
  /**
   * Every open and every page read takes charge of what the thread shows,
   * and only the latest one's result applies — an open of another
   * character, an open of the same one again, a reconnect's read, a
   * recovery read: each supersedes whatever was in flight before it.
   */
  let charge = 0;
  const takeCharge = (): (() => boolean) => {
    const mine = (charge += 1);

    return () => mine === charge;
  };
  /** A page that cannot be read is a notice, never the stream's failure. */
  const readPage = async (
    conversationId: string,
    request: HistoryPage,
  ): Promise<void> => {
    const mine = takeCharge();

    try {
      const outcome = await client.history(conversationId, request);

      if (mine()) {
        apply(current =>
          historyPageRead(current, conversationId, request, outcome),
        );
      }
    } catch (error: unknown) {
      if (mine()) {
        apply(current => pageUnread(current, conversationId, problem(error)));
      }
    }
  };
  /**
   * An open can wait on a start or a reload, minutes when a turn is parked
   * on a confirmation; the latest character asked for wins, and an
   * earlier open that settles later is let go. While one is in flight the
   * same character is not asked for again — a roster of one asks on every
   * event until its thread is open.
   */
  const open = async (characterId: string): Promise<void> => {
    if (opening === characterId) {
      return;
    }

    opening = characterId;

    const mine = takeCharge();

    try {
      const outcome = await client.openDirectConversation(characterId);

      if (!mine()) {
        return;
      }

      opening = undefined;

      if (outcome.status !== 'opened') {
        apply(state => noticed(state, outcome.message));

        return;
      }

      apply(state => threadOpened(state, outcome));
      await readPage(outcome.conversationId, {});
    } catch (error: unknown) {
      if (mine()) {
        opening = undefined;
        apply(state => noticed(state, problem(error)));
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
      } catch {
        // No answer came, so nothing is known of the turn: the newest page
        // settles the line if the daemon took it and says the daemon
        // cannot be reached if that is why no answer came. A line the
        // daemon may still be holding stays pending for the stream.
        await readPage(thread.conversationId, {});
      }
    },
    async loadEarlier() {
      const {thread} = state;

      if (thread?.earlier === undefined) {
        return;
      }

      apply(noticeSpent);
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
