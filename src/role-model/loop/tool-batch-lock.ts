/**
 * Global across the batch: two plugins can reach the same external resource.
 * The lease covers the dispatch, not work that escapes a timed-out hook.
 */
export type ToolBatchLockMode = 'shared' | 'exclusive';

type ToolBatchLock = {
  run<T>(mode: ToolBatchLockMode, operation: () => Promise<T>): Promise<T>;
};

type LockWaiter = {
  readonly mode: ToolBatchLockMode;
  readonly admit: () => void;
};

export function createToolBatchLock(): ToolBatchLock {
  const waiters: LockWaiter[] = [];
  let sharedHolders = 0;
  let exclusiveHeld = false;

  const canAdmit = (mode: ToolBatchLockMode): boolean =>
    mode === 'shared' ? !exclusiveHeld : !exclusiveHeld && sharedHolders === 0;

  const admitWaiting = (): void => {
    // Head-of-line: stop at the first blocked waiter so exclusive is not starved.
    while (waiters.length > 0) {
      const next = waiters[0];

      if (next === undefined || !canAdmit(next.mode)) {
        return;
      }

      waiters.shift();

      if (next.mode === 'shared') {
        sharedHolders += 1;
      } else {
        exclusiveHeld = true;
      }

      next.admit();
    }
  };

  const acquire = async (mode: ToolBatchLockMode): Promise<void> => {
    if (waiters.length === 0 && canAdmit(mode)) {
      if (mode === 'shared') {
        sharedHolders += 1;
      } else {
        exclusiveHeld = true;
      }

      return;
    }

    await new Promise<void>(resolve => {
      waiters.push({mode, admit: resolve});
    });
  };

  const release = (mode: ToolBatchLockMode): void => {
    if (mode === 'shared') {
      sharedHolders -= 1;
    } else {
      exclusiveHeld = false;
    }

    admitWaiting();
  };

  return Object.freeze({
    async run<T>(mode: ToolBatchLockMode, operation: () => Promise<T>) {
      await acquire(mode);

      try {
        return await operation();
      } finally {
        release(mode);
      }
    },
  } satisfies ToolBatchLock);
}
