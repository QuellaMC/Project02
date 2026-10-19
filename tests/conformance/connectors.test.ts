import {readFileSync, writeFileSync} from 'node:fs';
import {createServer as createHttpServer} from 'node:http';
import {createServer as createTcpServer} from 'node:net';
import {join} from 'node:path';

import {expect, it, onTestFinished} from 'vitest';

import {connector, startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {bearer, exchange} from './harness/http.ts';
import {calling, reply, startModelServer} from './harness/model-server.ts';
import {startRelay} from './harness/relay.ts';
import {servedOnLoopback} from './harness/server.ts';
import {messageFrom, startTelegramServer} from './harness/telegram-server.ts';
import {within} from './harness/wait.ts';
import {saveConfig, wireOf, type Wire} from './harness/wire.ts';

const homeBot = {token: '123456:home', id: 123456, username: 'home_bot'};
const miraBot = {token: '987654:mira', id: 987654, username: 'mira_bot'};
const novaBot = {token: '555555:nova', id: 555555, username: 'nova_bot'};
const replacedBot = {
  token: '987655:replaced',
  id: 987655,
  username: 'mira_new_bot',
};
const alice = {id: 4242, first_name: 'Alice'};
const bob = {id: 5151, first_name: 'Bob', username: 'bob'};
const mira = {scope: 'character', characterId: 'mira'} as const;
const nova = {scope: 'character', characterId: 'nova'} as const;
const miraAnswers = 'Telegram: @mira_bot answers for Mira.';
const settingsRead = '/api/connectors/telegram/config';

/** A settings document's Telegram stanza: these fields, switched as given. */
function telegramSettings(config: object, enabled?: boolean): object {
  return {
    connectors: {
      telegram: {...(enabled === undefined ? {} : {enabled}), config},
    },
  };
}

/** A change to a Telegram field, as a settings screen saves it. */
function setTelegram(field: string, value: unknown): object {
  return {
    kind: 'section_field_set',
    namespace: 'connectors',
    id: 'telegram',
    field,
    value,
  };
}

function unsetTelegram(field: string): object {
  return {
    kind: 'section_field_unset',
    namespace: 'connectors',
    id: 'telegram',
    field,
  };
}

/** The model asking to set Mira's tone, against the fingerprint her settings hand out now: a call that waits for a confirmation. */
async function asksForTone(wire: Wire, tone: string) {
  const view = (await wire.configView(mira)) as {readonly fingerprint: string};

  return calling([
    'runtime_plugin_config_update',
    {
      pluginId: 'demo-config',
      fieldName: 'tone',
      operation: 'set',
      value: tone,
      expectedFingerprint: view.fingerprint,
    },
  ]);
}

/** Another program on the port until the test ends, one that drops every connection it takes. */
async function holdPort(port: number): Promise<void> {
  const holder = createTcpServer(socket => {
    socket.destroy();
  });

  onTestFinished(
    () =>
      new Promise<void>(resolve => {
        holder.close(() => {
          resolve();
        });
      }),
  );
  await within(
    `another program to take port ${String(port)}`,
    new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.listen(port, '127.0.0.1', resolve);
    }),
  );
}

it('connectors.telegram-process-lifecycle: beside serve, the connector says it is connected to the address, starts a bot for each token, each asking Telegram who it is and then polling, and on SIGINT exits 0 with nothing on stderr', async () => {
  const home = createHome({
    'config.json': configJson(
      telegramSettings({managementBotToken: homeBot.token}),
    ),
    'character-data': {
      mira: {
        'config.json': configJson(telegramSettings({botToken: miraBot.token})),
      },
    },
  });
  const daemon = await startDaemon(home);
  const telegram = await startTelegramServer([homeBot, miraBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printed(`Telegram connector: connected to ${daemon.origin}.`);
  await run.printed('Telegram: management bot @home_bot is on.');
  await run.printed(miraAnswers);

  for (const {token} of [homeBot, miraBot]) {
    expect(
      await telegram.called(token, calls =>
        calls.length >= 2 ? calls.map(call => call.method) : undefined,
      ),
    ).toEqual(['getMe', 'getUpdates']);
  }

  run.signal('SIGINT');
  expect(await run.exit()).toBe(0);
  expect(run.stderr()).toBe('');
});

it("connectors.telegram-discovery: the connector finds the daemon by its home's daemon.json: it says it waits for a record not written yet and connects once it is, follows the daemon to the port it moved to keeping its bots, and says once that the daemon refused the record's token, connecting once the record holds the daemon's", async () => {
  const home = createHome({
    'character-data': {
      mira: {
        'config.json': configJson(telegramSettings({botToken: miraBot.token})),
      },
    },
  });
  const telegram = await startTelegramServer([miraBot]);
  const waiting = `Telegram connector: waiting for the daemon on ${home}; run pnpm serve.`;
  const run = connector(['--store', home], telegram.env);

  await run.printed(waiting);

  const first = await startDaemon(home);
  const connected = `Telegram connector: connected to ${first.origin}.`;

  await run.printed(connected);
  await run.printed(miraAnswers);
  expect(run.stdout().split('\n').slice(0, 2)).toEqual([waiting, connected]);

  first.signal('SIGINT');
  await first.exit();
  await holdPort(Number(new URL(first.origin).port));

  const moved = await startDaemon(home);

  await run.printed(`Telegram connector: connected to ${moved.origin}.`);
  // Answered by the bot that asked Telegram who it is once: kept, not
  // started again.
  telegram.push(miraBot.token, messageFrom(bob, 1, 'Hello?'));
  await telegram.called(miraBot.token, calls =>
    calls.find(call => call.body['chat_id'] === bob.id),
  );
  expect(telegram.calls(miraBot.token, 'getMe')).toHaveLength(1);
  expect(run.stdout()).not.toContain('Telegram: stopped');
  run.signal('SIGINT');
  expect(await run.exit()).toBe(0);

  const relay = await startRelay(home);
  const record = join(relay.home, 'daemon.json');
  const kept = readFileSync(record, 'utf8');
  const refused = `Telegram connector: the daemon at ${relay.origin} refused the token in ${record}; trying again.`;

  writeFileSync(
    record,
    JSON.stringify({...(JSON.parse(kept) as object), token: 'not-its-token'}),
  );

  const refusedOnce = connector(['--store', relay.home], telegram.env);

  await refusedOnce.printedOnStderr(refused);
  // Asked again under the same token, and refused again.
  await relay.reached(requests =>
    requests.filter(request => request.path.startsWith('/api/events')).length >=
    2
      ? true
      : undefined,
  );
  writeFileSync(record, kept);
  await refusedOnce.printed(
    `Telegram connector: connected to ${relay.origin}.`,
  );
  expect(refusedOnce.stderr()).toBe(`${refused}\n`);
});

it("connectors.telegram-test-switches: the connector refuses to start, with exit 1, nothing on stdout and the reason on stderr, on a durations key other than edit, serve's among them, or a Bot API address that is not an absolute http or https one free of credentials, a query and a fragment", async () => {
  const home = createHome();
  const address =
    'PROJECT02_TEST_TELEGRAM_API must be an absolute http:// or https:// address with no embedded credentials, query, or fragment.';
  const refusals = [
    [
      {PROJECT02_TEST_DURATIONS: 'grace=100'},
      'PROJECT02_TEST_DURATIONS: unknown key "grace"; the keys here are edit.',
    ],
    [
      {PROJECT02_TEST_DURATIONS: 'edit=100,pairing=500'},
      'PROJECT02_TEST_DURATIONS: unknown key "pairing"; the keys here are edit.',
    ],
    [{PROJECT02_TEST_TELEGRAM_API: 'ftp://127.0.0.1:1'}, address],
    [{PROJECT02_TEST_TELEGRAM_API: 'http://me:secret@127.0.0.1:1'}, address],
    [{PROJECT02_TEST_TELEGRAM_API: 'http://127.0.0.1:1/?key=value'}, address],
    [{PROJECT02_TEST_TELEGRAM_API: 'http://127.0.0.1:1/#part'}, address],
    [{PROJECT02_TEST_TELEGRAM_API: 'api.telegram.org'}, address],
  ] as const;
  const runs = refusals.map(([env, reason]) => ({
    reason,
    run: connector(['--store', home], env),
  }));

  for (const {reason, run} of runs) {
    expect(await run.exit(), reason).toBe(1);
    expect(run.stdout(), reason).toBe('');
    expect(run.stderr(), reason).toBe(`${reason}\n`);
  }
});

it('connectors.telegram-protocol-mismatch: a daemon that speaks another protocol ends the connector with exit 1, saying both versions', async () => {
  const older = createHttpServer((_request, response) => {
    response
      .writeHead(200, {'content-type': 'text/event-stream'})
      .end('event: ready\ndata: {"protocolVersion":6}\n\n');
  });
  const port = await servedOnLoopback(older);
  const home = createHome({
    'daemon.json': JSON.stringify({protocolVersion: 6, token: 'older', port}),
  });
  const telegram = await startTelegramServer();
  const run = connector(['--store', home], telegram.env);

  expect(await run.exit()).toBe(1);
  expect(run.stderr()).toBe(
    'The daemon speaks protocol 6; this client speaks 7. Update one of them.\n',
  );
});

it("connectors.telegram-bot-table: the connector runs one bot per token, the home's management bot and each character's, polls a token two characters share once while saying whose bot is not started, stops a bot whose token is cleared, starts one afresh for the character its token moved to, and says when no token is set", async () => {
  const home = createHome({
    'config.json': configJson(
      telegramSettings({managementBotToken: homeBot.token}),
    ),
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
    'character-data': {
      mira: {
        'config.json': configJson(telegramSettings({botToken: miraBot.token})),
      },
      nova: {
        'config.json': configJson(telegramSettings({botToken: miraBot.token})),
      },
    },
  });
  const wire = wireOf(await startDaemon(home));
  const telegram = await startTelegramServer([homeBot, miraBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printed('Telegram: management bot @home_bot is on.');
  await run.printed(miraAnswers);
  await run.printedOnStderr(
    "Nova's bot token is also Mira's; Nova's bot is not started.",
  );

  await saveConfig(wire, mira, unsetTelegram('botToken'));
  await run.printed('Telegram: stopped @mira_bot (Mira).');
  await run.printed('Telegram: @mira_bot answers for Nova.');
  // Once for each owner: the shared token never had a second bot.
  expect(telegram.calls(miraBot.token, 'getMe')).toHaveLength(2);

  await saveConfig(
    wire,
    {scope: 'global'},
    unsetTelegram('managementBotToken'),
  );
  await saveConfig(wire, nova, unsetTelegram('botToken'));
  await run.printed('Telegram: stopped @home_bot (the management bot).');
  await run.printed('Telegram: stopped @mira_bot (Nova).');
  await run.printed(
    'Telegram is off, or no token is set; waiting for a change.',
  );

  const before = [homeBot, miraBot].map(
    ({token}) => telegram.calls(token).length,
  );

  run.signal('SIGINT');
  expect(await run.exit()).toBe(0);
  // Nothing more was asked on either token once its bot stopped.
  expect(
    [homeBot, miraBot].map(({token}) => telegram.calls(token).length),
  ).toEqual(before);
});

it("connectors.telegram-switches: switching the home's Telegram section off stops the bots that follow the home's switch, and not a character's switched on on her own screen, who still answers", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: model.settings,
      ...telegramSettings({
        managementBotToken: homeBot.token,
        pairedUsers: {[String(alice.id)]: 'Alice'},
      }),
    }),
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
    'character-data': {
      mira: {
        'config.json': configJson(
          telegramSettings({botToken: miraBot.token}, true),
        ),
      },
      nova: {
        'config.json': configJson(telegramSettings({botToken: novaBot.token})),
      },
    },
  });
  const wire = wireOf(await startDaemon(home));
  const telegram = await startTelegramServer([homeBot, miraBot, novaBot]);
  const run = connector(['--store', home], telegram.env);

  await run.printed('Telegram: management bot @home_bot is on.');
  await run.printed(miraAnswers);
  await run.printed('Telegram: @nova_bot answers for Nova.');
  await saveConfig(
    wire,
    {scope: 'global'},
    {
      kind: 'section_enabled',
      namespace: 'connectors',
      id: 'telegram',
      enabled: false,
    },
  );
  await run.printed('Telegram: stopped @home_bot (the management bot).');
  await run.printed('Telegram: stopped @nova_bot (Nova).');

  model.answer(reply('Still here.'));
  telegram.push(miraBot.token, messageFrom(alice, 1, 'Still there?'));
  await telegram.shows(miraBot.token, alice.id, 'Still here.');
  expect(telegram.calls(miraBot.token, 'getMe')).toHaveLength(1);
  expect(run.stdout()).not.toContain('Telegram: stopped @mira_bot');
});

it('connectors.telegram-config-reads: the connector reads its settings on every ready and every change, tries a failed read again saying so on stderr, applies only the newest answer, and reads once on a stream the daemon resumed', async () => {
  const home = createHome({
    'character-data': {
      mira: {
        'config.json': configJson(telegramSettings({botToken: miraBot.token})),
      },
    },
  });
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);

  // Another of the connector's processes, on the stream throughout: this
  // one leaving and coming back changes nothing in health.
  await exchange(daemon, {
    path: '/api/events?connector=telegram',
    headers: bearer(daemon),
  });

  const relay = await startRelay(home);
  const telegram = await startTelegramServer([miraBot, replacedBot, novaBot]);
  const reads = () =>
    relay.requests.filter(request => request.path === settingsRead).length;

  relay.refuse(settingsRead, 503);

  const stale = relay.hold(settingsRead);
  const run = connector(['--store', relay.home], telegram.env);

  await run.printedOnStderr(
    "Telegram connector: the daemon's Telegram settings could not be read (The daemon answered 503.); trying again.",
  );
  // Tried again: answered with Mira's first token, and held there.
  await stale.answered();
  await saveConfig(wire, mira, setTelegram('botToken', replacedBot.token));
  await run.printed('Telegram: @mira_new_bot answers for Mira.');
  // The older answer lands after the newer one: that it was never applied
  // is known once the connector has stopped.
  stale.release();
  await saveConfig(wire, mira, setTelegram('botToken', novaBot.token));
  await run.printed('Telegram: @nova_bot answers for Mira.');
  expect(reads()).toBe(4);

  const cut = relay.requests.length;

  relay.away();
  await run.printed(
    `Telegram connector: waiting for the daemon on ${relay.home}; run pnpm serve.`,
  );
  relay.back();
  await relay.reached(requests =>
    requests.filter(request => request.path === settingsRead).length === 5
      ? true
      : undefined,
  );

  // Resumed: the daemon still holds where the connector left the stream.
  const returned = relay.requests
    .slice(cut)
    .find(request => request.path.startsWith('/api/events'));

  expect(
    (
      await (
        await openEvents(daemon, String(returned?.headers['last-event-id']))
      ).next(() => true)
    ).event,
  ).toBe('resumed');
  // The next read is the next change's.
  await saveConfig(wire, mira, unsetTelegram('botToken'));
  await run.printed('Telegram: stopped @nova_bot (Mira).');
  expect(reads()).toBe(6);
  run.signal('SIGINT');
  expect(await run.exit()).toBe(0);
  // Stopped, it takes in nothing more: Mira's first token was never polled.
  expect(telegram.calls(miraBot.token)).toEqual([]);
});

it('connectors.telegram-stop: a stopped connector gives up the delivery whose turn waits on a confirmation and the pairing request still waiting on its answer, stops every bot and exits 0, while the turn runs on in the daemon with its confirmation pending', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: model.settings,
      plugins: {'demo-config': {enabled: true}},
      ...telegramSettings({pairedUsers: {[String(alice.id)]: 'Alice'}}),
    }),
    'character-data': {
      mira: {
        'config.json': configJson(telegramSettings({botToken: miraBot.token})),
      },
    },
  });
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const relay = await startRelay(home);
  const telegram = await startTelegramServer([miraBot]);
  const delivery = relay.hold('/api/turns');
  const pairing = relay.hold('/api/connectors/telegram/pairing');
  const run = connector(['--store', relay.home], telegram.env);

  await run.printed(miraAnswers);
  model.answer(await asksForTone(wire, 'pirate'));
  telegram.push(miraBot.token, messageFrom(alice, 1, 'Talk like a pirate.'));
  await delivery.arrived();

  const {id} = JSON.parse(
    (await events.next(frameOf('confirmation_requested'))).data ?? '',
  ) as {readonly id: string};

  telegram.push(miraBot.token, messageFrom(bob, 1, 'Let me in.'));
  await pairing.answered();
  run.signal('SIGINT');
  expect(await run.exit()).toBe(0);
  await delivery.abandoned();
  await pairing.abandoned();
  expect(run.stdout()).toContain('Telegram: stopped @mira_bot (Mira).\n');
  expect(await wire.pending()).toMatchObject([{id}]);

  model.answer(reply('Arr.'));
  await wire.answer(id, 'approved');
  await events.next(
    frameOf('turn_completed', {
      source: 'telegram:mira_bot',
      status: 'completed',
    }),
  );
});
