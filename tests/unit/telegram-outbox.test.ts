import {afterEach, describe, expect, it, vi} from 'vitest';

import type {
  BotApi,
  BotApiOutcome,
} from '../../src/frontends/telegram/bot-api.ts';
import type {BotContext} from '../../src/frontends/telegram/bot.ts';
import {createOutbox} from '../../src/frontends/telegram/outbox.ts';

/** A Bot API that records what is written and answers as Telegram does, but for the sends and edits told to fail. */
function recordingApi(failing: {editsToFail?: number; sendsToFail?: number}) {
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

      if ((failing.sendsToFail ?? 0) > 0) {
        failing.sendsToFail = (failing.sendsToFail ?? 0) - 1;

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
    answerCallbackQuery: () => Promise.resolve({ok: true, result: true}),
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

  it('sends the pieces after the first only once the first is in place', async () => {
    const failing = {sendsToFail: 1};
    const {api, calls} = recordingApi(failing);
    const outbox = createOutbox(miraBot(api, []));
    const long = 'x'.repeat(5_000);

    outbox.commit('d', long, true);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    await new Promise(resolve => {
      setTimeout(resolve, 20);
    });
    expect(calls).toEqual([{method: 'sendMessage', text: long.slice(0, 4096)}]);

    failing.sendsToFail = 1;
    outbox.say(1, long);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    await new Promise(resolve => {
      setTimeout(resolve, 20);
    });
    expect(calls).toHaveLength(2);
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
