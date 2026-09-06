/**
 * What this terminal shows of its thread. Replies render from the stream,
 * never from a turn's answer, so this terminal shows the same thread every
 * other surface shows; its own lines are already on its screen. What the
 * stream did not carry — the thread's tail on joining, anything committed
 * while the stream was down — is read back from history, one page, and
 * nothing shows twice. A live message and a page can cross; ids keep that
 * from repeating a line, and a rare swap of two lines is the terminal's to
 * bear.
 */
import type {GatewayClient} from '../../gateway/client/index.ts';
import type {HistoryMessage} from '../../gateway/index.ts';
import type {LocalRuntimeTurnProgressEvent} from '../../runtime/index.ts';

export type Transcript = {
  showProgress(progress: LocalRuntimeTurnProgressEvent): void;
  /** Reads back and shows what this terminal has not shown yet. */
  catchUp(): Promise<void>;
  /**
   * Resolves once every one of these messages has reached the screen (or
   * was this terminal's own), or after the grace period if the stream
   * never carried them.
   */
  whenShown(messageIds: readonly string[]): Promise<void>;
};

const pageSize = 50;
/** How long a settled turn may take to show up on the stream. */
const echoTimeoutMs = 5_000;

export function createTranscript(options: {
  readonly client: Pick<GatewayClient, 'history'>;
  readonly conversationId: string;
  /** This terminal's own stamp: its lines are already on its screen. */
  readonly source: string;
  readonly stdout: NodeJS.WritableStream;
  readonly signal?: AbortSignal;
}): Transcript {
  const call = options.signal === undefined ? {} : {signal: options.signal};
  const shown = new Set<string>();
  const awaiting: {readonly ids: readonly string[]; resolve(): void}[] = [];
  // The newest message this terminal knows of; a read-back starts after it.
  let anchor: string | undefined;
  const show = (message: {
    readonly messageId: string;
    readonly speakerName: string;
    readonly text: string;
    readonly source?: string;
  }): void => {
    if (shown.has(message.messageId)) {
      return;
    }

    shown.add(message.messageId);
    anchor = message.messageId;

    if (message.source !== options.source) {
      options.stdout.write(`${message.speakerName}: ${message.text}\n`);
    }

    for (const waiter of awaiting.splice(0)) {
      if (waiter.ids.every(id => shown.has(id))) {
        waiter.resolve();
      } else {
        awaiting.push(waiter);
      }
    }
  };
  const newestPage = async (): Promise<readonly HistoryMessage[]> => {
    const page = await options.client.history(
      options.conversationId,
      {limit: pageSize},
      call,
    );

    if (page.status !== 'ok') {
      throw new Error(page.message);
    }

    return page.messages;
  };

  return {
    showProgress(progress) {
      if (
        progress.kind === 'visible_reply' ||
        progress.kind === 'user_message'
      ) {
        show(progress);
      }
    },
    async catchUp() {
      const messages = await newestPage();
      // Everything after the newest known message; the whole page when
      // that message is no longer on it, or nothing is known yet.
      const from =
        anchor === undefined
          ? 0
          : messages.findIndex(message => message.messageId === anchor) + 1;

      for (const message of messages.slice(from)) {
        show(message);
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
