import {describe, expect, it, vi} from 'vitest';

import type {
  BotApi,
  TelegramUpdate,
} from '../../src/frontends/telegram/bot-api.ts';
import {startBot, type BotRules} from '../../src/frontends/telegram/bot.ts';
import {
  gatewayProtocolVersion,
  type GatewayReady,
} from '../../src/gateway/api/index.ts';
import type {GatewayClient} from '../../src/gateway/client/index.ts';

const unused = (): never => {
  throw new Error('not called here');
};

/**
 * Telegram as a bot meets it: it names the bot, the first poll hands on
 * the updates given, and every poll after waits until the bot stops.
 */
function telegramWith(updates: readonly TelegramUpdate[] = []): BotApi {
  let polls = 0;

  return {
    getMe: () =>
      Promise.resolve({
        ok: true,
        result: {
          id: 987654,
          isBot: true,
          firstName: 'Mira',
          username: 'mira_bot',
        },
      }),
    getUpdates: ({signal}) =>
      polls++ === 0 && updates.length > 0
        ? Promise.resolve({ok: true, result: updates})
        : new Promise(resolve => {
            signal.addEventListener('abort', () => {
              resolve({ok: true, result: []});
            });
          }),
    sendMessage: unused,
    editMessageText: unused,
    deleteMessage: unused,
    answerCallbackQuery: unused,
    sendChatAction: unused,
    deleteWebhook: unused,
  };
}

/** A daemon a bot's start never asks anything of: the snapshot is handed to it. */
const daemon: GatewayClient = {
  baseUrl: 'http://127.0.0.1:1',
  health: unused,
  startCharacter: unused,
  openDirectConversation: unused,
  deliver: unused,
  history: unused,
  pendingConfirmations: unused,
  answerConfirmation: unused,
  configView: unused,
  applyConfigChange: unused,
  connectorConfig: unused,
  requestPairing: unused,
  pendingPairings: unused,
  settlePairing: unused,
  events: unused,
};

const snapshot: GatewayReady = {
  protocolVersion: gatewayProtocolVersion,
  health: {
    protocolVersion: gatewayProtocolVersion,
    homeRoot: '/home/a-home',
    config: {diagnostics: []},
    packages: {diagnostics: []},
    characters: [],
    connectors: [],
  },
  confirmations: [],
  pairings: [],
  turns: [],
};

/** What Mira's bot starts on, over the Telegram given. */
function miraOver(api: BotApi) {
  return {
    api,
    client: daemon,
    settings: {
      kind: 'character' as const,
      characterId: 'mira',
      name: 'Mira',
      mirror: true,
      pairedUsers: {},
    },
    say: () => undefined,
    report: () => undefined,
  };
}

describe('a Telegram bot', () => {
  it('installs the snapshot only once the settings it is shown by have been read', async () => {
    const installed: GatewayReady[] = [];
    const rules: BotRules = {
      onUpdate: () => Promise.resolve(),
      dispatch: () => undefined,
      snapshot: ready => {
        installed.push(ready);
      },
    };
    let settle = (): void => undefined;
    const settled = new Promise<void>(resolve => {
      settle = resolve;
    });
    const bot = startBot({
      ...miraOver(telegramWith()),
      rules: () => rules,
      snapshot: () => snapshot,
      settled: () => settled,
    });

    await new Promise(resolve => {
      setTimeout(resolve, 20);
    });
    expect(installed).toEqual([]);
    settle();
    await vi.waitFor(() => {
      expect(installed).toEqual([snapshot]);
    });
    await bot.stop();
  });

  it('stops while an update waits for settings that never come', async () => {
    const handed: TelegramUpdate[] = [];
    const update: TelegramUpdate = {
      updateId: 1,
      message: {messageId: 1, chatId: 1, chatType: 'private', text: 'hi'},
    };
    const bot = startBot({
      ...miraOver(telegramWith([update])),
      rules: () => ({
        onUpdate: received => {
          handed.push(received);

          return Promise.resolve();
        },
        dispatch: () => undefined,
        snapshot: () => undefined,
      }),
      snapshot: () => undefined,
      settled: () => new Promise(() => undefined),
    });

    await new Promise(resolve => {
      setTimeout(resolve, 20);
    });
    await expect(
      Promise.race([
        bot.stop().then(() => 'stopped'),
        new Promise(resolve => {
          setTimeout(() => {
            resolve('hung');
          }, 1_000);
        }),
      ]),
    ).resolves.toBe('stopped');
    expect(handed).toEqual([]);
  });
});
