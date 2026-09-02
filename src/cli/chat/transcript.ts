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
  /** Reads back and shows what this terminal has not shown yet. */
  catchUp(): Promise<void>;
  /** Resolves once no catch-up is in flight and nothing waits on one. */
  settled(): Promise<void>;
  /**
   * Resolves once every one of these messages has reached the screen (or
   * was this terminal's own), or after the grace period if the stream
   * never carried them.
   */
  whenShown(messageIds: readonly string[]): Promise<void>;
  /**
   * A line whose answer was lost: says at once whether it landed if the
   * thread already shows it, and otherwise the moment the thread does —
   * or that it did not, once a catch-up has read the thread without it.
   */
  expectLanding(clientMessageId: string, text: string): void;
};

type ShownMessage = {
  readonly messageId: string;
  readonly speakerName: string;
  readonly text: string;
  readonly source?: string;
  readonly clientMessageId?: string;
};

const catchUpPageSize = 100;
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
  // This terminal's own lines the thread has, by the id it sent them with.
  const landed = new Set<string>();
  const uncertain = new Map<string, string>();
  const awaiting: {readonly ids: readonly string[]; resolve(): void}[] = [];
  const say = (text: string): void => {
    options.stdout.write(`${text}\n`);
  };
  const waiting: LocalRuntimeTurnProgressEvent[] = [];
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
      landed.add(message.clientMessageId);

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
  const render = (progress: LocalRuntimeTurnProgressEvent): void => {
    if (progress.kind === 'visible_reply' || progress.kind === 'user_message') {
      show(progress);
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

      // The thread has been read past every uncertain line's turn: what is
      // not on it did not land.
      for (const [id, text] of [...uncertain]) {
        uncertain.delete(id);
        say(
          `Your line "${text}" did not reach the character; send it again if you still want to.`,
        );
      }
    } finally {
      inFlight -= 1;

      // Another read-back queued behind this one keeps the buffer; the
      // last one drains it, in order.
      if (inFlight === 0) {
        buffering = false;

        for (const progress of waiting.splice(0)) {
          render(progress);
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
      if (buffering) {
        waiting.push(progress);
      } else {
        render(progress);
      }
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
    settled: () => queue,
    expectLanding(clientMessageId, text) {
      if (landed.has(clientMessageId)) {
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
