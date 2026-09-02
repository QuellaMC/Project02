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

    if (closed) {
      settleAll();
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
    closed = true;
    dispatch();
  });
  input.once('error', (error: unknown) => {
    failure = error;
    closed = true;
    dispatch();
  });

  const take = (
    register: (waiter: Waiter) => void,
    withdraw: (waiter: Waiter) => void,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    if (signal?.aborted === true) {
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
    close: () => {
      closed = true;
      settleAll();
      lines.close();
    },
  };
}
