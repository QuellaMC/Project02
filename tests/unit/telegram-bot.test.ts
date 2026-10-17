import {describe, expect, it, vi} from 'vitest';

import type {BotApi} from '../../src/frontends/telegram/bot-api.ts';
import {startBot, type BotRules} from '../../src/frontends/telegram/bot.ts';
import {
  gatewayProtocolVersion,
  type GatewayReady,
} from '../../src/gateway/api/index.ts';
import type {GatewayClient} from '../../src/gateway/client/index.ts';

const unused = (): never => {
  throw new Error('not called here');
};

/** Telegram as a bot's start meets it: it names the bot, and a poll waits until the bot stops. */
const telegram: BotApi = {
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
    new Promise(resolve => {
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
      api: telegram,
      client: daemon,
      settings: {
        kind: 'character',
        characterId: 'mira',
        name: 'Mira',
        mirror: true,
        pairedUsers: {},
      },
      say: () => undefined,
      report: () => undefined,
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
});
