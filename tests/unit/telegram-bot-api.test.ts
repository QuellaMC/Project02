import {describe, expect, it} from 'vitest';

import {
  createBotApi,
  pollUpdates,
  type PollProblem,
} from '../../src/frontends/telegram/bot-api.ts';

const token = '123456:secret-part-of-the-token';

describe('Telegram long polling', () => {
  it('keeps the token out of what it reports', async () => {
    const reports: (PollProblem | undefined)[] = [];
    const abort = new AbortController();
    const polling = pollUpdates({
      api: createBotApi({
        token,
        fetch: input =>
          Promise.reject(
            new TypeError(`fetch failed for ${new Request(input).url}`),
          ),
      }),
      onUpdate: () => undefined,
      report: problem => {
        reports.push(problem);
        abort.abort();
      },
      signal: abort.signal,
    });

    await expect(polling).resolves.toBe('stopped');
    expect(reports).toEqual([
      {
        code: 'unreachable',
        description:
          'Telegram could not be reached: fetch failed for https://api.telegram.org/bot[redacted]/getUpdates',
      },
    ]);
  });
});
