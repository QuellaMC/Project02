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
  /**
   * The next line, ahead of the REPL; prompts take turns in order. An
   * aborted signal withdraws the prompt and resolves `undefined`.
   */
  promptLine(signal?: AbortSignal): Promise<string | undefined>;
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
  // A line read for a prompt that was withdrawn meanwhile waits here for
  // whoever asks next; nothing typed is dropped.
  let held: string | undefined;
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
          settleAll();

          return;
        }

        const waiter = takeWaiter();

        if (waiter === undefined) {
          held = line;
        } else {
          waiter.resolve(line);
        }

        pump();
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
    withdraw: (waiter: Waiter) => void,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    if (closed || signal?.aborted === true) {
      return Promise.resolve(undefined);
    }

    if (held !== undefined) {
      const line = held;

      held = undefined;

      return Promise.resolve(line);
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
      pump();
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
          prompts.push(waiter);
        },
        waiter => {
          const index = prompts.indexOf(waiter);

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
