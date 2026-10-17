import {describe, expect, it, vi} from 'vitest';

import {
  createBotApi,
  pollUpdates,
  type BotApi,
  type PollPacing,
  type PollProblem,
  type TelegramUpdate,
} from '../../src/frontends/telegram/bot-api.ts';
import {
  createFakeTelegram,
  webhookDescription,
} from '../support/telegram-api.ts';

const token = '123456:secret-part-of-the-token';
const bot = {id: 123456, username: 'mira_bot'};
const alice = {id: 42, is_bot: false, first_name: 'Alice', username: 'alice'};
const chat = {id: 42, type: 'private'};
const conflict = {
  code: 'conflict',
  description:
    'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
};

function startPolling(api: BotApi, pacing: PollPacing = {}) {
  const handed: TelegramUpdate[] = [];
  const reports: (PollProblem | undefined)[] = [];
  const abort = new AbortController();
  const polling = pollUpdates({
    api,
    onUpdate: update => {
      handed.push(update);
    },
    report: problem => {
      reports.push(problem);
    },
    signal: abort.signal,
    pacing,
  });

  return {
    handed,
    reports,
    polling,
    stop: () => {
      abort.abort();

      return polling;
    },
  };
}

/** The platform's fetch, noting when each call was sent. */
function noting(sentAt: number[]): typeof fetch {
  return (input, init) => {
    sentAt.push(performance.now());

    return fetch(input, init);
  };
}

describe('Telegram long polling', () => {
  it('hands updates on in order, skips what it cannot read, and asks past a batch once all of it was handed on', async () => {
    const telegram = await createFakeTelegram();

    telegram.registerBot(token, bot);
    telegram.push(token, {
      update_id: 7,
      message: {message_id: 1, from: alice, chat, date: 1, text: 'hi'},
    });
    telegram.push(token, {
      update_id: 8,
      callback_query: {
        id: 'query-1',
        from: alice,
        message: {message_id: 5, chat, date: 1},
        data: 'approve',
      },
    });
    telegram.push(token, {update_id: 9, message: {message_id: 'nine', chat}});

    const handed: TelegramUpdate[] = [];
    let release = (): void => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const abort = new AbortController();
    const polling = pollUpdates({
      api: createBotApi({token, fetch, baseUrl: telegram.baseUrl}),
      onUpdate: async update => {
        handed.push(update);
        await held;
      },
      report: () => undefined,
      signal: abort.signal,
    });

    await vi.waitFor(() => {
      expect(handed).toHaveLength(1);
    });
    expect(telegram.calls(token)).toHaveLength(1);
    release();
    await vi.waitFor(() => {
      expect(telegram.calls(token)).toHaveLength(2);
    });
    expect(handed).toEqual([
      {
        updateId: 7,
        message: {
          messageId: 1,
          chatId: 42,
          chatType: 'private',
          from: {id: 42, isBot: false, firstName: 'Alice', username: 'alice'},
          text: 'hi',
        },
      },
      {
        updateId: 8,
        callbackQuery: {
          id: 'query-1',
          from: {id: 42, isBot: false, firstName: 'Alice', username: 'alice'},
          message: {messageId: 5, chatId: 42},
          data: 'approve',
        },
      },
    ]);
    expect(telegram.calls(token).map(call => call.body)).toEqual([
      {offset: 0, timeout: 50, allowed_updates: ['message', 'callback_query']},
      {offset: 10, timeout: 50, allowed_updates: ['message', 'callback_query']},
    ]);
    abort.abort();
    await expect(polling).resolves.toBe('stopped');
    await telegram.close();
  });

  it('ends when Telegram refuses the token', async () => {
    const telegram = await createFakeTelegram();
    const {reports, polling} = startPolling(
      createBotApi({token, fetch, baseUrl: telegram.baseUrl}),
    );

    await expect(polling).resolves.toBe('unauthorized');
    expect(reports).toEqual([]);
    await telegram.close();
  });

  it('tells each of two pollers on one token of the other once, waits its cadence, and takes over when the other stops', async () => {
    const telegram = await createFakeTelegram();
    const sentAt: number[] = [];
    const api = createBotApi({
      token,
      fetch: noting(sentAt),
      baseUrl: telegram.baseUrl,
    });
    const cadenceMs = 100;

    telegram.registerBot(token, bot);

    const first = startPolling(api, {conflictRetryMs: cadenceMs});

    await vi.waitFor(() => {
      expect(sentAt).toHaveLength(1);
    });

    const second = startPolling(api, {conflictRetryMs: cadenceMs});

    // A poll that must wait ends the one already waiting, as Telegram's
    // server does, so the two take turns.
    await vi.waitFor(() => {
      expect(sentAt.length).toBeGreaterThanOrEqual(6);
    });

    const [, secondPoll = 0, thirdPoll = 0, fourthPoll = 0] = sentAt;

    // Timers round to the millisecond.
    expect(thirdPoll - secondPoll).toBeGreaterThanOrEqual(cadenceMs - 5);
    expect(fourthPoll - thirdPoll).toBeGreaterThanOrEqual(cadenceMs - 5);
    expect(first.reports).toEqual([conflict]);
    expect(second.reports).toEqual([conflict]);
    await expect(second.stop()).resolves.toBe('stopped');
    telegram.push(token, {
      update_id: 1,
      message: {message_id: 1, from: alice, chat, date: 1, text: 'hi'},
    });
    await vi.waitFor(() => {
      expect(first.handed).toHaveLength(1);
    });
    expect(first.reports).toEqual([conflict, undefined]);
    await expect(first.stop()).resolves.toBe('stopped');
    await telegram.close();
  });

  it('removes a webhook left on the token, says so once, and polls', async () => {
    const telegram = await createFakeTelegram();

    telegram.registerBot(token, bot);
    telegram.setWebhook(token);
    telegram.push(token, {
      update_id: 1,
      message: {message_id: 1, from: alice, chat, date: 1, text: 'hi'},
    });

    const {handed, reports, stop} = startPolling(
      createBotApi({token, fetch, baseUrl: telegram.baseUrl}),
    );

    await vi.waitFor(() => {
      expect(handed).toHaveLength(1);
    });
    expect(reports).toEqual([
      {code: 'webhook', description: webhookDescription},
      undefined,
    ]);
    expect(
      telegram
        .calls(token)
        .map(call => call.method)
        .slice(0, 3),
    ).toEqual(['getUpdates', 'deleteWebhook', 'getUpdates']);
    await expect(stop()).resolves.toBe('stopped');
    await telegram.close();
  });

  it('waits out the pause Telegram asks for before it polls again', async () => {
    const telegram = await createFakeTelegram();
    const sentAt: number[] = [];

    telegram.registerBot(token, bot);
    telegram.throttle(token, 1);

    const {reports, stop} = startPolling(
      createBotApi({token, fetch: noting(sentAt), baseUrl: telegram.baseUrl}),
    );

    await vi.waitFor(
      () => {
        expect(sentAt).toHaveLength(2);
      },
      {timeout: 3_000},
    );

    const [throttled = 0, next = 0] = sentAt;

    // Timers round to the millisecond.
    expect(next - throttled).toBeGreaterThanOrEqual(995);
    expect(reports).toEqual([]);
    await expect(stop()).resolves.toBe('stopped');
    await telegram.close();
  });

  it('says once that Telegram cannot be reached, backs off, and says so again when it is back', async () => {
    const away = await createFakeTelegram();
    const sentAt: number[] = [];
    const backoffMaxMs = 20;

    away.registerBot(token, bot);

    const {handed, reports, stop} = startPolling(
      createBotApi({token, fetch: noting(sentAt), baseUrl: away.baseUrl}),
      {backoffMaxMs},
    );

    await vi.waitFor(() => {
      expect(sentAt).toHaveLength(1);
    });
    await away.close();
    await vi.waitFor(() => {
      expect(sentAt.length).toBeGreaterThanOrEqual(4);
    });

    const [, , failed = 0, failedAgain = 0] = sentAt;

    // Timers round to the millisecond.
    expect(failedAgain - failed).toBeGreaterThanOrEqual(backoffMaxMs - 5);

    const back = await createFakeTelegram({port: away.port});

    back.registerBot(token, bot);
    back.push(token, {
      update_id: 1,
      message: {message_id: 1, from: alice, chat, date: 1, text: 'hi'},
    });
    await vi.waitFor(() => {
      expect(handed).toHaveLength(1);
    });
    expect(reports.map(problem => problem?.code)).toEqual([
      'unreachable',
      undefined,
    ]);
    expect(reports[0]?.description).toMatch(
      /^Telegram could not be reached: /u,
    );
    await expect(stop()).resolves.toBe('stopped');
    await back.close();
  });

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
