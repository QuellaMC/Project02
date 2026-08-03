/**
 * Execution gate for the tool calls in one model sampling batch.
 *
 * A tool declares how it may overlap: `shared` calls run concurrently
 * with other shared calls, `exclusive` calls run alone. The lock is
 * global across the batch — not per plugin and not per MCP server —
 * because two plugins can reach the same external resource, and the
 * batch is the unit the model reasoned about when it asked for these
 * calls together.
 *
 * Admission order is preserved: a waiting exclusive call is not
 * overtaken by later shared calls, so a batch never reorders the effects
 * the model requested.
 *
 * The lease is held for the whole dispatch — routing, the plugin's
 * handleToolCall hook, and capturing its result — so an exclusive call
 * holds it until the dispatch settles, not merely until the hook is
 * entered.
 *
 * What that does not cover: exclusivity spans the lifetime of the
 * dispatch, not the lifetime of every real-world side effect. A hook
 * that hits its timeout has its dispatch settled and its lease released,
 * while work it started keeps running if it ignored the AbortSignal it
 * was given — cancellation here is cooperative, and nothing in-process
 * can force a plugin to stop. Holding the lease until such a hook
 * finished would instead let one unresponsive plugin stall every later
 * exclusive call in the turn, which the user would feel. Enforcing the
 * stronger guarantee needs a boundary that can actually terminate a
 * hook, such as running plugins out of process.
 */
export type ToolBatchLockMode = 'shared' | 'exclusive';

export type ToolBatchLock = {
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
    // Head-of-line order: stop at the first waiter that cannot run, so a
    // queued exclusive call is never starved by a stream of shared ones.
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
