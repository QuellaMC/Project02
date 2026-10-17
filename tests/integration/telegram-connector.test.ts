import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

import {Hono} from 'hono';
import {streamSSE} from 'hono/streaming';
import {describe, expect, it, vi} from 'vitest';

import {runTelegramConnector} from '../../src/frontends/telegram/connector.ts';
import {createNodeFetch} from '../../src/frontends/telegram/node-fetch.ts';
import {
  createEventStreams,
  type EventStreams,
} from '../../src/gateway/http/events.ts';
import {
  createGateway,
  gatewayProtocolVersion,
  type ConfigChange,
  type ConfigTarget,
  type Gateway,
  type PairingRequest,
  type PendingConfirmation,
} from '../../src/gateway/index.ts';
import {demoConfigPluginId} from '../../src/plugins/packages/demo-config/plugin.ts';
import {
  characterDataDirPath,
  ensureCharacterDataDir,
  writeDaemonRecord,
} from '../../src/runtime/storage/index.ts';
import {isJsonRecord} from '../../src/shared/json-boundary.ts';
import {writeTestCharacterPackage} from '../support/character-fixtures.ts';
import {
  createGatewayTestHome,
  openDirect,
} from '../support/gateway-fixtures.ts';
import {
  listen,
  startTestGatewayServer,
  testGatewayToken,
  type TestGatewayServer,
} from '../support/gateway-http.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {createScriptedAdapter} from '../support/scripted-adapter.ts';
import {collect} from '../support/streams.ts';
import {
  createFakeTelegram,
  type FakeTelegram,
  type TelegramWireUpdate,
} from '../support/telegram-api.ts';

const homeToken = '123456:home';
const miraToken = '987654:mira';
const novaToken = '555555:nova';
const replacedToken = '987654:replaced';
const home: ConfigTarget = {scope: 'global'};
const mira: ConfigTarget = {scope: 'character', characterId: 'mira'};
const telegramSection = {namespace: 'connectors', id: 'telegram'} as const;
const managementOn = 'Telegram: management bot @home_bot is on.';
const miraAnswers = 'Telegram: @mira_bot answers for Mira.';
const novaAnswers = 'Telegram: @nova_bot answers for Nova.';

type TelegramStanza = {
  readonly enabled?: boolean;
  readonly config: Readonly<Record<string, unknown>>;
};

type Account = {
  readonly id: number;
  readonly first_name: string;
  readonly username?: string;
};

const alice: Account = {id: 4242, first_name: 'Alice'};
const bob: Account = {id: 5151, first_name: 'Bob', username: 'bob'};
const carol: Account = {id: 6161, first_name: 'Carol'};
const aliceIsPaired = {[String(alice.id)]: 'Alice'};

/**
 * Mira and Nova, answered by the scripted model, with the demo-config
 * plugin on, so a `confirm` line asks for a confirmation; and Telegram
 * authored in the home's document — the management bot's token, and the
 * accounts paired when a test names them — and in Mira's, her bot's token,
 * unless a test writes another stanza for either character.
 */
async function createTelegramHome(
  stanzas: {
    readonly pairedUsers?: Readonly<Record<string, string>>;
    readonly mira?: TelegramStanza;
    readonly nova?: TelegramStanza;
  } = {},
): Promise<{readonly homeRoot: string; readonly gateway: Gateway}> {
  const homeRoot = await createGatewayTestHome('project02-telegram-');
  const {pairedUsers, ...characters} = stanzas;

  writeTestCharacterPackage(homeRoot, {id: 'nova', displayName: 'Nova'});
  writeRuntimeConfig(join(homeRoot, 'config.json'), {
    plugins: {[demoConfigPluginId]: {enabled: true}},
    connectors: {
      telegram: {
        config: {
          managementBotToken: homeToken,
          ...(pairedUsers === undefined ? {} : {pairedUsers}),
        },
      },
    },
  });

  for (const [characterId, telegram] of Object.entries({
    mira: {config: {botToken: miraToken}},
    ...characters,
  })) {
    await ensureCharacterDataDir({homeRoot, characterId});
    writeRuntimeConfig(
      join(characterDataDirPath(homeRoot, characterId), 'config.json'),
      {connectors: {telegram}},
    );
  }

  return {
    homeRoot,
    gateway: createGateway({
      location: {storeRoot: homeRoot},
      roleModelAdapter: createScriptedAdapter({homeRoot, characterId: 'mira'}),
    }),
  };
}

function writeRecord(homeRoot: string, port: number, token = testGatewayToken) {
  writeDaemonRecord({
    homeRoot,
    record: {protocolVersion: gatewayProtocolVersion, token, port},
  });
}

/** The gateway on a loopback socket, and the home's record naming it, as a daemon writes both. */
async function serve(
  homeRoot: string,
  gateway: Gateway,
  options: {readonly port?: number; readonly events?: EventStreams} = {},
): Promise<TestGatewayServer> {
  const server = await startTestGatewayServer({gateway, ...options});

  writeRecord(homeRoot, server.port);

  return server;
}

async function startTelegram(): Promise<FakeTelegram> {
  const telegram = await createFakeTelegram();

  telegram.registerBot(homeToken, {id: 123456, username: 'home_bot'});
  telegram.registerBot(miraToken, {id: 987654, username: 'mira_bot'});
  telegram.registerBot(novaToken, {id: 555555, username: 'nova_bot'});
  telegram.registerBot(replacedToken, {id: 987655, username: 'mira_new_bot'});

  return telegram;
}

function runConnector(
  homeRoot: string,
  telegram: FakeTelegram,
  daemonFetch: typeof fetch = createNodeFetch(),
) {
  let stdout = '';
  let stderr = '';
  const abort = new AbortController();
  const exit = runTelegramConnector({
    homeRoot,
    fetch: daemonFetch,
    telegramBaseUrl: telegram.baseUrl,
    stdout: collect(chunk => {
      stdout += chunk;
    }),
    stderr: collect(chunk => {
      stderr += chunk;
    }),
    signal: abort.signal,
    pacing: {
      recordRetryMs: 20,
      readBackoffMaxMs: 20,
      poll: {backoffMaxMs: 20, conflictRetryMs: 20},
    },
  });

  return {
    stdout: () => stdout,
    stderr: () => stderr,
    exit,
    stop: () => {
      abort.abort();

      return exit;
    },
  };
}

/**
 * The connector's transport to the daemon, counting its reads of the
 * connector config; the first read goes through `first`, to be held or
 * failed.
 */
function watchReads(
  first: (send: () => Promise<Response>) => Promise<Response> = send => send(),
) {
  const transport = createNodeFetch();
  let reads = 0;
  const watched: typeof fetch = (input, init) => {
    const send = () => transport(input, init);
    const url = new URL(input instanceof Request ? input.url : input);

    if (url.pathname !== '/api/connectors/telegram/config') {
      return send();
    }

    reads += 1;

    return reads === 1 ? first(send) : send();
  };

  return {fetch: watched, reads: () => reads};
}

/** A change saved on a settings screen. */
async function change(
  gateway: Gateway,
  target: ConfigTarget,
  operation: ConfigChange['operation'],
): Promise<void> {
  const view = gateway.configView(target);

  if (view.status !== 'ok') {
    expect.fail(view.message);
  }

  await expect(
    gateway.applyConfigChange({
      target,
      expectedFingerprint: view.fingerprint,
      operation,
    }),
  ).resolves.toMatchObject({status: 'applied'});
}

function methods(telegram: FakeTelegram, token: string): readonly string[] {
  return telegram.calls(token).map(call => call.method);
}

let lastUpdateId = 0;

/**
 * A message from an account, as Telegram's wire carries it: in its private
 * chat with a bot unless another chat is named, and a sticker when it has
 * no text.
 */
function messageFrom(
  account: Account,
  messageId: number,
  text: string | undefined,
  chat: {readonly id: number; readonly type: string} = {
    id: account.id,
    type: 'private',
  },
): TelegramWireUpdate {
  lastUpdateId += 1;

  return {
    update_id: lastUpdateId,
    message: {
      message_id: messageId,
      date: 0,
      chat,
      from: {...account, is_bot: false},
      ...(text === undefined ? {sticker: {file_id: 'sticker'}} : {text}),
    },
  };
}

/** A press of a card's button by an account, as Telegram's wire carries it, under the update's id. */
function pressOn(
  account: Account,
  card: {readonly messageId: number},
  data: string,
): TelegramWireUpdate {
  lastUpdateId += 1;

  return {
    update_id: lastUpdateId,
    callback_query: {
      id: String(lastUpdateId),
      from: {...account, is_bot: false},
      message: {
        message_id: card.messageId,
        date: 0,
        chat: {id: account.id, type: 'private'},
      },
      chat_instance: String(account.id),
      data,
    },
  };
}

/** The bodies of a bot's calls of one method, in order. */
function bodiesOf(
  telegram: FakeTelegram,
  token: string,
  method: string,
): readonly Readonly<Record<string, unknown>>[] {
  return telegram
    .calls(token)
    .flatMap(call =>
      call.method === method && isJsonRecord(call.body) ? [call.body] : [],
    );
}

/**
 * Each card a bot sent to one chat: the id the fake gave its message — a
 * bot's messages are numbered from 1 as they are sent — its text, and its
 * buttons.
 */
function cardsIn(telegram: FakeTelegram, token: string, chatId: number) {
  return bodiesOf(telegram, token, 'sendMessage').flatMap((body, index) =>
    body['chat_id'] === chatId && body['reply_markup'] !== undefined
      ? [
          {
            messageId: index + 1,
            text: body['text'],
            keyboard: body['reply_markup'],
          },
        ]
      : [],
  );
}

/** The buttons of a card that asks about one confirmation or pairing request. */
function decisionButtons(letter: 'c' | 'p', key: string) {
  return {
    inline_keyboard: [
      [
        {text: 'Approve', callback_data: `${letter}:${key}:a`},
        {text: 'Deny', callback_data: `${letter}:${key}:d`},
      ],
    ],
  };
}

/** A moment as a card says it: the hour and minute, as the web page shows them. */
/** What a deadline has left as the bots say it, computed as they do. */
function minutesLeft(deadlineAt: number): string {
  const minutes = Math.max(1, Math.ceil((deadlineAt - Date.now()) / 60_000));

  return `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** The card a confirmation of Mira's gets, naming the surface it was raised on when one is given. */
function confirmationCard(
  pending: PendingConfirmation,
  options: {readonly raisedOn?: string; readonly ended?: boolean} = {},
): string {
  return [
    `Mira wants to: ${pending.request.summary}` +
      (options.raisedOn === undefined
        ? ''
        : ` · raised on ${options.raisedOn}`),
    JSON.stringify(pending.request.preview, null, 2),
    ...(options.ended === true
      ? []
      : [`Expires in ${minutesLeft(pending.deadlineAt)}`]),
  ].join('\n');
}

/** The card a pairing request gets on the management bot, its deadline dropped once it ended. */
function pairingCard(request: PairingRequest, ended = false): string {
  return (
    `${request.subject.label} wants to pair · code ${request.code}` +
    (ended ? '' : ` · expires in ${minutesLeft(request.expiresAt)}`)
  );
}

/** Each call a bot made to one chat, in order, with the text it carried. */
function callsTo(
  telegram: FakeTelegram,
  token: string,
  chatId: number,
): readonly {readonly method: string; readonly text: unknown}[] {
  return telegram
    .calls(token)
    .flatMap(({method, body}) =>
      isJsonRecord(body) && body['chat_id'] === chatId
        ? [{method, text: body['text']}]
        : [],
    );
}

/** What a bot wrote in one chat, sent or edited, in order. */
function textsIn(
  telegram: FakeTelegram,
  token: string,
  chatId: number,
): readonly unknown[] {
  return callsTo(telegram, token, chatId)
    .filter(
      call =>
        call.method === 'sendMessage' || call.method === 'editMessageText',
    )
    .map(call => call.text);
}

/** Her conversation's log, as history reads it. */
async function logOf(gateway: Gateway, characterId: string) {
  const {conversationId} = await openDirect(gateway, characterId);
  const history = await gateway.history(conversationId);

  if (history.status !== 'ok') {
    expect.fail(history.message);
  }

  return history.messages;
}

/** The request waiting for an account's pairing, once a bot has asked for it. */
function pairingOf(
  gateway: Gateway,
  account: Account,
): Promise<PairingRequest> {
  return vi.waitFor(() => {
    const request = gateway
      .pendingPairings()
      .find(pending => pending.subject.id === String(account.id));

    if (request === undefined) {
      throw new Error(`Nothing asks to pair ${account.first_name} yet.`);
    }

    return request;
  });
}

/** The confirmation waiting, once a turn has asked for one. */
function confirmationOf(gateway: Gateway): Promise<PendingConfirmation> {
  return vi.waitFor(
    () => {
      const [pending] = gateway.pendingConfirmations();

      if (pending === undefined) {
        throw new Error('Nothing waits for a confirmation yet.');
      }

      return pending;
    },
    {timeout: 5_000},
  );
}

/** Nothing polls these tokens: an update pushed to each is never asked for. */
async function expectUnpolled(
  telegram: FakeTelegram,
  ...tokens: readonly string[]
): Promise<void> {
  const before = tokens.map(token => telegram.calls(token).length);

  for (const token of tokens) {
    telegram.push(token, {update_id: 1});
  }

  await sleep(200);
  expect(tokens.map(token => telegram.calls(token).length)).toEqual(before);
}

describe('Telegram connector', () => {
  it('applies only the answer to the newest read, so a token replaced during the first read is never polled', async () => {
    const {homeRoot, gateway} = await createTelegramHome();
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    let answer = (): void => undefined;
    const answered = new Promise<void>(resolve => {
      answer = resolve;
    });
    let release = (): void => undefined;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    const daemon = watchReads(async send => {
      const response = await send();

      answer();
      await released;

      return response;
    });
    const connector = runConnector(homeRoot, telegram, daemon.fetch);

    // The first answer names the old token and is held; the change's own
    // read is answered while it waits.
    await answered;
    await change(gateway, mira, {
      kind: 'section_field_set',
      ...telegramSection,
      field: 'botToken',
      value: replacedToken,
    });
    await vi.waitFor(() => {
      expect(methods(telegram, replacedToken)).toEqual(['getMe', 'getUpdates']);
    });
    release();
    await sleep(200);

    expect(telegram.calls(miraToken)).toEqual([]);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('reads again on the ready after an outage the daemon could not replay, and restarts the bot on the token replaced meanwhile', async () => {
    const {homeRoot, gateway} = await createTelegramHome();
    const telegram = await startTelegram();
    const first = await serve(homeRoot, gateway);
    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    await first.close();
    await change(gateway, mira, {
      kind: 'section_field_set',
      ...telegramSection,
      field: 'botToken',
      value: replacedToken,
    });

    // Back on the same address as a new run: nothing of the old stream
    // is left to replay.
    const returned = await serve(homeRoot, gateway, {port: first.port});

    await vi.waitFor(
      () => {
        expect(connector.stdout()).toContain(
          'Telegram: @mira_new_bot answers for Mira.',
        );
      },
      {timeout: 5_000},
    );
    expect(connector.stdout()).toContain('Telegram: stopped @mira_bot (Mira).');
    await expectUnpolled(telegram, miraToken);
    await expect(connector.stop()).resolves.toBe(0);
    await returned.close();
    await telegram.close();
    await gateway.stop();
  });

  it('reads once on a stream the daemon resumed, for the messages that waited since it was lost, and then on the next change', async () => {
    const {homeRoot, gateway} = await createTelegramHome();
    const telegram = await startTelegram();
    // Another of the connector's processes stays on the stream, so this
    // one leaving and coming back changes nothing in health: the daemon
    // has nothing to replay, and the read on return is the connector's own.
    const otherProcess = gateway.connectorPresent('telegram');
    // The streams outlive the socket, as they do in the daemon.
    const events = createEventStreams(gateway);
    const first = await serve(homeRoot, gateway, {events});
    const daemon = watchReads();
    const connector = runConnector(homeRoot, telegram, daemon.fetch);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    await first.close();
    await vi.waitFor(() => {
      expect(events.openCount()).toBe(0);
    });

    const returned = await serve(homeRoot, gateway, {events, port: first.port});

    await vi.waitFor(
      () => {
        expect(events.openCount()).toBe(1);
      },
      {timeout: 5_000},
    );
    // The next read is the next change's.
    await change(gateway, mira, {
      kind: 'section_field_set',
      ...telegramSection,
      field: 'botToken',
      value: replacedToken,
    });
    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(
        'Telegram: @mira_new_bot answers for Mira.',
      );
    });
    expect(daemon.reads()).toBe(3);
    otherProcess();
    await expect(connector.stop()).resolves.toBe(0);
    await returned.close();
    await events.closeAll();
    await telegram.close();
    await gateway.stop();
  });

  it('tries a failed read again, and starts the bots', async () => {
    const {homeRoot, gateway} = await createTelegramHome();
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const daemon = watchReads(() =>
      Promise.reject(new TypeError('fetch failed')),
    );
    const connector = runConnector(homeRoot, telegram, daemon.fetch);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    expect(daemon.reads()).toBe(2);
    expect(connector.stderr()).toContain(
      "Telegram connector: the daemon's Telegram settings could not be read (",
    );
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it("runs a bot for each token the config holds, the home's management bot among them, and stops one whose token is cleared", async () => {
    const {homeRoot, gateway} = await createTelegramHome();
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(managementOn);
      expect(connector.stdout()).toContain(miraAnswers);
    });
    await change(gateway, home, {
      kind: 'section_field_unset',
      ...telegramSection,
      field: 'managementBotToken',
    });
    await change(gateway, mira, {
      kind: 'section_field_unset',
      ...telegramSection,
      field: 'botToken',
    });
    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(
        'Telegram: stopped @home_bot (the management bot).',
      );
      expect(connector.stdout()).toContain(
        'Telegram: stopped @mira_bot (Mira).',
      );
      expect(connector.stdout()).toContain(
        'Telegram is off, or no token is set; waiting for a change.',
      );
    });
    await expectUnpolled(telegram, homeToken, miraToken);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('polls a token two characters share once, and says whose bot is not started', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      nova: {config: {botToken: miraToken}},
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(methods(telegram, miraToken)).toEqual(['getMe', 'getUpdates']);
    });
    expect(connector.stderr()).toContain(
      "Nova's bot token is also Mira's; Nova's bot is not started.",
    );
    expect(connector.stdout()).toContain(miraAnswers);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it("stops the bots that follow the home's switch when it goes off, and not one switched on on her own screen", async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      mira: {enabled: true, config: {botToken: miraToken}},
      nova: {config: {botToken: novaToken}},
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(managementOn);
      expect(connector.stdout()).toContain(miraAnswers);
      expect(connector.stdout()).toContain(
        'Telegram: @nova_bot answers for Nova.',
      );
    });
    await change(gateway, home, {
      kind: 'section_enabled',
      ...telegramSection,
      enabled: false,
    });
    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(
        'Telegram: stopped @home_bot (the management bot).',
      );
      expect(connector.stdout()).toContain(
        'Telegram: stopped @nova_bot (Nova).',
      );
    });
    await expectUnpolled(telegram, homeToken, novaToken);
    expect(methods(telegram, miraToken)).toEqual(['getMe', 'getUpdates']);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it("names the settings page to fix when Telegram refuses a bot's token", async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      mira: {config: {botToken: '111111:revoked'}},
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stderr()).toContain(
        "Telegram refused Mira's bot token. Replace it on Mira's settings page.",
      );
    });
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('waits for a daemon whose record is not written yet, and connects once it is', async () => {
    const {homeRoot, gateway} = await createTelegramHome();
    const telegram = await startTelegram();
    const server = await startTestGatewayServer({gateway});
    const connector = runConnector(homeRoot, telegram);
    const waiting = `Telegram connector: waiting for the daemon on ${homeRoot}; run pnpm serve.`;

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(waiting);
    });
    writeRecord(homeRoot, server.port);
    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    expect(connector.stdout().split('\n').slice(0, 2)).toEqual([
      waiting,
      `Telegram connector: connected to ${server.baseUrl}.`,
    ]);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('follows a daemon that came back on another port once its record says so, and keeps its bots', async () => {
    const {homeRoot, gateway} = await createTelegramHome();
    const telegram = await startTelegram();
    const first = await serve(homeRoot, gateway);
    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });

    const moved = await startTestGatewayServer({gateway});

    await first.close();
    writeRecord(homeRoot, moved.port);
    await vi.waitFor(
      () => {
        expect(connector.stdout()).toContain(
          `Telegram connector: connected to ${moved.baseUrl}.`,
        );
      },
      {timeout: 5_000},
    );
    expect(methods(telegram, miraToken)).toEqual(['getMe', 'getUpdates']);
    await expect(connector.stop()).resolves.toBe(0);
    await moved.close();
    await telegram.close();
    await gateway.stop();
  });

  it("says once that the daemon refused the record's token, and connects once the record holds the daemon's", async () => {
    const {homeRoot, gateway} = await createTelegramHome();
    const telegram = await startTelegram();
    const minted = 'minted-afresh-0123456789abcdef';
    const server = await startTestGatewayServer({gateway, token: minted});

    writeRecord(homeRoot, server.port);

    const connector = runConnector(homeRoot, telegram);
    const refused = `Telegram connector: the daemon at ${server.baseUrl} refused the token in ${join(homeRoot, 'daemon.json')}; trying again.`;

    await vi.waitFor(() => {
      expect(connector.stderr()).toContain(refused);
    });
    writeRecord(homeRoot, server.port, minted);
    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    expect(connector.stderr()).toBe(`${refused}\n`);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('exits 1 when the daemon speaks another protocol, and says which', async () => {
    const homeRoot = await createGatewayTestHome('project02-telegram-');
    const telegram = await startTelegram();
    const older = await listen(
      new Hono().get('/api/events', c =>
        streamSSE(c, stream =>
          stream.writeSSE({
            event: 'ready',
            data: JSON.stringify({protocolVersion: 6}),
          }),
        ),
      ),
    );

    writeDaemonRecord({
      homeRoot,
      record: {protocolVersion: 6, token: testGatewayToken, port: older.port},
    });

    const connector = runConnector(homeRoot, telegram);

    await expect(connector.exit).resolves.toBe(1);
    expect(connector.stderr()).toBe(
      `This connector speaks protocol ${String(gatewayProtocolVersion)}; the daemon speaks 6. Update one of them.\n`,
    );
    await older.close();
    await telegram.close();
  });

  it('starts a bot afresh when its token moves to another character', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      nova: {config: {botToken: miraToken}},
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    await change(gateway, mira, {
      kind: 'section_field_unset',
      ...telegramSection,
      field: 'botToken',
    });
    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(
        'Telegram: stopped @mira_bot (Mira).',
      );
      expect(connector.stdout()).toContain(
        'Telegram: @mira_bot answers for Nova.',
      );
    });
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it("carries a paired account's line to her under the bot's stamps, and edits the reply's message as it is written, then into its committed text", async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    // Paced pieces, at least 4 ms apart: the reply is written for longer
    // than one interval between edits.
    const line = `slowly ${Array.from({length: 450}, (_, word) => `w${String(word)}`).join(' ')}`;
    const reply = `noted: ${line}`;

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(alice, 7, line));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id).at(-1)).toBe(reply);
      },
      {timeout: 10_000},
    );

    const [posted, ...edits] = callsTo(telegram, miraToken, alice.id).filter(
      call => call.method !== 'sendChatAction',
    );

    expect(posted).toEqual({method: 'sendMessage', text: 'noted: '});
    expect(edits.map(call => call.method)).toEqual(
      edits.map(() => 'editMessageText'),
    );
    // Hundreds of pieces, and an edit at most once an interval, each
    // showing the reply so far.
    expect(edits.length).toBeGreaterThan(1);
    expect(edits.length).toBeLessThan(10);
    expect(edits.every(call => reply.startsWith(String(call.text)))).toBe(true);
    await expect(logOf(gateway, 'mira')).resolves.toMatchObject([
      {
        role: 'user',
        text: line,
        source: 'telegram:mira_bot',
        clientMessageId: '987654.4242.7',
      },
      {role: 'character', text: reply},
    ]);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it("sends a reply longer than a Telegram message whole: its draft's message holds the first part, and the rest follows", async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const line = Array.from(
      {length: 1_000},
      (_, word) => `w${String(word)}`,
    ).join(' ');
    const reply = `noted: ${line}`;

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(alice, 1, line));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id)).toEqual([
          'noted: ',
          reply.slice(0, 4096),
          reply.slice(4096),
        ]);
      },
      {timeout: 5_000},
    );
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('carries nothing from a group or without text, and tells a sticker it reads only text', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const group = {id: -1_002_003, type: 'group'};

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(alice, 1, 'hello, all', group));
    telegram.push(miraToken, messageFrom(alice, 2, undefined));
    await vi.waitFor(() => {
      expect(callsTo(telegram, miraToken, alice.id)).toEqual([
        {method: 'sendMessage', text: 'I can only read text here for now.'},
      ]);
    });
    expect(callsTo(telegram, miraToken, group.id)).toEqual([]);
    await expect(logOf(gateway, 'mira')).resolves.toEqual([]);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it("shows another surface's turn in the chat of a character who mirrors, and no chat its own line", async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
      nova: {config: {botToken: novaToken, mirror: false}},
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);

    await gateway.startCharacter('mira');
    await gateway.startCharacter('nova');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
      expect(connector.stdout()).toContain(novaAnswers);
    });
    // Each bot has her conversation open once it has carried a line there.
    telegram.push(miraToken, messageFrom(alice, 1, 'hello'));
    telegram.push(novaToken, messageFrom(alice, 1, 'hello'));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id)).toContain(
          'noted: hello',
        );
        expect(textsIn(telegram, novaToken, alice.id)).toContain(
          'noted: hello',
        );
      },
      {timeout: 5_000},
    );

    for (const characterId of ['mira', 'nova']) {
      const ref = await openDirect(gateway, characterId);

      await gateway.deliver({
        conversationId: ref.conversationId,
        senderId: ref.userParticipantId,
        text: 'from the web',
        source: 'web',
        clientMessageId: `web-${characterId}`,
      });
    }

    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id)).toEqual([
          'noted: ',
          'noted: hello',
          'You (web): from the web',
          'noted: ',
          'noted: from the web',
        ]);
      },
      {timeout: 5_000},
    );
    // A line after the web's turn: once its reply is in, Nova's chat has
    // been shown all it will be of that turn.
    telegram.push(novaToken, messageFrom(alice, 2, 'again'));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, novaToken, alice.id).at(-1)).toBe(
          'noted: again',
        );
      },
      {timeout: 5_000},
    );
    expect(textsIn(telegram, novaToken, alice.id)).toEqual([
      'noted: ',
      'noted: hello',
      'noted: ',
      'noted: again',
    ]);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('shows a reply already being written when the bot starts during the turn', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const line = `slowly ${Array.from({length: 700}, (_, word) => `w${String(word)}`).join(' ')}`;
    const reply = `noted: ${line}`;

    await gateway.startCharacter('mira');

    const ref = await openDirect(gateway, 'mira');
    const turn = gateway.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: line,
      source: 'web',
      clientMessageId: 'web-1',
    });
    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    await turn;
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id).at(-1)).toBe(reply);
      },
      {timeout: 5_000},
    );

    const shown = textsIn(telegram, miraToken, alice.id);

    // Joined while the reply was written: shown from there on, then whole.
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.every(text => reply.startsWith(String(text)))).toBe(true);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('shows no more of a reply to a chat unpaired while it is written', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: {...aliceIsPaired, [String(bob.id)]: 'Bob'},
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const line = `slowly ${Array.from({length: 700}, (_, word) => `w${String(word)}`).join(' ')}`;
    const reply = `noted: ${line}`;

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(alice, 1, line));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, bob.id)).toEqual(['noted: ']);
      },
      {timeout: 5_000},
    );
    await change(gateway, home, {
      kind: 'section_field_set',
      ...telegramSection,
      field: 'pairedUsers',
      value: aliceIsPaired,
    });
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id).at(-1)).toBe(reply);
      },
      {timeout: 10_000},
    );

    const shownToBob = textsIn(telegram, miraToken, bob.id);

    expect(shownToBob.every(text => reply.startsWith(String(text)))).toBe(true);
    expect(shownToBob).not.toContain(reply);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('sends a message again after the pause Telegram asked for', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const hello = "Hi, I'm Mira. Write to me here.";

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.throttle(miraToken, 0.05, 'sendMessage');
    telegram.push(miraToken, messageFrom(alice, 1, '/start'));
    // The refused call and the one after the pause, both on the record.
    await vi.waitFor(() => {
      expect(textsIn(telegram, miraToken, alice.id)).toEqual([hello, hello]);
    });
    expect(connector.stderr()).not.toContain('could not write');
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it("keeps a reply's message across a stream the daemon could not resume, and brings it to the words the snapshot carries", async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const events = createEventStreams(gateway, {
      replayBytes: 1,
      graceMs: 100,
    });
    const first = await serve(homeRoot, gateway, {events});
    const line = `slowly ${Array.from({length: 700}, (_, word) => `w${String(word)}`).join(' ')}`;
    const reply = `noted: ${line}`;

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(alice, 1, line));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id)).toEqual(['noted: ']);
      },
      {timeout: 5_000},
    );
    await first.close();

    // Back on the same address, mid-reply, with a log too short to replay:
    // the ready carries the draft, and its message stays.
    const returned = await serve(homeRoot, gateway, {
      port: first.port,
      events,
    });

    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id).at(-1)).toBe(reply);
      },
      {timeout: 10_000},
    );
    expect(bodiesOf(telegram, miraToken, 'deleteMessage')).toEqual([]);
    expect(
      new Set(
        bodiesOf(telegram, miraToken, 'editMessageText').map(
          body => body['message_id'],
        ),
      ),
    ).toEqual(new Set([1]));
    await expect(connector.stop()).resolves.toBe(0);
    await returned.close();
    await events.closeAll();
    await telegram.close();
    await gateway.stop();
  });

  it('shows a long line from another surface in as many messages as it takes', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const text = Array.from(
      {length: 1_000},
      (_, word) => `m${String(word)}`,
    ).join(' ');
    const mirrored = `You (web): ${text}`;

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(alice, 1, 'hello'));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id)).toContain(
          'noted: hello',
        );
      },
      {timeout: 5_000},
    );

    const ref = await openDirect(gateway, 'mira');

    await gateway.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text,
      source: 'web',
      clientMessageId: 'web-long',
    });
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id)).toEqual(
          expect.arrayContaining([
            mirrored.slice(0, 4096),
            mirrored.slice(4096),
          ]),
        );
      },
      {timeout: 5_000},
    );
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('shows a reply committed before her DM was known, once it is', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const transport = createNodeFetch();
    let releaseOpen = (): void => undefined;
    const opened = new Promise<void>(resolve => {
      releaseOpen = resolve;
    });
    // Her DM opens only when the test lets it, as a slow daemon would.
    const holdingOpen: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.pathname === '/api/conversations/open') {
        await opened;
      }

      return transport(input, init);
    };

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram, holdingOpen);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });

    const ref = await openDirect(gateway, 'mira');

    await gateway.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: 'hello',
      source: 'web',
      clientMessageId: 'web-1',
    });
    expect(textsIn(telegram, miraToken, alice.id)).toEqual([]);
    releaseOpen();
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id)).toEqual([
          'You (web): hello',
          'noted: ',
          'noted: hello',
        ]);
      },
      {timeout: 5_000},
    );
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('waits the pause Telegram asks for before asking again who a bot is', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);

    await gateway.startCharacter('mira');
    telegram.throttle(miraToken, 1, 'getMe');

    const connector = runConnector(homeRoot, telegram);

    await sleep(500);
    expect(connector.stdout()).not.toContain(miraAnswers);
    await vi.waitFor(
      () => {
        expect(connector.stdout()).toContain(miraAnswers);
      },
      {timeout: 3_000},
    );
    expect(
      methods(telegram, miraToken).filter(method => method === 'getMe'),
    ).toEqual(['getMe', 'getMe']);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it("applies the settings changed during an outage before the ready's snapshot reaches the bots", async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: {...aliceIsPaired, [String(bob.id)]: 'Bob'},
    });
    const telegram = await startTelegram();
    const events = createEventStreams(gateway, {
      replayBytes: 1,
      graceMs: 100,
    });
    const first = await serve(homeRoot, gateway, {events});
    const line = `slowly ${Array.from({length: 700}, (_, word) => `w${String(word)}`).join(' ')}`;

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(alice, 1, 'hello'));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, bob.id)).toContain('noted: hello');
      },
      {timeout: 5_000},
    );

    const shownToBob = textsIn(telegram, miraToken, bob.id);

    await first.close();
    // While the connector is away: Bob is unpaired, and a web turn begins.
    await change(gateway, home, {
      kind: 'section_field_set',
      ...telegramSection,
      field: 'pairedUsers',
      value: aliceIsPaired,
    });

    const ref = await openDirect(gateway, 'mira');
    const turn = gateway.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: line,
      source: 'web',
      clientMessageId: 'web-1',
    });
    const returned = await serve(homeRoot, gateway, {
      port: first.port,
      events,
    });

    await turn;
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id).at(-1)).toBe(
          `noted: ${line}`,
        );
      },
      {timeout: 5_000},
    );
    expect(textsIn(telegram, miraToken, bob.id)).toEqual(shownToBob);
    await expect(connector.stop()).resolves.toBe(0);
    await returned.close();
    await events.closeAll();
    await telegram.close();
    await gateway.stop();
  });

  it('says nothing of a line Telegram hands on again that the daemon took already', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(alice, 1, 'hello'));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id)).toContain(
          'noted: hello',
        );
      },
      {timeout: 5_000},
    );

    const shown = textsIn(telegram, miraToken, alice.id);

    telegram.push(miraToken, messageFrom(alice, 1, 'hello'));
    await sleep(300);
    expect(textsIn(telegram, miraToken, alice.id)).toEqual(shown);

    const lines = await logOf(gateway, 'mira');

    expect(lines.filter(line => line.role === 'user')).toHaveLength(1);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it("goes quiet when Telegram refuses a bot's token while it runs, naming the settings page once", async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(alice, 1, 'hello'));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id)).toContain(
          'noted: hello',
        );
      },
      {timeout: 5_000},
    );
    telegram.revokeBot(miraToken);
    await vi.waitFor(
      () => {
        expect(connector.stderr()).toContain(
          "Telegram refused Mira's bot token. Replace it on Mira's settings page.",
        );
      },
      {timeout: 5_000},
    );

    const ref = await openDirect(gateway, 'mira');

    await gateway.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: 'from the web',
      source: 'web',
      clientMessageId: 'web-1',
    });
    await sleep(200);
    expect(connector.stderr()).not.toContain('could not write');
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('asks again to open her DM when the daemon could not be reached for it, and shows the turns held meanwhile', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const transport = createNodeFetch();
    let opens = 0;
    // The first open finds the daemon stopping; the next finds it there.
    const stumbling: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.pathname === '/api/conversations/open' && opens++ === 0) {
        return Promise.resolve(new Response(null, {status: 503}));
      }

      return transport(input, init);
    };

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram, stumbling);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });

    const ref = await openDirect(gateway, 'mira');

    await gateway.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: 'hello',
      source: 'web',
      clientMessageId: 'web-1',
    });
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id)).toEqual([
          'You (web): hello',
          'noted: ',
          'noted: hello',
        ]);
      },
      {timeout: 5_000},
    );
    expect(opens).toBe(2);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it("takes a line from a bot that replaced hers though Telegram numbers its messages from one again, since a line's stamp names the bot", async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(alice, 1, 'first'));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id)).toContain(
          'noted: first',
        );
      },
      {timeout: 5_000},
    );
    await change(gateway, mira, {
      kind: 'section_field_set',
      ...telegramSection,
      field: 'botToken',
      value: replacedToken,
    });
    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(
        'Telegram: @mira_new_bot answers for Mira.',
      );
    });
    telegram.push(replacedToken, messageFrom(alice, 1, 'second'));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, replacedToken, alice.id)).toContain(
          'noted: second',
        );
      },
      {timeout: 5_000},
    );

    const lines = await logOf(gateway, 'mira');

    expect(
      lines
        .filter(line => line.role === 'user')
        .map(line => line.clientMessageId),
    ).toEqual(['987654.4242.1', '987655.4242.1']);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('answers a command with nothing when the account was unpaired while the daemon was asked', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const transport = createNodeFetch();
    let reads = 0;
    let releaseHealth = (): void => undefined;
    const heldHealth = new Promise<void>(resolve => {
      releaseHealth = resolve;
    });
    // The daemon answers /status's question only when the test lets it.
    const holdingHealth: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.pathname === '/api/connectors/telegram/config') {
        reads += 1;
      }

      if (url.pathname === '/api/health') {
        await heldHealth;
      }

      return transport(input, init);
    };
    const connector = runConnector(homeRoot, telegram, holdingHealth);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(managementOn);
    });
    telegram.push(homeToken, messageFrom(alice, 1, '/status'));
    await change(gateway, home, {
      kind: 'section_field_unset',
      ...telegramSection,
      field: 'pairedUsers',
    });
    await vi.waitFor(() => {
      expect(reads).toBeGreaterThanOrEqual(2);
    });
    await sleep(100);
    releaseHealth();
    await sleep(300);
    expect(callsTo(telegram, homeToken, alice.id)).toEqual([]);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it("holds a message that arrives before a ready's settings are read, and judges it by them", async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: {...aliceIsPaired, [String(bob.id)]: 'Bob'},
    });
    const telegram = await startTelegram();
    const events = createEventStreams(gateway, {
      replayBytes: 1,
      graceMs: 100,
    });
    const first = await serve(homeRoot, gateway, {events});
    const transport = createNodeFetch();
    let reads = 0;
    let releaseReads = (): void => undefined;
    const heldReads = new Promise<void>(resolve => {
      releaseReads = resolve;
    });
    // Every read after the first waits until the test lets it through.
    const holdingReads: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.pathname === '/api/connectors/telegram/config' && ++reads >= 2) {
        await heldReads;
      }

      return transport(input, init);
    };

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram, holdingReads);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(bob, 1, 'hello'));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, bob.id)).toContain('noted: hello');
      },
      {timeout: 5_000},
    );
    await first.close();
    await change(gateway, home, {
      kind: 'section_field_set',
      ...telegramSection,
      field: 'pairedUsers',
      value: aliceIsPaired,
    });

    const returned = await serve(homeRoot, gateway, {
      port: first.port,
      events,
    });

    await vi.waitFor(
      () => {
        expect(reads).toBeGreaterThanOrEqual(2);
      },
      {timeout: 5_000},
    );
    telegram.push(miraToken, messageFrom(bob, 2, 'again'));
    await sleep(300);

    const userLines = async () =>
      (await logOf(gateway, 'mira'))
        .filter(line => line.role === 'user')
        .map(line => line.text);

    await expect(userLines()).resolves.toEqual(['hello']);
    releaseReads();
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, bob.id).at(-1)).toMatch(
          /Your pairing code is/u,
        );
      },
      {timeout: 5_000},
    );
    await expect(userLines()).resolves.toEqual(['hello']);
    await expect(connector.stop()).resolves.toBe(0);
    await returned.close();
    await events.closeAll();
    await telegram.close();
    await gateway.stop();
  });

  it('holds a message that arrives while the stream is lost, and judges it by the settings read on its return', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: {...aliceIsPaired, [String(bob.id)]: 'Bob'},
    });
    const telegram = await startTelegram();
    const events = createEventStreams(gateway);
    const first = await serve(homeRoot, gateway, {events});

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(bob, 1, 'hello'));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, bob.id)).toContain('noted: hello');
      },
      {timeout: 5_000},
    );

    const shownToBob = textsIn(telegram, miraToken, bob.id);

    await first.close();
    await vi.waitFor(() => {
      expect(connector.stdout()).toContain('waiting for the daemon');
    });
    await change(gateway, home, {
      kind: 'section_field_set',
      ...telegramSection,
      field: 'pairedUsers',
      value: aliceIsPaired,
    });
    telegram.push(miraToken, messageFrom(bob, 2, 'again'));
    await sleep(300);
    expect(textsIn(telegram, miraToken, bob.id)).toEqual(shownToBob);

    const returned = await serve(homeRoot, gateway, {port: first.port, events});

    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, bob.id).at(-1)).toMatch(
          /Your pairing code is/u,
        );
      },
      {timeout: 5_000},
    );

    const lines = await logOf(gateway, 'mira');

    expect(
      lines.filter(line => line.role === 'user').map(line => line.text),
    ).toEqual(['hello']);
    await expect(connector.stop()).resolves.toBe(0);
    await returned.close();
    await events.closeAll();
    await telegram.close();
    await gateway.stop();
  });

  it('hands the frames a resumed stream brings back to the bots only once the settings are read, so a chat unpaired meanwhile gets none of them', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: {...aliceIsPaired, [String(bob.id)]: 'Bob'},
    });
    const telegram = await startTelegram();
    const events = createEventStreams(gateway);
    const first = await serve(homeRoot, gateway, {events});

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(alice, 1, 'hello'));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, bob.id)).toContain('noted: hello');
      },
      {timeout: 5_000},
    );

    const shownToBob = textsIn(telegram, miraToken, bob.id);
    const shownToAlice = textsIn(telegram, miraToken, alice.id);

    await first.close();
    await vi.waitFor(() => {
      expect(connector.stdout()).toContain('waiting for the daemon');
    });
    // While the stream is away: Bob is unpaired, and a web turn runs whole.
    await change(gateway, home, {
      kind: 'section_field_set',
      ...telegramSection,
      field: 'pairedUsers',
      value: aliceIsPaired,
    });

    const ref = await openDirect(gateway, 'mira');

    await gateway.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: 'from the web',
      source: 'web',
      clientMessageId: 'web-1',
    });

    const returned = await serve(homeRoot, gateway, {port: first.port, events});

    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id)).toEqual([
          ...shownToAlice,
          'You (web): from the web',
          'noted: ',
          'noted: from the web',
        ]);
      },
      {timeout: 5_000},
    );
    expect(textsIn(telegram, miraToken, bob.id)).toEqual(shownToBob);
    await expect(connector.stop()).resolves.toBe(0);
    await returned.close();
    await events.closeAll();
    await telegram.close();
    await gateway.stop();
  });

  it("holds a line written while the daemon's socket is closed, and carries it once the daemon is back", async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const first = await serve(homeRoot, gateway);

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    await first.close();
    await vi.waitFor(() => {
      expect(connector.stdout()).toContain('waiting for the daemon');
    });
    telegram.push(miraToken, messageFrom(alice, 1, 'anyone there?'));
    await sleep(300);
    expect(textsIn(telegram, miraToken, alice.id)).toEqual([]);

    const returned = await serve(homeRoot, gateway, {port: first.port});

    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id)).toContain(
          'noted: anyone there?',
        );
      },
      {timeout: 5_000},
    );
    await expect(connector.stop()).resolves.toBe(0);
    await returned.close();
    await telegram.close();
    await gateway.stop();
  });

  it('tells the chat, once, why a line got no answer: refused before any turn, or not answered in its turn', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
      nova: {config: {botToken: novaToken}},
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const notAnswered =
      'Mira could not answer: Adapter output must be valid JSON.';
    const notTaken =
      'Mira could not answer: Provide exactly one non-empty single-line message.\nYour message was not taken; send it again.';

    // Nova is never started.
    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
      expect(connector.stdout()).toContain(novaAnswers);
    });
    telegram.push(novaToken, messageFrom(alice, 1, 'hello'));
    telegram.push(miraToken, messageFrom(alice, 1, 'reject'));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, novaToken, alice.id)).toEqual([
          'Nova is not available right now: Character "nova" has not been started.',
        ]);
        expect(textsIn(telegram, miraToken, alice.id)).toEqual([notAnswered]);
      },
      {timeout: 5_000},
    );
    telegram.push(miraToken, messageFrom(alice, 2, 'two\nlines'));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id).at(-1)).toBe(notTaken);
      },
      {timeout: 5_000},
    );
    // Once a later line's reply is in, any second telling would be too.
    telegram.push(miraToken, messageFrom(alice, 3, 'hello'));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id).at(-1)).toBe(
          'noted: hello',
        );
      },
      {timeout: 5_000},
    );
    expect(textsIn(telegram, miraToken, alice.id)).toEqual([
      notAnswered,
      notTaken,
      'noted: ',
      'noted: hello',
    ]);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('gives an account it does not know a pairing code and carries nothing, then carries its lines once the owner approves, and tells one declined so', async () => {
    const {homeRoot, gateway} = await createTelegramHome();
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(bob, 1, 'let me in'));

    const approved = await pairingOf(gateway, bob);

    expect(approved.subject.label).toBe('Bob (@bob)');
    await vi.waitFor(() => {
      expect(textsIn(telegram, miraToken, bob.id)).toEqual([
        `This bot is private. Your pairing code is ${approved.code}, good for 60 minutes. Approve it on the web page, or send it to the management bot.`,
      ]);
    });
    await expect(
      gateway.settlePairing(approved.code, 'approved'),
    ).resolves.toEqual({status: 'settled', decision: 'approved'});
    await vi.waitFor(() => {
      expect(textsIn(telegram, miraToken, bob.id).at(-1)).toBe(
        'Paired. Mira is listening.',
      );
    });
    telegram.push(miraToken, messageFrom(bob, 2, 'hello'));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, bob.id).at(-1)).toBe(
          'noted: hello',
        );
      },
      {timeout: 5_000},
    );
    telegram.push(miraToken, messageFrom(carol, 1, 'me too'));

    const declined = await pairingOf(gateway, carol);

    await expect(
      gateway.settlePairing(declined.code, 'denied'),
    ).resolves.toEqual({status: 'settled', decision: 'denied'});
    await vi.waitFor(() => {
      expect(textsIn(telegram, miraToken, carol.id).at(-1)).toBe(
        'The owner declined.',
      );
    });

    const lines = await logOf(gateway, 'mira');

    expect(
      lines.filter(line => line.role === 'user').map(line => line.text),
    ).toEqual(['hello']);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it("asks for a confirmation of her turn in the chat its line came from, takes the button's answer, and edits the card to how it ended", async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(alice, 1, 'confirm'));

    const pending = await confirmationOf(gateway);
    const card = confirmationCard(pending);

    await vi.waitFor(() => {
      expect(cardsIn(telegram, miraToken, alice.id)).toEqual([
        {messageId: 1, text: card, keyboard: decisionButtons('c', pending.id)},
      ]);
    });

    const press = pressOn(alice, {messageId: 1}, `c:${pending.id}:a`);

    telegram.push(miraToken, press);
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id)).toContain('done');
        expect(bodiesOf(telegram, miraToken, 'answerCallbackQuery')).toEqual([
          {callback_query_id: String(press.update_id), text: 'Approved.'},
        ]);
        expect(bodiesOf(telegram, miraToken, 'editMessageText')).toEqual([
          {
            chat_id: alice.id,
            message_id: 1,
            text: `${confirmationCard(pending, {ended: true})} · approved`,
          },
        ]);
      },
      {timeout: 5_000},
    );
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('gives up a delivery waiting on a confirmation when the connector stops, and the turn runs on', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const transport = createNodeFetch();
    const deliveries: AbortSignal[] = [];
    const watched: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (
        url.pathname === '/api/turns' &&
        init?.signal instanceof AbortSignal
      ) {
        deliveries.push(init.signal);
      }

      return transport(input, init);
    };

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram, watched);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(alice, 1, 'confirm'));

    const pending = await confirmationOf(gateway);

    await vi.waitFor(() => {
      expect(cardsIn(telegram, miraToken, alice.id)).toHaveLength(1);
    });
    await expect(connector.stop()).resolves.toBe(0);
    expect(deliveries.map(signal => signal.aborted)).toEqual([true]);
    expect(gateway.pendingConfirmations()).toEqual([pending]);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('ends a card whose confirmation was settled while the stream was down, on the ready that comes back without it', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const first = await serve(homeRoot, gateway);

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(miraToken, messageFrom(alice, 1, 'confirm'));

    const pending = await confirmationOf(gateway);

    await vi.waitFor(() => {
      expect(cardsIn(telegram, miraToken, alice.id)).toHaveLength(1);
    });
    await first.close();
    expect(gateway.answerConfirmation(pending.id, 'approved')).toMatchObject({
      status: 'answered',
    });

    const returned = await serve(homeRoot, gateway, {port: first.port});

    await vi.waitFor(
      () => {
        expect(bodiesOf(telegram, miraToken, 'editMessageText')).toEqual([
          {
            chat_id: alice.id,
            message_id: 1,
            text: `${confirmationCard(pending, {ended: true})} · settled while the bot was away`,
          },
        ]);
      },
      {timeout: 5_000},
    );
    await expect(connector.stop()).resolves.toBe(0);
    await returned.close();
    await telegram.close();
    await gateway.stop();
  });

  it('leaves a confirmation the web raised out of her chat, and shows it on the management bot naming the web until the web answers it', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(managementOn);
      expect(connector.stdout()).toContain(miraAnswers);
    });
    // Her bot has her conversation open once it has carried a line there.
    telegram.push(miraToken, messageFrom(alice, 1, 'hello'));
    await vi.waitFor(
      () => {
        expect(textsIn(telegram, miraToken, alice.id)).toContain(
          'noted: hello',
        );
      },
      {timeout: 5_000},
    );

    const ref = await openDirect(gateway, 'mira');
    const turn = gateway.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: 'confirm',
      source: 'web',
      clientMessageId: 'web-confirm',
    });
    const pending = await confirmationOf(gateway);
    const card = confirmationCard(pending, {raisedOn: 'web'});

    await vi.waitFor(() => {
      expect(cardsIn(telegram, homeToken, alice.id)).toEqual([
        {messageId: 1, text: card, keyboard: decisionButtons('c', pending.id)},
      ]);
    });
    expect(gateway.answerConfirmation(pending.id, 'denied')).toEqual({
      status: 'answered',
    });
    await expect(turn).resolves.toMatchObject({status: 'completed'});
    await vi.waitFor(
      () => {
        expect(bodiesOf(telegram, homeToken, 'editMessageText')).toEqual([
          {
            chat_id: alice.id,
            message_id: 1,
            text: `${confirmationCard(pending, {raisedOn: 'web', ended: true})} · denied`,
          },
        ]);
        expect(textsIn(telegram, miraToken, alice.id).at(-1)).toBe('done');
      },
      {timeout: 5_000},
    );
    // The turn's reply came after any card her chat would have had.
    expect(cardsIn(telegram, miraToken, alice.id)).toEqual([]);
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('answers the commands of a paired account on the management bot, and pairs an account from the card it shows', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);

    await gateway.startCharacter('mira');

    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(managementOn);
      expect(connector.stdout()).toContain(miraAnswers);
    });
    telegram.push(homeToken, messageFrom(alice, 1, '/status'));
    await vi.waitFor(() => {
      expect(textsIn(telegram, homeToken, alice.id)).toEqual([
        'Mira: ready\nNova: not started',
      ]);
    });
    telegram.push(miraToken, messageFrom(bob, 1, 'let me in'));

    const request = await pairingOf(gateway, bob);
    const card = pairingCard(request);

    await vi.waitFor(() => {
      expect(cardsIn(telegram, homeToken, alice.id)).toEqual([
        {
          messageId: 2,
          text: card,
          keyboard: decisionButtons('p', request.code),
        },
      ]);
    });

    const press = pressOn(alice, {messageId: 2}, `p:${request.code}:a`);

    telegram.push(homeToken, press);
    await vi.waitFor(() => {
      expect(textsIn(telegram, miraToken, bob.id).at(-1)).toBe(
        'Paired. Mira is listening.',
      );
      expect(bodiesOf(telegram, homeToken, 'answerCallbackQuery')).toEqual([
        {callback_query_id: String(press.update_id), text: 'Approved.'},
      ]);
      expect(bodiesOf(telegram, homeToken, 'editMessageText')).toEqual([
        {
          chat_id: alice.id,
          message_id: 2,
          text: `${pairingCard(request, true)} · approved`,
        },
      ]);
    });
    telegram.push(homeToken, messageFrom(alice, 2, '/pending'));
    telegram.push(homeToken, messageFrom(alice, 3, '/approve 000000'));
    // A code that is not six digits never reaches the daemon's URL path.
    telegram.push(homeToken, messageFrom(alice, 4, '/deny ../health'));
    await vi.waitFor(() => {
      expect(textsIn(telegram, homeToken, alice.id).slice(2)).toEqual([
        `${pairingCard(request, true)} · approved`,
        'Nothing waits for you.',
        'That code is not waiting.',
        'That code is not waiting.',
      ]);
    });
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('holds a card raised while nobody was paired, and shows it on /pending to the first account paired', async () => {
    const {homeRoot, gateway} = await createTelegramHome();
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(managementOn);
    });
    telegram.push(homeToken, messageFrom(bob, 1, 'let me in'));

    const request = await pairingOf(gateway, bob);

    await vi.waitFor(() => {
      expect(textsIn(telegram, homeToken, bob.id)).toHaveLength(1);
    });
    await change(gateway, home, {
      kind: 'section_field_set',
      ...telegramSection,
      field: 'pairedUsers',
      value: aliceIsPaired,
    });
    telegram.push(homeToken, messageFrom(alice, 1, '/pending'));
    await vi.waitFor(() => {
      expect(cardsIn(telegram, homeToken, alice.id)).toEqual([
        {
          messageId: 2,
          text: pairingCard(request),
          keyboard: decisionButtons('p', request.code),
        },
      ]);
    });
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('gives an account it does not know a pairing code on the management bot too', async () => {
    const {homeRoot, gateway} = await createTelegramHome();
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);
    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(() => {
      expect(connector.stdout()).toContain(managementOn);
    });
    telegram.push(homeToken, messageFrom(carol, 1, '/status'));

    const request = await pairingOf(gateway, carol);

    await vi.waitFor(() => {
      expect(textsIn(telegram, homeToken, carol.id)).toEqual([
        `This bot is private. Your pairing code is ${request.code}, good for 60 minutes. Approve it on the web page.`,
      ]);
    });
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });

  it('posts a card for each confirmation and pairing request already waiting when the management bot starts', async () => {
    const {homeRoot, gateway} = await createTelegramHome({
      pairedUsers: aliceIsPaired,
    });
    const telegram = await startTelegram();
    const server = await serve(homeRoot, gateway);

    await gateway.startCharacter('mira');

    const ref = await openDirect(gateway, 'mira');

    // Answered by nobody here: the gateway's stop cancels it.
    void gateway.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: 'confirm',
      source: 'web',
      clientMessageId: 'web-confirm',
    });
    gateway.requestPairing('telegram', {
      id: String(bob.id),
      label: 'Bob (@bob)',
    });

    const pending = await confirmationOf(gateway);
    const request = await pairingOf(gateway, bob);
    const connector = runConnector(homeRoot, telegram);

    await vi.waitFor(
      () => {
        expect(cardsIn(telegram, homeToken, alice.id)).toEqual([
          {
            messageId: 1,
            text: confirmationCard(pending, {raisedOn: 'web'}),
            keyboard: decisionButtons('c', pending.id),
          },
          {
            messageId: 2,
            text: pairingCard(request),
            keyboard: decisionButtons('p', request.code),
          },
        ]);
      },
      {timeout: 5_000},
    );
    await expect(connector.stop()).resolves.toBe(0);
    await server.close();
    await telegram.close();
    await gateway.stop();
  });
});
