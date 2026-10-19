/**
 * Playwright's test with the conformance harness under it: each test hands
 * the harness its runner, and once the test is over runs what the harness
 * asked to run at its end, as Vitest does: the last asked first, each
 * whatever the one before it did, the first failure failing the test.
 */
import {test as playwright} from '@playwright/test';

import {useRunner, type Teardown} from '../conformance/harness/runner.ts';

export const test = playwright.extend<{harness: undefined}>({
  harness: [
    async ({}, use) => {
      const teardowns: Teardown[] = [];
      let failure: Error | undefined;

      useRunner({
        onTestFinished: teardown => {
          teardowns.push(teardown);
        },
      });
      await use(undefined);
      useRunner(undefined);

      for (const teardown of teardowns.reverse()) {
        try {
          await teardown();
        } catch (error: unknown) {
          failure ??= error instanceof Error ? error : new Error(String(error));
        }
      }

      if (failure !== undefined) {
        throw failure;
      }
    },
    {auto: true},
  ],
});
