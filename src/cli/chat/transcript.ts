/**
 * Replies render from the stream, never from the turn's answer, so this
 * terminal shows the same thread every other surface shows. What the stream
 * did not carry is read back from history on every handshake; live events
 * wait while that page is read, so the thread stays in order, and nothing
 * shows twice.
 */
import type {GatewayClient} from '../../gateway/client/index.ts';
import type {HistoryMessage} from '../../gateway/index.ts';
import type {LocalRuntimeTurnProgressEvent} from '../../runtime/index.ts';

export type Transcript = {
  showProgress(progress: LocalRuntimeTurnProgressEvent): void;
  /** A turn on the thread ended; kept in order with the messages. */
  turnEnded(clientMessageId: string, status: string): void;
  /** Reads back and shows what this terminal has not shown yet. */
  catchUp(): Promise<void>;
  /**
   * Resolves once no catch-up is in flight, or after the grace period —
   * a read-back that hangs must not hold the terminal.
   */
  settled(): Promise<void>;
  /**
   * Resolves once every one of these messages has reached the screen (or
   * was this terminal's own), or after the grace period if the stream
   * never carried them.
   */
  whenShown(messageIds: readonly string[]): Promise<void>;
  /**
   * A line whose answer was lost: says it landed at once if the thread
   * already shows it, or the moment the thread does. A catch-up that reads
   * the thread without it says so once, without a verdict — the turn may
   * still be queued behind another — and the line stays open until the
   * thread, or its turn's end, settles it.
   */
  expectLanding(clientMessageId: string, text: string): void;
};

type Arrival =
  | {
      readonly kind: 'progress';
      readonly progress: LocalRuntimeTurnProgressEvent;
    }
  | {
      readonly kind: 'ended';
      readonly clientMessageId: string;
      readonly status: string;
    };

type ShownMessage = {
  readonly messageId: string;
  readonly speakerName: string;
  readonly text: string;
  readonly source?: string;
  readonly clientMessageId?: string;
};

const catchUpPageSize = 100;
/** How many of this terminal's own recent lines stay accounted for. */
const recentOwnLines = 64;
/** The thread's recent tail, shown when a terminal joins it. */
const joinTailSize = 20;
/** How long a settled turn may take to show up on the stream. */
const echoTimeoutMs = 5_000;

export async function createTranscript(options: {
  readonly client: Pick<GatewayClient, 'history'>;
  readonly conversationId: string;
  /** This terminal's own stamp: its lines are already on its screen. */
  readonly source: string;
  readonly stdout: NodeJS.WritableStream;
}): Promise<Transcript> {
  const shown = new Set<string>();
  // What is known about this terminal's own lines, by the id each was sent
  // with: on the thread, and how its turn ended. Both may arrive before the
  // line is asked about — the stream can beat a failing answer — so both
  // are kept, for the recent lines it could concern.
  const landed = new Set<string>();
  const ended = new Map<string, string>();
  const uncertain = new Map<string, string>();
  const noted = new Set<string>();
  const remember = <T>(recent: Set<T> | Map<T, unknown>, key: T): void => {
    for (const oldest of recent.keys()) {
      if (recent.size < recentOwnLines) {
        break;
      }

      recent.delete(oldest);
    }

    if (recent instanceof Set) {
      recent.add(key);
    }
  };
  // A turn's end says how it ended, not that the line reached the thread;
  // only the line's own record says that. Without it, the turn is over
  // and the line is not on the thread, so sending it again is safe.
  const verdict = (id: string, text: string, status: string): string =>
    landed.has(id)
      ? `Your line "${text}" did reach the character; its turn ${status === 'completed' ? 'completed' : `was ${status}`}.`
      : `Your line "${text}" was ${status} before it reached the thread; send it again if you still want to.`;
  const awaiting: {readonly ids: readonly string[]; resolve(): void}[] = [];
  const say = (text: string): void => {
    options.stdout.write(`${text}\n`);
  };
  const waiting: Arrival[] = [];
  let buffering = false;
  let inFlight = 0;
  let queue: Promise<void> = Promise.resolve();
  const show = (message: ShownMessage): void => {
    if (shown.has(message.messageId)) {
      return;
    }

    shown.add(message.messageId);

    if (message.source !== options.source) {
      options.stdout.write(`${message.speakerName}: ${message.text}\n`);
    } else if (message.clientMessageId !== undefined) {
      remember(landed, message.clientMessageId);

      const text = uncertain.get(message.clientMessageId);

      if (text !== undefined) {
        uncertain.delete(message.clientMessageId);
        say(`Your line "${text}" did land.`);
      }
    }

    for (const waiter of awaiting.splice(0)) {
      if (waiter.ids.every(id => shown.has(id))) {
        waiter.resolve();
      } else {
        awaiting.push(waiter);
      }
    }
  };
  const settleLanding = (clientMessageId: string, status: string): void => {
    const text = uncertain.get(clientMessageId);

    if (text !== undefined) {
      uncertain.delete(clientMessageId);
      say(verdict(clientMessageId, text, status));

      return;
    }

    remember(ended, clientMessageId);
    ended.set(clientMessageId, status);
  };
  const apply = (arrival: Arrival): void => {
    if (arrival.kind === 'ended') {
      settleLanding(arrival.clientMessageId, arrival.status);
    } else if (
      arrival.progress.kind === 'visible_reply' ||
      arrival.progress.kind === 'user_message'
    ) {
      show(arrival.progress);
    }
  };
  // While a page is being read, what the stream brings waits behind it —
  // messages and turn endings alike, in the order they came.
  const arrive = (arrival: Arrival): void => {
    if (buffering) {
      waiting.push(arrival);
    } else {
      apply(arrival);
    }
  };
  // A terminal joins on the thread's recent tail, so what happened before
  // it — a reply to a line sent from a terminal that is gone — is on the
  // screen. The anchor starts at the newest of it and moves up with each
  // catch-up, so a reconnect late in a long session reads one page, not
  // the whole session again.
  const newest = await options.client.history(options.conversationId, {
    limit: joinTailSize,
  });
  let anchor: string | null = null;

  if (newest.status === 'ok') {
    for (const message of newest.messages) {
      show(message);
    }

    anchor = newest.messages.at(-1)?.messageId ?? null;
  }
  const readBack = async (): Promise<void> => {
    buffering = true;

    try {
      const missed = await readSince(anchor);

      for (const message of missed) {
        show(message);
      }

      anchor = missed.at(-1)?.messageId ?? anchor;

      // Not on the thread yet is all a snapshot can say: the turn may still
      // be queued behind another. Said once; the line stays open.
      for (const [id, text] of uncertain) {
        if (!noted.has(id)) {
          noted.add(id);
          say(
            `Your line "${text}" is not on the thread yet; if it never arrives, send it again.`,
          );
        }
      }
    } finally {
      inFlight -= 1;

      // Another read-back queued behind this one keeps the buffer; the
      // last one drains it, in order.
      if (inFlight === 0) {
        buffering = false;

        for (const arrival of waiting.splice(0)) {
          apply(arrival);
        }
      }
    }
  };

  // Pages walk backward until the anchor, or the thread's start, is on one;
  // what comes back is everything after the anchor, oldest first.
  const readSince = async (
    after: string | null,
  ): Promise<readonly HistoryMessage[]> => {
    const collected: HistoryMessage[] = [];
    let before: string | undefined;

    for (;;) {
      const page = await options.client.history(options.conversationId, {
        limit: catchUpPageSize,
        ...(before === undefined ? {} : {before}),
      });

      if (page.status !== 'ok') {
        throw new Error(page.message);
      }

      const at =
        after === null
          ? -1
          : page.messages.findIndex(message => message.messageId === after);

      collected.unshift(...page.messages.slice(at + 1));

      if (at !== -1 || page.earlier === undefined) {
        return collected;
      }

      before = page.earlier;
    }
  };

  return {
    showProgress(progress) {
      arrive({kind: 'progress', progress});
    },
    turnEnded(clientMessageId, status) {
      arrive({kind: 'ended', clientMessageId, status});
    },
    catchUp() {
      // The first read-back starts now, so a live event that arrives in the
      // same tick already waits behind the page.
      const first = inFlight === 0;

      inFlight += 1;

      const run = first ? readBack() : queue.then(readBack, readBack);

      queue = run.catch(() => undefined);

      return run;
    },
    settled: () =>
      inFlight === 0
        ? Promise.resolve()
        : Promise.race([
            queue,
            new Promise<void>(resolve => {
              setTimeout(resolve, echoTimeoutMs);
            }),
          ]),
    expectLanding(clientMessageId, text) {
      const status = ended.get(clientMessageId);

      if (status !== undefined) {
        say(verdict(clientMessageId, text, status));
      } else if (landed.has(clientMessageId)) {
        say(`Your line "${text}" did land.`);
      } else {
        uncertain.set(clientMessageId, text);
      }
    },
    whenShown: messageIds =>
      messageIds.every(id => shown.has(id))
        ? Promise.resolve()
        : new Promise(resolve => {
            const timer = setTimeout(resolve, echoTimeoutMs);

            awaiting.push({
              ids: messageIds,
              resolve() {
                clearTimeout(timer);
                resolve();
              },
            });
          }),
  };
}
