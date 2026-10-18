/**
 * Every wait in the suite ends here or in an idle deadline of the same
 * length: a daemon under load answers late, never this late. A wait that
 * fails shows what each process, stream and server the test started had
 * produced by then.
 */
import {onTestFinished} from 'vitest';

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
  readonly because: (why: string) => Error;
} {
  const error = new Error();
  const fail = (message: string): Error => {
    error.message = withEvidence(message);

    return error;
  };

  return {
    ceiling: () => fail(`Waited ${String(ceilingMs / 1000)} s for ${what}.`),
    because: why => fail(`Waited for ${what}, but ${why}.`),
  };
}

export async function within<T>(what: string, promise: Promise<T>): Promise<T> {
  const failed = waitFailure(what);
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(failed.ceiling());
        }, ceilingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function withEvidence(message: string): string {
  return [message, ...[...evidence].map(describe => describe())].join('\n\n');
}
