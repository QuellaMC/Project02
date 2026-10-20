/**
 * The runner running the suite, as the harness meets it: work for the end
 * of the test running now. Each suite supplies its own — the conformance
 * suite and the differential run Vitest's, once, in `setup.ts`; the
 * browser suite Playwright's, in its fixture, for each test and withdrawn
 * after it — and the harness never asks which.
 */
export type Teardown = () => void | Promise<void>;

export type Runner = {
  /**
   * Runs once the test has ended, passed or failed, the last given first:
   * a process goes before the home it ran in, and what a failure shows
   * stays until then.
   */
  readonly onTestFinished: (teardown: Teardown) => void;
};

let running: Runner | undefined;

/** The runner from now on; none between tests, where the harness refuses a call as Vitest does. */
export function useRunner(runner: Runner | undefined): void {
  running = runner;
}

export function onTestFinished(teardown: Teardown): void {
  if (running === undefined) {
    throw new Error('The harness was called outside a test.');
  }

  running.onTestFinished(teardown);
}
