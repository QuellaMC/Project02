import {afterEach, describe, expect, it, vi} from 'vitest';

import type {
  BotApi,
  BotApiOutcome,
} from '../../src/frontends/telegram/bot-api.ts';
import type {BotContext} from '../../src/frontends/telegram/bot.ts';
import {createOutbox} from '../../src/frontends/telegram/outbox.ts';

/** A Bot API that records what is written and answers as Telegram does, but for the sends (by ordinal) and edits told to fail. */
function recordingApi(failing: {
  editsToFail?: number;
  failSendAt?: ReadonlySet<number>;
}) {
  const calls: {readonly method: string; readonly text: string}[] = [];
  const message = (
    id: number,
  ): BotApiOutcome<{messageId: number; chatId: number; chatType: string}> => ({
    ok: true,
    result: {messageId: id, chatId: 1, chatType: 'private'},
  });
  const unused = (): never => {
    throw new Error('not called here');
  };
  const api: BotApi = {
    getMe: unused,
    getUpdates: unused,
    sendMessage: ({text}) => {
      calls.push({method: 'sendMessage', text});

      if (failing.failSendAt?.has(calls.length) === true) {
        return Promise.resolve({ok: false, code: 0, description: 'no answer'});
      }

      return Promise.resolve(message(calls.length));
    },
    editMessageText: ({messageId, text}) => {
      calls.push({method: 'editMessageText', text});

      if ((failing.editsToFail ?? 0) > 0) {
        failing.editsToFail = (failing.editsToFail ?? 0) - 1;

        return Promise.resolve({ok: false, code: 0, description: 'no answer'});
      }

      return Promise.resolve(message(messageId));
    },
    deleteMessage: () => Promise.resolve({ok: true, result: true}),
    answerCallbackQuery: ({text}) => {
      calls.push({method: 'answerCallbackQuery', text: text ?? ''});

      return Promise.resolve({ok: true, result: true});
    },
    sendChatAction: () => Promise.resolve({ok: true, result: true}),
    deleteWebhook: unused,
  };

  return {api, calls};
}

/** Mira's bot, with Alice paired, over the API given. */
function miraBot(api: BotApi, reports: string[]): BotContext {
  return {
    api,
    username: 'mira_bot',
    client: () => {
      throw new Error('not called here');
    },
    settings: () => ({
      kind: 'character',
      characterId: 'mira',
      name: 'Mira',
      mirror: true,
      pairedUsers: {'1': 'Alice'},
    }),
    report: line => {
      reports.push(line);
    },
    signal: new AbortController().signal,
  };
}

describe('Telegram outbox', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the pieces of a text in order, and stops at one that could not be sent', async () => {
    // The first send of a commit, the first of a saying, and the second
    // piece of a longer commit fail.
    const {api, calls} = recordingApi({failSendAt: new Set([1, 2, 4])});
    const outbox = createOutbox(miraBot(api, []));
    const long = 'x'.repeat(5_000);
    const longer = 'y'.repeat(10_000);

    outbox.commit('d', long, true);
    outbox.say(1, long);
    outbox.commit('e', longer, true);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(4);
    });
    await new Promise(resolve => {
      setTimeout(resolve, 20);
    });
    expect(calls.map(call => call.text)).toEqual([
      long.slice(0, 4096),
      long.slice(0, 4096),
      longer.slice(0, 4096),
      longer.slice(4096, 8192),
    ]);
  });

  it("answers a button press with a toast within Telegram's 200 characters", async () => {
    const {api, calls} = recordingApi({});
    const outbox = createOutbox(miraBot(api, []));
    const press = {id: 'q1', from: {id: 1, isBot: false, firstName: 'Alice'}};

    outbox.answer(press, 'z'.repeat(300));
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.text).toBe(`${'z'.repeat(199)}…`);
  });

  it('tries an edit again at the commit when the one before it failed, though the words are the same', async () => {
    vi.useFakeTimers();

    const failing = {editsToFail: 1};
    const {api, calls} = recordingApi(failing);
    const reports: string[] = [];
    const outbox = createOutbox(miraBot(api, reports));

    outbox.draft('d', 'noted: ', true);
    await vi.advanceTimersByTimeAsync(0);
    outbox.draft('d', 'noted: hello', true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls).toEqual([
      {method: 'sendMessage', text: 'noted: '},
      {method: 'editMessageText', text: 'noted: hello'},
    ]);
    expect(reports).toEqual([
      "Mira's bot could not write to chat 1: no answer",
    ]);

    outbox.commit('d', 'noted: hello', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toEqual({
      method: 'editMessageText',
      text: 'noted: hello',
    });
    expect(calls).toHaveLength(3);
  });
});
