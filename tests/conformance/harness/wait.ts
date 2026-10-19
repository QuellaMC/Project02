/**
 * Every wait in the suite ends here or in an idle deadline of the same
 * length: a daemon under load answers late, never this late. A wait that
 * fails shows what each process, stream and server the test started had
 * produced by then.
 */
import {onTestFinished} from './runner.ts';

export const ceilingMs = 10_000;

const evidence = new Set<() => string>();

/** What a failure shows, for the rest of the running test. */
export function attachEvidence(describe: () => string): void {
  evidence.add(describe);
  onTestFinished(() => {
    evidence.delete(describe);
  });
}

export function failure(message: string): Error {
  return new Error(withEvidence(message));
}

/**
 * A wait's failure, made as the wait begins so its stack names the wait,
 * not the timer or the event that ends it.
 */
export function waitFailure(what: string): {
  readonly ceiling: () => Error;
  readonly because: (why: string, cause?: unknown) => Error;
} {
  const error = new Error();
  const fail = (message: string, cause?: unknown): Error => {
    error.message = withEvidence(message);

    if (cause !== undefined) {
      error.cause = cause;
    }

    return error;
  };

  return {
    ceiling: () => fail(`Waited ${String(ceilingMs / 1000)} s for ${what}.`),
    because: (why, cause) => fail(`Waited for ${what}, but ${why}.`, cause),
  };
}

/** The promise's outcome under the ceiling; a failure of either kind shows the evidence, the promise's own as its cause. */
export async function within<T>(what: string, promise: Promise<T>): Promise<T> {
  const failed = waitFailure(what);
  let timer: NodeJS.Timeout | undefined;
  let ceiling: Error | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          ceiling = failed.ceiling();
          reject(ceiling);
        }, ceilingMs);
      }),
    ]);
  } catch (error: unknown) {
    if (error === ceiling) {
      throw error;
    }

    throw failed.because(
      `it failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** What a stand-in server keeps as it comes, and a wait on what it comes to hold. */
export type Observed<T> = {
  readonly items: readonly T[];
  readonly add: (item: T) => void;
  /** Settles on what `find` finds in the items, as soon as they hold it. */
  readonly until: <R>(
    what: string,
    find: (items: readonly T[]) => R | undefined,
  ) => Promise<R>;
};

export function observed<T>(): Observed<T> {
  const items: T[] = [];
  const checks = new Set<() => void>();

  return {
    items,
    add: item => {
      items.push(item);

      for (const check of [...checks]) {
        check();
      }
    },
    until: (what, find) =>
      within(
        what,
        new Promise(resolve => {
          const check = (): void => {
            const found = find(items);

            if (found !== undefined) {
              checks.delete(check);
              resolve(found);
            }
          };

          checks.add(check);
          check();
        }),
      ),
  };
}

function withEvidence(message: string): string {
  return [message, ...[...evidence].map(describe => describe())].join('\n\n');
}
