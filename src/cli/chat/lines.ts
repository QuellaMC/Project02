/**
 * One reader over stdin, and one consumer per line. Lines are taken in as
 * they arrive and numbered, so a confirmation prompt can insist on a line
 * typed after it appeared: whatever was typed before it — a chat line sent
 * while a turn was still running — stays the REPL's, and never approves
 * an action the person had not yet seen.
 */
import {createInterface} from 'node:readline';

export type LineDispatcher = {
  /** The oldest line no prompt claims: the REPL's read. */
  replLine(): Promise<string | undefined>;
  /**
   * The first line typed after this call; prompts take turns in order. An
   * aborted signal withdraws the prompt and resolves `undefined`.
   */
  promptLine(signal?: AbortSignal): Promise<string | undefined>;
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
  // The input ended: what is queued still serves, then every read answers
  // nothing. Closed by the terminal: nothing queued serves either.
  let ended = false;
  let closed = false;
  let failure: unknown;

  const dispatch = (): void => {
    for (const prompt of [...prompts]) {
      const at = queued.findIndex(entry => entry.seq >= prompt.since);

      if (at !== -1) {
        const [entry] = queued.splice(at, 1);

        prompts.splice(prompts.indexOf(prompt), 1);
        prompt.resolve(entry?.line);
      }
    }

    const waiter = repl;

    if (waiter !== undefined && queued.length > 0) {
      const [entry] = queued.splice(0, 1);

      repl = undefined;
      waiter.resolve(entry?.line);
    }

    if (ended || closed) {
      // The input ended: a prompt that wants a line newer than any queued
      // will never get one — silence is no. Older lines stay the REPL's.
      const newest = queued.at(-1)?.seq ?? seq;

      for (const prompt of prompts.splice(0)) {
        if (failure !== undefined) {
          // A failed input is a failure, not a no.
          prompt.reject(failure);
        } else if (closed || prompt.since > newest) {
          prompt.resolve(undefined);
        } else {
          prompts.push(prompt);
        }
      }

      if (queued.length === 0) {
        settleAll();
      }
    }
  };
  const settleAll = (): void => {
    for (const prompt of prompts.splice(0)) {
      if (failure === undefined) {
        prompt.resolve(undefined);
      } else {
        prompt.reject(failure);
      }
    }

    const waiter = repl;

    repl = undefined;

    if (failure === undefined) {
      waiter?.resolve(undefined);
    } else {
      waiter?.reject(failure);
    }
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
  // A failing input errors on the stream and on the interface alike; the
  // first is the failure, the second is the same one again.
  const failed = (error: unknown): void => {
    if (failure !== undefined) {
      return;
    }

    failure = error;
    ended = true;
    queued.length = 0;
    dispatch();
  };

  input.once('error', failed);
  lines.on('error', failed);

  const take = (
    register: (waiter: Waiter) => void,
    withdraw: (waiter: Waiter) => void,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    if (closed || signal?.aborted === true || (ended && queued.length === 0)) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {resolve, reject};

      register(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          withdraw(waiter);
          resolve(undefined);
        },
        {once: true},
      );
      dispatch();
    });
  };

  return {
    replLine: () =>
      take(
        waiter => {
          repl = waiter;
        },
        () => undefined,
      ),
    promptLine: signal =>
      take(
        waiter => {
          prompts.push({...waiter, since: seq + 1});
        },
        waiter => {
          const index = prompts.findIndex(
            prompt => prompt.resolve === waiter.resolve,
          );

          if (index !== -1) {
            prompts.splice(index, 1);
          }
        },
        signal,
      ),
    // Closed by the terminal, not by the input: what was typed and not yet
    // read goes with it, so nothing is sent once there is no one to show
    // the reply to.
    close: () => {
      closed = true;
      queued.length = 0;
      settleAll();
      lines.close();
    },
  };
}

export type ReadAhead = {
  /** The REPL's next line: one queued behind a hold first, else a fresh read. */
  next(): Promise<string | undefined>;
  /**
   * Waits for `pending` with one read kept ahead: an exit typed meanwhile
   * ends the wait, and any other line waits its turn behind whatever the
   * wait was for.
   */
  holdUntil<T>(
    pending: Promise<T>,
  ): Promise<{kind: 'done'; value: T} | {kind: 'exit'}>;
};

/** The REPL's reads over the dispatcher, with a read kept ahead while it waits. */
export function createReadAhead(
  lines: Pick<LineDispatcher, 'replLine'>,
): ReadAhead {
  const queued: string[] = [];
  let ahead: Promise<string | undefined> | undefined;

  return {
    next() {
      const queuedLine = queued.shift();

      if (queuedLine !== undefined) {
        return Promise.resolve(queuedLine);
      }

      // Only a read handed over is let go of; one still pending stays
      // ahead, so the line it brings is never lost.
      const read = ahead ?? lines.replLine();

      ahead = undefined;

      return read;
    },
    async holdUntil(pending) {
      const done = pending.then(value => ({kind: 'done' as const, value}));

      for (;;) {
        ahead ??= lines.replLine();

        const first = await Promise.race([
          done,
          ahead.then(line => ({kind: 'line' as const, line})),
        ]);

        if (first.kind === 'done') {
          return first;
        }

        ahead = undefined;

        if (first.line === undefined || first.line.trim() === '/exit') {
          return {kind: 'exit'};
        }

        queued.push(first.line);
      }
    },
  };
}
