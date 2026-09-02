/**
 * One reader over stdin, and one consumer per line. A confirmation prompt
 * takes the next line ahead of the REPL, so a line typed under a visible
 * [y/N] answers that prompt and never becomes a chat message — and a line
 * meant for the REPL is never also read as an approval.
 */
import {createInterface} from 'node:readline';

export type LineDispatcher = {
  /** The next line no prompt claims: the REPL's read. */
  replLine(): Promise<string | undefined>;
  /** The next line, ahead of the REPL; prompts take turns in order. */
  promptLine(): Promise<string | undefined>;
  close(): void;
};

type Waiter = {
  resolve(line: string | undefined): void;
  reject(error: unknown): void;
};

export function createLineDispatcher(
  input: NodeJS.ReadableStream,
): LineDispatcher {
  const lines = createInterface({input, crlfDelay: Infinity, terminal: false});
  const iterator = lines[Symbol.asyncIterator]();
  const prompts: Waiter[] = [];
  let repl: Waiter | undefined;
  let reading = false;
  let closed = false;

  // A line is read only when someone waits for it, so nothing typed before
  // a prompt appeared is held back to answer it.
  const pump = (): void => {
    if (reading || closed || (prompts.length === 0 && repl === undefined)) {
      return;
    }

    reading = true;
    iterator.next().then(
      next => {
        reading = false;

        const line = next.done === true ? undefined : next.value;

        if (line === undefined) {
          closed = true;
        }

        takeWaiter()?.resolve(line);

        if (closed) {
          settleAll();
        } else {
          pump();
        }
      },
      (error: unknown) => {
        reading = false;
        closed = true;
        takeWaiter()?.reject(error);
        settleAll();
      },
    );
  };
  const takeWaiter = (): Waiter | undefined => {
    const prompt = prompts.shift();

    if (prompt !== undefined) {
      return prompt;
    }

    const waiter = repl;

    repl = undefined;

    return waiter;
  };
  const settleAll = (): void => {
    for (const waiter of prompts.splice(0)) {
      waiter.resolve(undefined);
    }

    repl?.resolve(undefined);
    repl = undefined;
  };
  const take = (
    register: (waiter: Waiter) => void,
  ): Promise<string | undefined> =>
    closed
      ? Promise.resolve(undefined)
      : new Promise((resolve, reject) => {
          register({resolve, reject});
          pump();
        });

  return {
    replLine: () =>
      take(waiter => {
        repl = waiter;
      }),
    promptLine: () =>
      take(waiter => {
        prompts.push(waiter);
      }),
    close: () => {
      closed = true;
      settleAll();
      lines.close();
    },
  };
}
