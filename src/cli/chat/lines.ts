/**
 * One reader over stdin. The REPL reads between turns; a confirmation
 * prompt reads during one — and takes only a line typed after it appeared,
 * so a line sent while the turn was still running stays the REPL's and
 * never approves an action the person had not yet seen.
 */
import {createInterface} from 'node:readline';

export type LineDispatcher = {
  /** The oldest line no prompt claims: the REPL's read. */
  replLine(): Promise<string | undefined>;
  /**
   * The first line typed after this call. An aborted signal withdraws the
   * prompt and resolves `undefined`; so does an input that ended.
   */
  promptLine(signal?: AbortSignal): Promise<string | undefined>;
  /** The terminal is leaving: nothing still queued is served. */
  close(): void;
};

type Waiter = {
  resolve(line: string | undefined): void;
  reject(error: unknown): void;
};

type PromptWaiter = Waiter & {
  /** Sequence number of the first line this prompt may take. */
  readonly since: number;
};

export function createLineDispatcher(
  input: NodeJS.ReadableStream,
): LineDispatcher {
  const lines = createInterface({input, crlfDelay: Infinity, terminal: false});
  const queued: {readonly line: string; readonly seq: number}[] = [];
  const prompts: PromptWaiter[] = [];
  let repl: Waiter | undefined;
  let seq = 0;
  // Ended: what is queued still serves, then every read answers nothing.
  // Closed by the terminal: nothing queued serves either.
  let ended = false;
  let closed = false;
  let failure: Error | undefined;

  const settle = (waiter: Waiter | undefined): void => {
    if (failure === undefined) {
      waiter?.resolve(undefined);
    } else {
      waiter?.reject(failure);
    }
  };
  const dispatch = (): void => {
    for (const prompt of [...prompts]) {
      const at = queued.findIndex(entry => entry.seq >= prompt.since);

      if (at !== -1) {
        prompts.splice(prompts.indexOf(prompt), 1);
        prompt.resolve(queued.splice(at, 1)[0]?.line);
      }
    }

    if (repl !== undefined && queued.length > 0) {
      const waiter = repl;

      repl = undefined;
      waiter.resolve(queued.shift()?.line);
    }

    if (!ended && !closed) {
      return;
    }

    // No line can come any more: a prompt that wanted a newer one is
    // answered nothing — silence is no — and once the queue is empty, so
    // is the REPL.
    const newest = queued.at(-1)?.seq ?? seq;

    for (const prompt of prompts.splice(0)) {
      if (closed || failure !== undefined || prompt.since > newest) {
        settle(prompt);
      } else {
        prompts.push(prompt);
      }
    }

    if (queued.length === 0) {
      settle(repl);
      repl = undefined;
    }
  };
  const failed = (error: unknown): void => {
    if (failure !== undefined) {
      return;
    }

    failure = error instanceof Error ? error : new Error(String(error));
    ended = true;
    queued.length = 0;
    dispatch();
  };

  lines.on('line', line => {
    seq += 1;
    queued.push({line, seq});
    dispatch();
  });
  lines.once('close', () => {
    ended = true;
    dispatch();
  });
  // A failing input errors on the stream and on the interface alike.
  input.once('error', failed);
  lines.on('error', failed);

  return {
    replLine() {
      if (closed || (ended && queued.length === 0)) {
        return failure === undefined
          ? Promise.resolve(undefined)
          : Promise.reject(failure);
      }

      return new Promise((resolve, reject) => {
        repl = {resolve, reject};
        dispatch();
      });
    },
    promptLine(signal) {
      if (closed || ended || signal?.aborted === true) {
        return Promise.resolve(undefined);
      }

      return new Promise((resolve, reject) => {
        const waiter: PromptWaiter = {resolve, reject, since: seq + 1};

        prompts.push(waiter);
        signal?.addEventListener(
          'abort',
          () => {
            const index = prompts.indexOf(waiter);

            if (index !== -1) {
              prompts.splice(index, 1);
              resolve(undefined);
            }
          },
          {once: true},
        );
        dispatch();
      });
    },
    close() {
      closed = true;
      queued.length = 0;
      dispatch();
      lines.close();
    },
  };
}
