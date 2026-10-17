import {describe, expect, it} from 'vitest';

import type {BotApi} from '../../src/frontends/telegram/bot-api.ts';
import type {BotContext} from '../../src/frontends/telegram/bot.ts';
import {createGate} from '../../src/frontends/telegram/gate.ts';
import type {Outbox} from '../../src/frontends/telegram/outbox.ts';
import {
  GatewayClientError,
  type GatewayClient,
} from '../../src/gateway/client/index.ts';
import type {PairingRequest} from '../../src/gateway/api/index.ts';

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

/** A daemon that answers every pairing request the one way given. */
function daemon(
  requestPairing: GatewayClient['requestPairing'],
): GatewayClient {
  return {
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
    requestPairing,
    pendingPairings: unused,
    settlePairing: unused,
    events: unused,
  };
}

const refusing = daemon(() =>
  Promise.resolve({
    status: 'refused',
    reason: 'config_unloadable',
    message: 'The Telegram settings could not be read.',
  }),
);

const bob = {id: 7, isBot: false, firstName: 'Bob'};

/** A gate for Mira's bot over the daemon given, with what it said in the chats, and the bot's stop. */
function gateOver(client: GatewayClient) {
  const stopping = new AbortController();
  const said: string[] = [];
  const reports: string[] = [];
  const outbox: Outbox = {
    paired: () => [],
    admitted: unused,
    heardFrom: () => undefined,
    say: (_chatId, text) => {
      said.push(text);
    },
    sayToPaired: unused,
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
    id: 987654,
    username: 'mira_bot',
    client: () => client,
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
    signal: stopping.signal,
    settled: () => Promise.resolve(),
  };

  return {
    gate: createGate(bot, outbox, () => 'Mira'),
    said,
    reports,
    stop: () => {
      stopping.abort();
    },
  };
}

describe('Telegram pairing gate', () => {
  it('tells an account how long its code has left, and how the request it gave the code for ended, not an earlier one', async () => {
    const request = (code: string, minutes: number): PairingRequest => ({
      connectorId: 'telegram',
      code,
      subject: {id: '7', label: 'Bob'},
      requestedAt: new Date().toISOString(),
      expiresAt: Date.now() + minutes * 60_000 - 1_000,
    });
    const codes = ['111111', '222222'];
    const {gate, said} = gateOver(
      daemon(() =>
        Promise.resolve({
          status: 'pending',
          request: request(codes.shift() ?? '', codes.length === 1 ? 60 : 2),
        }),
      ),
    );

    await expect(gate.admit(7, bob)).resolves.toBe(false);
    await expect(gate.admit(7, bob)).resolves.toBe(false);
    expect(said).toEqual([
      'This bot is private. Your pairing code is 111111, good for 60 minutes. Approve it on the web page, or send it to the management bot.',
      'This bot is private. Your pairing code is 222222, good for 2 minutes. Approve it on the web page, or send it to the management bot.',
    ]);

    const settled = (code: string) => {
      gate.settled({
        kind: 'pairing_settled',
        connectorId: 'telegram',
        code,
        subject: {id: '7', label: 'Bob'},
        decision: 'approved',
      });
    };

    settled('111111');
    expect(said).toHaveLength(2);
    settled('222222');
    expect(said.at(-1)).toBe('Paired. Mira is listening.');
  });

  it('gives up a pairing request still waiting on the daemon when the bot stops', async () => {
    const {gate, stop} = gateOver(
      daemon(
        (_connectorId, _subject, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(
                new GatewayClientError(
                  0,
                  'aborted',
                  'The request was aborted.',
                ),
              );
            });
          }),
      ),
    );
    const admitted = gate.admit(7, bob);

    stop();
    await expect(admitted).resolves.toBe(false);
  });

  it('tells an account the bot cannot pair it right now when the daemon refuses the request, and the operator why', async () => {
    const {gate, said, reports} = gateOver(refusing);

    await expect(gate.admit(7, bob)).resolves.toBe(false);
    expect(said).toEqual([
      'This bot is private, and cannot take a pairing request right now; try again later.',
    ]);
    expect(reports).toEqual([
      "Mira's bot could not ask to pair Bob: The Telegram settings could not be read.",
    ]);
  });
});
