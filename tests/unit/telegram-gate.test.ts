import {describe, expect, it} from 'vitest';

import type {BotApi} from '../../src/frontends/telegram/bot-api.ts';
import type {BotContext} from '../../src/frontends/telegram/bot.ts';
import {createGate} from '../../src/frontends/telegram/gate.ts';
import type {Outbox} from '../../src/frontends/telegram/outbox.ts';
import type {GatewayClient} from '../../src/gateway/client/index.ts';

const unused = (): never => {
  throw new Error('not called here');
};

/** A Bot API the gate never reaches: it speaks through the outbox. */
const silentApi: BotApi = {
  getMe: unused,
  getUpdates: unused,
  sendMessage: unused,
  editMessageText: unused,
  deleteMessage: unused,
  answerCallbackQuery: unused,
  sendChatAction: unused,
  deleteWebhook: unused,
};

/** A daemon that refuses every pairing request, as one whose allowlist cannot be read does. */
const refusing: GatewayClient = {
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
  requestPairing: () =>
    Promise.resolve({
      status: 'refused',
      reason: 'config_unloadable',
      message: 'The Telegram settings could not be read.',
    }),
  pendingPairings: unused,
  settlePairing: unused,
  events: unused,
};

describe('Telegram pairing gate', () => {
  it('tells an account the bot cannot pair it right now when the daemon refuses the request, and the operator why', async () => {
    const said: string[] = [];
    const reports: string[] = [];
    const outbox: Outbox = {
      paired: () => [],
      heardFrom: () => undefined,
      say: (_chatId, text) => {
        said.push(text);
      },
      card: unused,
      revise: unused,
      answer: unused,
      typing: unused,
      draft: unused,
      commit: unused,
      withdraw: unused,
      withdrawExcept: unused,
    };
    const bot: BotContext = {
      api: silentApi,
      username: 'mira_bot',
      client: () => refusing,
      settings: () => ({
        kind: 'character',
        characterId: 'mira',
        name: 'Mira',
        mirror: true,
        pairedUsers: {},
      }),
      report: line => {
        reports.push(line);
      },
      signal: new AbortController().signal,
    };
    const gate = createGate(bot, outbox, () => 'Mira');

    await expect(
      gate.admit(7, {id: 7, isBot: false, firstName: 'Bob'}),
    ).resolves.toBe(false);
    expect(said).toEqual([
      'This bot is private, and cannot take a pairing request right now; try again later.',
    ]);
    expect(reports).toEqual([
      "Mira's bot could not ask to pair Bob: The Telegram settings could not be read.",
    ]);
  });
});
