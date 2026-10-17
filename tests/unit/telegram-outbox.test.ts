import {afterEach, describe, expect, it, vi} from 'vitest';

import type {
  BotApi,
  BotApiOutcome,
} from '../../src/frontends/telegram/bot-api.ts';
import type {BotContext} from '../../src/frontends/telegram/bot.ts';
import {createOutbox} from '../../src/frontends/telegram/outbox.ts';

/** A Bot API that records what is written and answers as Telegram does, but for the edits told to fail. */
function recordingApi(failing: {editsToFail: number}) {
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

      return Promise.resolve(message(calls.length));
    },
    editMessageText: ({messageId, text}) => {
      calls.push({method: 'editMessageText', text});

      if (failing.editsToFail > 0) {
        failing.editsToFail -= 1;

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

describe('Telegram outbox', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tries an edit again at the commit when the one before it failed, though the words are the same', async () => {
    vi.useFakeTimers();

    const failing = {editsToFail: 1};
    const {api, calls} = recordingApi(failing);
    const reports: string[] = [];
    const bot: BotContext = {
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
    const outbox = createOutbox(bot);

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
